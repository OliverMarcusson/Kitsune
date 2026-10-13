import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import type WebTorrent from 'webtorrent'
import type { Torrent } from 'webtorrent'
import type { Metadata, StartDownloadOptions } from '../shared/ipc'

const MANIFEST = '.kitsune-torrent.json'
type Client = WebTorrent

function ownedPath(root: string, path: string): string {
  const full = resolve(root, path)
  const child = relative(resolve(root), full)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Torrent contains an unsafe path')
  return full
}

export function isTorrentSource(url: string): boolean {
  return url.startsWith('magnet:') || /\.torrent(?:\?|$)/i.test(url) || (!/^https?:/i.test(url) && url.endsWith('.torrent'))
}

/** Kept in the main process: the sandboxed renderer never receives peer sockets. */
export class Torrents extends EventEmitter {
  private client: Client | null = null
  private loading: Promise<Client> | null = null
  private active = new Map<string, { torrent: Torrent; timer: ReturnType<typeof setInterval>; initializing?: Promise<void> }>()
  private rate = -1

  constructor(private createClient: () => Promise<Client> = async () => {
    const { default: Constructor } = await import('webtorrent')
    return new Constructor({ utp: false })
  }) { super() }

  startDownload(opts: StartDownloadOptions): Promise<void> { return this.start(opts) }
  async cancelDownload(id: string): Promise<void> {
    await this.pause(id)
    this.emit('download-paused', { downloadId: id })
  }

  private getClient(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client)
    this.loading ??= this.createClient().then(client => {
      client.throttleDownload(this.rate)
      client.on('error', (error: string | Error) => {
        for (const id of this.active.keys()) this.emit('download-error', { downloadId: id, error: String(error) })
        for (const entry of this.active.values()) clearInterval(entry.timer)
        this.active.clear()
        this.client = null
        this.loading = null
      })
      this.client = client
      return client
    }).catch(error => { this.loading = null; throw error })
    return this.loading
  }

  async metadata(url: string): Promise<Metadata> {
    if (url.startsWith('magnet:')) {
      const params = new URL(url).searchParams
      if (!params.get('xt')?.startsWith('urn:btih:')) throw new Error('Use a BitTorrent v1 magnet link')
      const name = params.get('dn') || params.get('xt')!.slice(9)
      return { filename: name.replace(/[\\/:*?"<>|]/g, '_'), size: 0, url, kind: 'torrent' }
    }
    // Parsing metainfo requires no peer connections and starts no payload transfer.
    const { default: parseTorrent } = await import('parse-torrent')
    let bytes: Uint8Array
    if (/^https?:/i.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Torrent metadata request failed (${response.status})`)
      const chunks: Uint8Array[] = []
      let length = 0
      for await (const chunk of response.body!) {
        length += chunk.length
        if (length > 10 * 1024 * 1024) throw new Error('Torrent metadata exceeds 10 MB')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    } else { bytes = await readFile(url) }
    const meta = await parseTorrent(bytes)
    if (!meta.infoHash) throw new Error('Unsupported torrent metainfo')
    return { filename: (meta.name || meta.infoHash).replace(/[\\/:*?"<>|]/g, '_'), size: meta.length || 0, url, kind: 'torrent' }
  }

  async start(opts: StartDownloadOptions): Promise<void> {
    await mkdir(opts.path, { recursive: true })
    const manifest = join(opts.path, MANIFEST)
    const contents = await readdir(opts.path)
    if (contents.length && !contents.includes(MANIFEST)) throw new Error('Torrent destination must be an empty folder')
    if (contents.includes(MANIFEST)) {
      const saved = JSON.parse(await readFile(manifest, 'utf8'))
      if (saved.id !== opts.downloadId || saved.url !== opts.url) throw new Error('Folder belongs to another torrent')
    } else { await writeFile(manifest, JSON.stringify({ id: opts.downloadId, url: opts.url, files: [] })) }
    const client = await this.getClient()
    const source = opts.url.startsWith('magnet:') || /^https?:/i.test(opts.url) ? opts.url : await readFile(opts.url)
    const torrent = client.add(source, { path: opts.path, destroyStoreOnDestroy: false })
    let last = 0
    let ready = false
    const report = (): void => {
      if (!ready) return
      const bytes = Math.max(0, torrent.downloaded - last)
      last = torrent.downloaded
      this.emit('download-progress', { downloadId: opts.downloadId, bytesDownloaded: bytes, activeWorkers: torrent.numPeers })
    }
    const timer = setInterval(report, 250)
    const entry: { torrent: Torrent; timer: ReturnType<typeof setInterval>; initializing?: Promise<void> } = { torrent, timer }
    this.active.set(opts.downloadId, entry)
    torrent.once('ready', () => {
      entry.initializing = (async () => {
        const files = torrent.files.map(file => relative(resolve(opts.path), ownedPath(opts.path, file.path)))
        await writeFile(manifest, JSON.stringify({ id: opts.downloadId, url: opts.url, files }))
        if (!this.active.has(opts.downloadId)) return
        last = torrent.downloaded
        ready = true
        this.emit('download-started', { downloadId: opts.downloadId, downloadedBytes: last, totalSize: torrent.length, filename: torrent.name })
        if (torrent.done) finish()
      })().catch(fail)
    })
    const fail = (error: Error): void => {
      void this.pause(opts.downloadId).finally(() => this.emit('download-error', { downloadId: opts.downloadId, error: error.message }))
    }
    const finish = (): void => {
      if (!ready || !this.active.has(opts.downloadId)) return
      report()
      void this.pause(opts.downloadId).then(() => this.emit('download-completed', { downloadId: opts.downloadId, url: opts.url })).catch(fail)
    }
    torrent.on('error', error => fail(error instanceof Error ? error : new Error(error)))
    torrent.once('done', finish)
  }

  async pause(id: string): Promise<void> {
    const entry = this.active.get(id)
    if (!entry) return
    this.active.delete(id)
    clearInterval(entry.timer)
    // pause() alone does not close existing peer sockets; destroy preserves files.
    await new Promise<void>((resolve, reject) => entry.torrent.destroy({ destroyStore: false }, error => error ? reject(error) : resolve()))
    await entry.initializing
  }

  setRate(rate: number): void {
    this.rate = rate || -1
    this.client?.throttleDownload(this.rate)
  }

  async deleteFiles(opts: StartDownloadOptions): Promise<void> {
    await this.pause(opts.downloadId)
    const manifest = join(opts.path, MANIFEST)
    const saved = JSON.parse(await readFile(manifest, 'utf8'))
    if (saved.id !== opts.downloadId) throw new Error('Folder belongs to another torrent')
    for (const path of saved.files as string[]) await rm(ownedPath(opts.path, path), { force: true })
    await rm(manifest, { force: true })
    // Leave directories and anything the user added untouched.
  }

  async stop(): Promise<void> {
    await Promise.all([...this.active.keys()].map(id => this.pause(id)))
    if (this.client) await new Promise<void>((resolve, reject) => this.client!.destroy(error => error ? reject(error) : resolve()))
    this.client = null
    this.loading = null
  }
}
