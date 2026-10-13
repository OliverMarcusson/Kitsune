import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CompletedPayload,
  ErrorPayload,
  Metadata,
  PausedPayload,
  PersistedDownload,
  ProgressPayload,
  StartDownloadOptions,
  StartedPayload,
  StatePayload,
  TransferSettings
} from '../shared/ipc'

/**
 * The only surface the renderer gets. contextIsolation is on and nodeIntegration
 * off, so this is the complete list of privileged operations available to the UI.
 */

type Unsubscribe = () => void

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  // Wrap so the renderer never receives the Electron event object.
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getMetadata: (url: string): Promise<Metadata> => ipcRenderer.invoke('get-metadata', url),

  startDownload: (opts: StartDownloadOptions): Promise<void> =>
    ipcRenderer.invoke('start-download', opts),

  cancelDownload: (downloadId: string): Promise<void> =>
    ipcRenderer.invoke('cancel-download', downloadId),
  configureTransfers: (settings: TransferSettings): Promise<void> => ipcRenderer.invoke('configure-transfers', settings),
  restoreQueue: (downloads: PersistedDownload[]): Promise<void> => ipcRenderer.invoke('restore-queue', downloads),
  replaceUrl: (id: string, url: string): Promise<void> => ipcRenderer.invoke('replace-url', id, url),
  forgetDownload: (id: string): Promise<void> => ipcRenderer.invoke('forget-download', id),
  deleteDownload: (opts: StartDownloadOptions): Promise<void> => ipcRenderer.invoke('delete-download', opts),
  pickTorrent: (): Promise<string | null> => ipcRenderer.invoke('pick-torrent'),

  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('show-in-folder', path),

  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke('delete-file', path),

  getDownloadsDir: (): Promise<string> => ipcRenderer.invoke('get-downloads-dir'),

  saveState: (downloads: PersistedDownload[]): Promise<void> =>
    ipcRenderer.invoke('save-state', downloads),

  loadState: (): Promise<PersistedDownload[]> => ipcRenderer.invoke('load-state'),

  pickDirectory: (title: string): Promise<string | null> =>
    ipcRenderer.invoke('pick-directory', title),

  onDownloadProgress: (cb: (p: ProgressPayload) => void): Unsubscribe =>
    subscribe('download-progress', cb),
  onDownloadStarted: (cb: (p: StartedPayload) => void): Unsubscribe => subscribe('download-started', cb),
  onDownloadState: (cb: (p: StatePayload) => void): Unsubscribe => subscribe('download-state', cb),
  onDownloadCompleted: (cb: (p: CompletedPayload) => void): Unsubscribe =>
    subscribe('download-completed', cb),
  onDownloadError: (cb: (p: ErrorPayload) => void): Unsubscribe => subscribe('download-error', cb),
  onDownloadPaused: (cb: (p: PausedPayload) => void): Unsubscribe =>
    subscribe('download-paused', cb),
  onDeepLink: (cb: (url: string) => void): Unsubscribe => subscribe('deep-link-received', cb)
}

contextBridge.exposeInMainWorld('kitsune', api)

export type KitsuneApi = typeof api
