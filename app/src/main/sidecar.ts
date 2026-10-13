import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { createInterface, type Interface } from 'node:readline'

/** A reply from the daemon: exactly one of `ok` / `error` is present. */
interface Reply {
  id: string
  ok?: unknown
  error?: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

const BIN = process.platform === 'win32' ? 'kitsune-daemon.exe' : 'kitsune-daemon'

/**
 * Owns the kitsune-daemon child process and the newline-delimited JSON protocol
 * spoken over its stdio.
 *
 * Emits the daemon's unsolicited events by name: `download-progress`,
 * `download-completed`, `download-error`, `download-paused`.
 */
export class Sidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private pending = new Map<string, Pending>()
  private nextId = 0
  private stopping = false
  private running = new Set<string>()

  /**
   * Packaged builds ship the binary in `resources/`. In development we hunt for
   * the cargo output instead.
   *
   * `app.getAppPath()` is not a fixed anchor: it is the app directory under
   * `electron-vite dev` but the *script's* directory when main is launched
   * directly (`electron out/main/index.js`). Rather than guess, walk upwards
   * looking for `target/release/<bin>`.
   */
  private candidatePaths(): string[] {
    const candidates: string[] = []

    const override = process.env.KITSUNE_DAEMON_PATH
    if (override) candidates.push(override)

    candidates.push(join(process.resourcesPath, BIN))

    for (const base of [app.getAppPath(), process.cwd()]) {
      let dir = base
      for (let depth = 0; depth < 5; depth++) {
        candidates.push(join(dir, 'target', 'release', BIN))
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }

    return candidates
  }

  private resolveBinary(): string {
    const candidates = this.candidatePaths()
    const found = candidates.find((p) => existsSync(p))
    if (found) return found

    throw new Error(
      `kitsune-daemon not found. Run \`cargo build --release -p kitsune-daemon\`.\n` +
        `Looked in:\n${candidates.map((p) => `  ${p}`).join('\n')}`
    )
  }

  start(): void {
    if (this.child) return
    this.stopping = false

    const bin = this.resolveBinary()
    console.log('[kitsune-daemon] starting', bin)

    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.onLine(line))

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd()
      if (text) console.error('[kitsune-daemon]', text)
    })

    child.on('exit', (code, signal) => {
      // Fail every in-flight request rather than leaving callers hanging.
      const reason = new Error(`kitsune-daemon exited (code=${code} signal=${signal})`)
      for (const { reject } of this.pending.values()) reject(reason)
      this.pending.clear()
      for (const downloadId of this.running) this.emit('download-error', { downloadId, error: reason.message })
      this.running.clear()

      this.child = null
      this.reader?.close()
      this.reader = null

      if (!this.stopping) {
        console.error('[kitsune-daemon] exited unexpectedly, restarting in 1s')
        setTimeout(() => {
          if (!this.stopping) this.start()
        }, 1000)
      }
    })
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: Reply & { event?: string }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      console.error('[kitsune-daemon] non-JSON on stdout:', trimmed)
      return
    }

    if (msg.event) {
      if (['download-paused', 'download-completed', 'download-error'].includes(msg.event)) {
        this.running.delete((msg as unknown as { downloadId: string }).downloadId)
      }
      this.emit(msg.event, msg)
      return
    }

    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)

    if (msg.error !== undefined) pending.reject(new Error(msg.error))
    else pending.resolve(msg.ok)
  }

  private request<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('kitsune-daemon is not running'))

    const id = String(++this.nextId)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  getMetadata(url: string): Promise<{ filename: string; size: number; url: string }> {
    return this.request('get_metadata', { url })
  }

  startDownload(opts: {
    downloadId: string
    url: string
    path: string
    connections: number
  }): Promise<void> {
    this.running.add(opts.downloadId)
    return this.request<void>('start_download', {
      download_id: opts.downloadId,
      url: opts.url,
      path: opts.path,
      connections: opts.connections
    }).catch(error => { this.running.delete(opts.downloadId); throw error })
  }

  cancelDownload(downloadId: string): Promise<void> {
    return this.request('cancel_download', { download_id: downloadId })
  }

  setRate(bytesPerSecond: number): Promise<void> {
    return this.request('set_rate', { bytes_per_second: bytesPerSecond })
  }

  replaceUrl(path: string, url: string): Promise<void> {
    return this.request('replace_url', { path, url })
  }

  stop(): void {
    this.stopping = true
    // Closing stdin is the daemon's shutdown signal; it drains and exits 0.
    this.child?.stdin.end()
    this.child = null
  }
}
