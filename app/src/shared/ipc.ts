/** Payload shapes shared by the main process, the preload bridge and the UI. */

export interface Metadata {
  filename: string
  size: number
  url: string
  kind?: 'http' | 'torrent'
}

export interface ProgressPayload {
  downloadId: string
  bytesDownloaded: number
  activeWorkers: number
}

export interface CompletedPayload {
  downloadId: string
  url: string
}

export interface ErrorPayload {
  downloadId: string
  error: string
}

export interface PausedPayload {
  downloadId: string
}

export interface StartDownloadOptions {
  downloadId: string
  url: string
  path: string
  connections: number
  kind?: 'http' | 'torrent'
}

export interface StartedPayload {
  downloadId: string
  downloadedBytes: number
  totalSize: number
  filename?: string
}

export interface StatePayload {
  downloadId: string
  status: 'queued' | 'downloading' | 'paused'
}

export interface TransferSettings {
  speedLimit: number
  slowMode: boolean
  slowSpeed: number
  maxActive: number
  schedule: {
    enabled: boolean
    start: string
    stop: string
    days: number[]
    endDate: string
  }
}

/**
 * On-disk shape of state.json. Kept in snake_case to stay byte-compatible with
 * the file the Tauri build wrote, so upgrading does not lose the download list.
 */
export interface PersistedDownload {
  id: string
  url: string
  filename: string
  path: string
  total_size: number
  downloaded_bytes: number
  status: string
  connections: number
  started_at: number
  kind?: 'http' | 'torrent'
}
