import { EventEmitter } from 'node:events'
import type { PersistedDownload, StartDownloadOptions, TransferSettings } from '../shared/ipc'
import { DEFAULT_TRANSFERS, effectiveRate, scheduleAllows, validateTransfers } from '../shared/transfer-policy'

export interface Engine extends EventEmitter {
  startDownload(opts: StartDownloadOptions): Promise<void>
  cancelDownload(id: string): Promise<void>
  setRate(rate: number): Promise<void> | void
}

type Entry = {
  opts: StartDownloadOptions
  status: string
  pauseTo?: 'paused' | 'queued'
  launch?: Promise<void>
  pausing?: Promise<void>
}

/** Owns queue and schedule independently of renderer visibility or React state. */
export class Transfers extends EventEmitter {
  private entries = new Map<string, Entry>()
  private settings: TransferSettings = structuredClone(DEFAULT_TRANSFERS)
  private timer: ReturnType<typeof setInterval>
  private reconciling = false
  private again = false
  private stopping = false

  constructor(private http: Engine, private torrent: Engine, private now: () => Date = () => new Date()) {
    super()
    for (const engine of [http, torrent]) {
      for (const event of ['download-progress', 'download-started', 'download-paused', 'download-completed', 'download-error']) {
        engine.on(event, payload => this.observe(event, payload))
      }
    }
    this.timer = setInterval(() => void this.reconcile(), 1000)
    this.timer.unref()
  }

  configure(value: TransferSettings): void {
    this.settings = validateTransfers(value)
    void this.reconcile()
  }

  restore(downloads: PersistedDownload[]): void {
    for (const download of downloads) {
      if (this.entries.has(download.id)) continue
      this.entries.set(download.id, {
        opts: { downloadId: download.id, url: download.url, path: download.path, connections: download.connections, kind: download.kind },
        status: download.status === 'downloading' ? 'paused' : download.status
      })
    }
    void this.reconcile()
  }

  async start(opts: StartDownloadOptions): Promise<void> {
    const existing = this.entries.get(opts.downloadId)
    if (existing?.status === 'downloading' || existing?.pauseTo) throw new Error('Download is already running or pausing')
    const entry: Entry = { opts, status: 'queued' }
    this.entries.set(opts.downloadId, entry)
    this.setState(entry, 'queued')
    await this.reconcile()
  }

  private engine(entry: Entry): Engine { return entry.opts.kind === 'torrent' ? this.torrent : this.http }

  private setState(entry: Entry, status: 'queued' | 'downloading' | 'paused'): void {
    entry.status = status
    this.emit('download-state', { downloadId: entry.opts.downloadId, status })
  }

  private observe(event: string, payload: { downloadId: string }): void {
    const entry = this.entries.get(payload.downloadId)
    if (entry) {
      if (event === 'download-paused') {
        const status = entry.pauseTo || 'paused'
        entry.pauseTo = undefined
        this.setState(entry, status)
      } else {
        if (event === 'download-completed') entry.status = 'completed'
        if (event === 'download-error') { entry.status = 'error'; entry.pauseTo = undefined }
        this.emit(event, payload)
      }
      if (['download-paused', 'download-completed', 'download-error'].includes(event)) void this.reconcile()
    }
  }

  async pause(id: string, status: 'paused' | 'queued' = 'paused'): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.pausing) {
      if (status === 'paused') entry.pauseTo = status
      await entry.pausing
      return
    }
    entry.pausing = this.pauseEntry(id, status)
    try { await entry.pausing } finally { entry.pausing = undefined }
  }

  private async pauseEntry(id: string, status: 'paused' | 'queued'): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.pauseTo) {
      // A manual pause overrides an in-flight automatic schedule pause.
      if (status === 'paused') entry.pauseTo = status
      return
    }
    if (entry.status !== 'downloading') { this.setState(entry, status); return }
    entry.pauseTo = status
    await entry.launch
    if (entry.status !== 'downloading') { entry.pauseTo = undefined; return }
    await new Promise<void>((resolve, reject) => {
      const finish = (payload: { downloadId: string }): void => {
        if (payload.downloadId !== id) return
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        for (const event of ['download-paused', 'download-completed', 'download-error']) this.engine(entry).off(event, finish)
      }
      for (const event of ['download-paused', 'download-completed', 'download-error']) this.engine(entry).on(event, finish)
      void this.engine(entry).cancelDownload(id).catch(error => { cleanup(); entry.pauseTo = undefined; reject(error) })
    })
  }

  async forget(id: string): Promise<void> {
    await this.pause(id)
    this.entries.delete(id)
  }

  async replaceUrl(id: string, url: string, replace: (path: string, url: string) => Promise<void>): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.opts.kind === 'torrent') throw new Error('Choose a direct download')
    await this.pause(id)
    await replace(entry.opts.path, url)
    entry.opts.url = url
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) { this.again = true; return }
    this.reconciling = true
    try {
      do {
        this.again = false
        const allowed = !this.stopping && scheduleAllows(this.settings, this.now())
        if (!allowed) {
          await Promise.all([...this.entries.values()].filter(e => e.status === 'downloading').map(e => this.pause(e.opts.downloadId, 'queued')))
        }
        if (allowed) {
          const excess = [...this.entries.values()].filter(e => e.status === 'downloading').slice(this.settings.maxActive)
          await Promise.all(excess.map(e => this.pause(e.opts.downloadId, 'queued')))
        }
        let active = [...this.entries.values()].filter(e => e.status === 'downloading').length
        if (allowed) {
          for (const entry of this.entries.values()) {
            if (active >= this.settings.maxActive) break
            if (entry.status !== 'queued') continue
            active++
            this.setState(entry, 'downloading')
            entry.launch = (async () => {
              await this.updateRates()
              await this.engine(entry).startDownload(entry.opts)
            })().catch(error => {
              this.observe('download-error', { downloadId: entry.opts.downloadId, error: (error as Error).message } as { downloadId: string })
            })
            await entry.launch
          }
        }
        await this.updateRates()
      } while (this.again)
    } catch (error) {
      this.emit('transfer-error', error)
    } finally { this.reconciling = false }
  }

  private async updateRates(): Promise<void> {
    const active = [...this.entries.values()].filter(e => e.status === 'downloading')
    const http = active.filter(e => e.opts.kind !== 'torrent').length
    const torrents = active.length - http
    const rate = effectiveRate(this.settings)
    // Partition the total budget between the two engines; each shares its budget
    // globally across its own transfers. Their sum never exceeds the chosen cap.
    const httpRate = rate && http && torrents ? Math.max(1, Math.floor(rate * http / active.length)) : rate
    const torrentRate = rate && http && torrents ? Math.max(1, rate - httpRate) : rate
    await this.http.setRate(httpRate)
    await this.torrent.setRate(torrentRate)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.stopping = true
    await Promise.all([...this.entries.values()].filter(e => e.status === 'downloading').map(e => this.pause(e.opts.downloadId, 'paused')))
  }
}
