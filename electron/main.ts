// Electron main process for OL Premiere (ESM). Serves the EXISTING built
// renderer over a registered `app://` secure standard scheme — never file:// —
// so the app's ES module workers (export + captions), dynamic import(),
// IndexedDB, Cache Storage and other secure-context APIs behave exactly as on
// the web. The origin (`app://olpremiere`) is PINNED forever: changing it (or
// the appId/productName) would orphan the user's IndexedDB.

import { app, BrowserWindow, protocol, ipcMain, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { NativeExportConfig } from './ipc-types'
import * as native from './nativeExport'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// ESM main has no __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Built layout: out/main/main.js → ../renderer = out/renderer. When packaged
// this resolves INSIDE app.asar, and readFile is asar-aware.
const RENDERER_DIST = path.join(__dirname, '../renderer')
const DEV_URL = process.env.ELECTRON_RENDERER_URL // set by `electron-vite dev`
const isDev = !!DEV_URL

// Stable, PINNED app origin. Never rotate the host — the IndexedDB partition is
// keyed on it, so a change would orphan saved projects.
const APP_ORIGIN_HOST = 'olpremiere'

/** The main window, so native-export handlers can target it (save dialog, progress). */
let mainWindow: BrowserWindow | null = null

// Content types we must set explicitly: a `type:module` worker hard-fails if it
// is not served as JS, and a streaming WebAssembly.instantiate needs
// application/wasm. (This is the V2 fix — we read via asar-aware fs and set the
// MIME ourselves rather than trusting net.fetch to infer it through asar.)
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
}
const mimeFor = (p: string): string => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'

// Must run BEFORE app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f0e0d',
    show: false,
    autoHideMenuBar: true,
    title: 'OL Premiere',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // GPU/WebGL/WebCodecs stay ON — the compositor + fast export depend on it.
      // NEVER call app.disableHardwareAcceleration().
    },
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // External http(s) links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // OS file-drops (or a stray link) must never navigate the window away from the
  // app and wipe the editor.
  win.webContents.on('will-navigate', (e, url) => {
    const target = isDev ? DEV_URL! : `app://${APP_ORIGIN_HOST}/`
    if (!url.startsWith(target)) e.preventDefault()
  })

  if (isDev) {
    void win.loadURL(DEV_URL!)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadURL(`app://${APP_ORIGIN_HOST}/index.html`)
  }
}

app.whenReady().then(() => {
  // Serve the built renderer from out/renderer over app://. Read with the
  // asar-aware fs and set Content-Type ourselves so module workers + wasm load.
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const filePath = path.join(RENDERER_DIST, rel)
    // Path-traversal guard: never serve outside the renderer dir.
    if (filePath !== RENDERER_DIST && !filePath.startsWith(RENDERER_DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await readFile(filePath)
      return new Response(new Uint8Array(data), { headers: { 'content-type': mimeFor(filePath) } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // Allow the microphone (voiceover recorder + monitoring) — deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))

  ipcMain.handle('app:version', () => app.getVersion())

  // Native ffmpeg export.
  ipcMain.handle('native:probe', () => native.probe())
  ipcMain.handle('native:prepareAudio', async (_e, wav: ArrayBuffer) => {
    await native.prepareAudio(wav)
    return { ok: true }
  })
  ipcMain.handle('native:start', (_e, config: NativeExportConfig) => {
    if (!mainWindow) return { started: false, error: 'no window' }
    return native.start(config, mainWindow)
  })
  ipcMain.handle('native:writeFrame', async (_e, frame: ArrayBuffer) => {
    try {
      await native.writeFrame(frame)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('native:finish', () => native.finish())
  ipcMain.handle('native:cancel', () => native.cancel())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Auto-update: on a packaged build, check GitHub Releases (electron-builder.yml
  // `publish`), download a newer version in the background, and install it on
  // quit. A failed check (offline / no release) logs and is ignored. We re-check
  // every 15 minutes so an app that's left open still gets a release the same
  // day it ships — not only on the next launch.
  if (app.isPackaged) {
    autoUpdater.on('error', (e) => console.error('OL Premiere auto-update error:', e))
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`OL Premiere update ${info.version} downloaded — installs on quit`)
      // Tell the renderer so it can surface "Update ready — Restart", instead of
      // the update sitting invisibly until the user happens to quit.
      mainWindow?.webContents.send('update:ready', info.version)
    })
    // One-click apply: quit and relaunch into the freshly downloaded version.
    ipcMain.on('update:install', () => autoUpdater.quitAndInstall())
    void autoUpdater.checkForUpdatesAndNotify()
    const FIFTEEN_MIN = 15 * 60 * 1000
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), FIFTEEN_MIN)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
