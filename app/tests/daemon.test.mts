import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = resolve('../target/debug/kitsune-daemon')
test('daemon acknowledges, pauses, repairs, and completes a resumed download', { timeout: 15000, skip: !existsSync(binary) && 'Run cargo build -p kitsune-daemon first' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kitsune-daemon-test-'))
  const bytes = Buffer.alloc(1024 * 1024, 83)
  const server = createServer((request, response) => {
    const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range || '')
    const start = Number(range?.[1] || 0), end = Number(range?.[2] || bytes.length - 1)
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: '"test-v1"' })
    response.end(bytes.subarray(start, end + 1))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/file`
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const messages: Record<string, unknown>[] = []
  lines.on('line', line => messages.push(JSON.parse(line)))
  let next = 0
  const waitFor = async (predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 500; i++) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('daemon response timed out')
  }
  const command = async (cmd: string, payload: Record<string, unknown> = {}): Promise<void> => {
    const id = String(++next)
    child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`)
    const reply = await waitFor(message => message.id === id)
    assert.equal(reply.error, undefined)
  }
  try {
    const path = join(root, 'file')
    await command('set_rate', { bytes_per_second: 128 * 1024 })
    await command('start_download', { download_id: 'test', url, path, connections: 4 })
    await waitFor(message => message.event === 'download-progress' && Number(message.bytesDownloaded) > 0)
    await command('cancel_download', { download_id: 'test' })
    await waitFor(message => message.event === 'download-paused')
    const saved = JSON.parse(await readFile(`${path}.kitsune`, 'utf8'))
    assert.equal(saved.etag, '"test-v1"')
    await command('replace_url', { path, url: `${url}?fresh=1` })
    assert.equal(JSON.parse(await readFile(`${path}.kitsune`, 'utf8')).url, `${url}?fresh=1`)
    await command('set_rate', { bytes_per_second: 0 })
    await command('start_download', { download_id: 'test', url: `${url}?fresh=1`, path, connections: 4 })
    await waitFor(message => message.event === 'download-completed')
    assert.equal((await readFile(path)).equals(bytes), true)
    assert.equal(existsSync(`${path}.kitsune`), false)
    const exited = once(child, 'exit')
    child.stdin.end()
    const [code] = await exited
    assert.equal(code, 0)
  } finally {
    child.kill()
    lines.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
