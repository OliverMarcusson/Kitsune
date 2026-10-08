import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Sidecar } from './sidecar'
import { ShimBridge } from './shim-bridge'
import { kitsuneConfigDir, stateFilePath } from './paths'

const PROTOCOL = 'kitsune'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const sidecar = new Sidecar()
const shimBridge = new ShimBridge()

/** Pull a kitsune:// or http(s) URL out of argv (deep link / shim launch). */
function extractUrlFromArgs(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(`${PROTOCOL}://`) || arg.startsWith('http://') || arg.startsWith('https://')) {
      return arg
    }
  }
  return null
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function handleDeepLink(rawUrl: string): void {
  // kitsune://<encoded target> wraps the real download URL.
  let url = rawUrl
  if (url.startsWith(`${PROTOCOL}://`)) {
    url = decodeURIComponent(url.slice(`${PROTOCOL}://`.length)).replace(/\/+$/, '')
  }
  if (!url) return
  showWindow()
  sendToRenderer('deep-link-received', url)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 960,
    minHeight: 600,
    title: 'Kitsune Download Manager',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Close hides to tray, matching the Tauri build. Only an explicit quit exits.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // Never let the renderer navigate away or spawn windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const iconPath = join(process.resourcesPath, 'icon.png')
  const devIcon = join(__dirname, '../../resources/icon.png')
  const source = existsSync(iconPath) ? iconPath : devIcon
  if (!existsSync(source)) return

  tray = new Tray(nativeImage.createFromPath(source))
  tray.setToolTip('Kitsune Download Manager')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Window', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

function registerIpcHandlers(): void {
  // --- delegated to the Rust sidecar ---
  ipcMain.handle('get-metadata', (_e, url: string) => sidecar.getMetadata(url))

  ipcMain.handle(
    'start-download',
    (_e, opts: { downloadId: string; url: string; path: string; connections: number }) =>
      sidecar.startDownload(opts)
  )

  ipcMain.handle('cancel-download', (_e, downloadId: string) => sidecar.cancelDownload(downloadId))

  // --- handled natively; these never needed Rust ---
  ipcMain.handle('show-in-folder', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('delete-file', (_e, path: string) => {
    try {
      rmSync(path, { force: true })
    } catch (err) {
      throw new Error(`could not delete ${path}: ${(err as Error).message}`)
    }
  })

  ipcMain.handle('get-downloads-dir', () => {
    try {
      const downloads = app.getPath('downloads')
      if (downloads && downloads !== homedir()) return downloads
    } catch {
      /* fall through */
    }
    const fallback = join(homedir(), 'Downloads')
    return existsSync(fallback) ? fallback : homedir()
  })

  ipcMain.handle('save-state', (_e, downloads: unknown[]) => {
    const file = stateFilePath()
    mkdirSync(kitsuneConfigDir(), { recursive: true })
    writeFileSync(file, JSON.stringify(downloads, null, 2))
  })

  ipcMain.handle('load-state', () => {
    // Same file and same snake_case shape the Tauri build wrote, so existing
    // download lists survive the upgrade.
    try {
      return JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    } catch {
      return []
    }
  })

  // The UI browses for a destination *folder* and appends the filename itself,
  // matching the Tauri dialog plugin's `{ directory: true }` behaviour.
  ipcMain.handle('pick-directory', async (_e, title: string) => {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}

function forwardSidecarEvents(): void {
  for (const event of [
    'download-progress',
    'download-completed',
    'download-error',
    'download-paused'
  ]) {
    sidecar.on(event, (msg) => sendToRenderer(event, msg))
  }
}

// A second launch must hand its URL to the running instance, not start a rival app.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow()
    const url = extractUrlFromArgs(argv)
    if (url) handleDeepLink(url)
  })

  // macOS delivers deep links as an event rather than argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

  app.whenReady().then(() => {
    if (process.defaultApp) {
      // `electron .` during development needs the script path to round-trip.
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [join(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }

    try {
      sidecar.start()
    } catch (err) {
      console.error('[kitsune] failed to start sidecar:', (err as Error).message)
      dialog.showErrorBox('Kitsune Download Manager', (err as Error).message)
      app.quit()
      return
    }

    forwardSidecarEvents()
    registerIpcHandlers()
    createWindow()
    createTray()
    shimBridge.start(handleDeepLink)

    const startupUrl = extractUrlFromArgs(process.argv)
    if (startupUrl) setTimeout(() => handleDeepLink(startupUrl), 500)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  // A bare SIGTERM (logout, shutdown, `kill`) skips `will-quit`, which would
  // leave a stale ipc.port behind pointing at a dead socket. Route signals
  // through the normal quit path so the file is always removed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      quitting = true
      app.quit()
    })
  }

  // Closing the last window hides to tray, so do not quit here on any platform.
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    shimBridge.stop()
    sidecar.stop()
  })
}
