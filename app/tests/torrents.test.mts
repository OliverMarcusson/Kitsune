import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebTorrent, { type Torrent } from 'webtorrent'
import { Torrents, isTorrentSource } from '../src/main/torrents'

const destroy = (client: WebTorrent): Promise<void> => new Promise((resolve, reject) => client.destroy(error => error ? reject(error) : resolve()))

test('magnet metadata is parsed without opening any peer connections', async () => {
  let created = false
  const engine = new Torrents(async () => { created = true; return new WebTorrent() })
  const meta = await engine.metadata('magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Ubuntu.iso')
  assert.equal(meta.filename, 'Ubuntu.iso')
  assert.equal(meta.kind, 'torrent')
  assert.equal(created, false)
  assert.equal(isTorrentSource('https://example.test/linux.torrent?token=x'), true)
  await assert.rejects(engine.metadata('magnet:?dn=broken'))
})

test('local torrent pauses, verifies existing pieces on resume, and deletes only its own files', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kitsune-torrent-test-'))
  const source = Buffer.alloc(2 * 1024 * 1024, 67)
  const seeder = new WebTorrent({ utp: false, dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false })
  const client = new WebTorrent({ utp: false, dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false })
  seeder.on('error', error => assert.fail(String(error)))
  const engine = new Torrents(async () => client)
  try {
    const seeded = await new Promise<Torrent>(resolve => seeder.seed(source, { name: 'fixture.bin', announce: [], path: join(root, 'seed') }, resolve))
    const address = seeder.address()
    assert.ok(address && typeof address !== 'string')
    const file = join(root, 'fixture.torrent')
    await writeFile(file, seeded.torrentFile)
    const meta = await engine.metadata(file)
    assert.equal(meta.size, source.length)
    const destination = join(root, 'download')
    const options = { downloadId: 'fixture', url: file, path: destination, connections: 8, kind: 'torrent' as const }
    client.on('torrent', torrent => torrent.addPeer(`127.0.0.1:${address.port}`))
    engine.setRate(256 * 1024)
    const progress = once(engine, 'download-progress', { signal: AbortSignal.timeout(10000) })
    await engine.startDownload(options)
    const [payload] = await progress
    assert.ok(payload.bytesDownloaded > 0 && payload.bytesDownloaded < source.length)
    await engine.cancelDownload('fixture')
    assert.equal(client.torrents.length, 0, 'pause must close every peer socket')
    engine.setRate(0)
    const started = once(engine, 'download-started', { signal: AbortSignal.timeout(10000) })
    const completed = once(engine, 'download-completed', { signal: AbortSignal.timeout(10000) })
    await engine.startDownload(options)
    const [resumed] = await started
    assert.ok(resumed.downloadedBytes > 0, 'resume should reuse verified pieces')
    await completed
    assert.equal((await readFile(join(destination, 'fixture.bin'))).equals(source), true)
    assert.equal(client.torrents.length, 0, 'finished torrent must close its peer sockets')
    await writeFile(join(destination, 'keep.txt'), 'user work')
    await engine.deleteFiles(options)
    assert.deepEqual(await readdir(destination), ['keep.txt'])
    assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'user work')
  } finally {
    await engine.stop()
    await destroy(seeder)
    await rm(root, { recursive: true, force: true })
  }
})

test('torrent destination rejects unrelated existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kitsune-torrent-owned-'))
  const engine = new Torrents()
  try {
    await writeFile(join(root, 'keep.txt'), 'user work')
    await assert.rejects(engine.startDownload({ downloadId: 'new', url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789', path: root, connections: 8, kind: 'torrent' }), /empty folder/)
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'user work')
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }) }
})
