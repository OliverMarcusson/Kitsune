import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Transfers, type Engine } from '../src/main/transfers'
import { DEFAULT_TRANSFERS, effectiveRate, scheduleAllows, validateTransfers } from '../src/shared/transfer-policy'
import type { StartDownloadOptions, TransferSettings } from '../src/shared/ipc'

class MockEngine extends EventEmitter implements Engine {
  started: string[] = []
  rates: number[] = []
  active = new Set<string>()
  async startDownload(opts: StartDownloadOptions): Promise<void> { this.started.push(opts.downloadId); this.active.add(opts.downloadId) }
  async cancelDownload(id: string): Promise<void> { this.active.delete(id); this.emit('download-paused', { downloadId: id }) }
  async setRate(rate: number): Promise<void> { this.rates.push(rate) }
  complete(id: string): void { this.active.delete(id); this.emit('download-completed', { downloadId: id }) }
}
const options = (id: string, kind: 'http' | 'torrent' = 'http'): StartDownloadOptions => ({ downloadId: id, url: 'https://example.test/file', path: `/tmp/${id}`, connections: 8, kind })
const settings = (patch: Partial<TransferSettings> = {}): TransferSettings => ({ ...structuredClone(DEFAULT_TRANSFERS), ...patch })
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.ok(check(), 'condition did not become true')
}

test('overnight schedule uses start day and includes the last morning after end date', () => {
  const config = settings({ schedule: { enabled: true, start: '23:00', stop: '07:00', days: [1], endDate: '2026-10-12' } })
  assert.equal(scheduleAllows(config, new Date(2026, 9, 12, 23, 30)), true)
  assert.equal(scheduleAllows(config, new Date(2026, 9, 13, 6, 59)), true)
  assert.equal(scheduleAllows(config, new Date(2026, 9, 13, 7, 0)), false)
  assert.equal(scheduleAllows(config, new Date(2026, 9, 13, 23, 30)), false)
  assert.equal(scheduleAllows(config, new Date(2026, 9, 19, 23, 30)), false)
})

test('invalid policies are rejected and slow mode overrides the ordinary limit', () => {
  assert.throws(() => validateTransfers(settings({ speedLimit: -1 })))
  assert.throws(() => validateTransfers(settings({ slowSpeed: 0 })))
  assert.throws(() => validateTransfers(settings({ maxActive: 0 })))
  assert.throws(() => validateTransfers(settings({ schedule: { ...DEFAULT_TRANSFERS.schedule, enabled: true, days: [] } })))
  assert.equal(effectiveRate(settings({ speedLimit: 1000, slowMode: true, slowSpeed: 100 })), 100)
})

test('completion drains the queue and manually paused work stays paused', async () => {
  const http = new MockEngine(), torrent = new MockEngine()
  const transfers = new Transfers(http, torrent)
  try {
    transfers.configure(settings({ maxActive: 1 }))
    await transfers.start(options('one'))
    await transfers.start(options('two'))
    await transfers.start(options('three'))
    await until(() => http.started.length === 1)
    await transfers.pause('two')
    http.complete('one')
    await until(() => http.started.includes('three'))
    assert.deepEqual(http.started, ['one', 'three'])
  } finally { await transfers.stop() }
})

test('schedule closes both engines, reopens queued work, and preserves manual pause', async () => {
  let clock = new Date(2026, 9, 13, 1)
  const http = new MockEngine(), torrent = new MockEngine()
  const transfers = new Transfers(http, torrent, () => clock)
  try {
    transfers.configure(settings({ schedule: { ...DEFAULT_TRANSFERS.schedule, enabled: true } }))
    await transfers.start(options('http'))
    await transfers.start(options('torrent', 'torrent'))
    await transfers.start(options('manual'))
    await until(() => http.active.size === 2 && torrent.active.size === 1)
    await transfers.pause('manual')
    clock = new Date(2026, 9, 13, 8)
    await transfers.reconcile()
    await until(() => http.active.size === 0 && torrent.active.size === 0)
    clock = new Date(2026, 9, 14, 1)
    await transfers.reconcile()
    await until(() => http.active.has('http') && torrent.active.has('torrent'))
    assert.equal(http.active.has('manual'), false)
  } finally { await transfers.stop() }
})

test('queued transfers survive restore and share one speed budget across engines', async () => {
  const http = new MockEngine(), torrent = new MockEngine()
  const transfers = new Transfers(http, torrent)
  try {
    transfers.configure(settings({ speedLimit: 1000 }))
    transfers.restore([{ id: 'saved', url: 'https://example.test/file', filename: 'file', path: '/tmp/saved', total_size: 100, downloaded_bytes: 0, status: 'queued', connections: 8, started_at: 0 }])
    await transfers.start(options('torrent', 'torrent'))
    await until(() => http.active.has('saved') && torrent.active.size === 1)
    await transfers.reconcile()
    await until(() => http.rates.at(-1) === 500 && torrent.rates.at(-1) === 500)
    transfers.configure(settings({ speedLimit: 1000, slowMode: true, slowSpeed: 100 }))
    await until(() => http.rates.at(-1) === 50 && torrent.rates.at(-1) === 50)
  } finally { await transfers.stop() }
})

test('pause waits for a launch in progress before stopping its engine', async () => {
  const http = new MockEngine(), torrent = new MockEngine()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  http.startDownload = async opts => { await gate; http.active.add(opts.downloadId) }
  const transfers = new Transfers(http, torrent)
  try {
    const starting = transfers.start(options('slow-launch'))
    await new Promise(resolve => setTimeout(resolve, 10))
    const pause = transfers.pause('slow-launch')
    const forget = transfers.forget('slow-launch')
    release()
    await Promise.all([starting, pause, forget])
    assert.equal(http.active.size, 0)
  } finally { await transfers.stop() }
})
