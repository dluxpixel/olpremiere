// Electron main process for OL Premiere (ESM). Serves the EXISTING built
// renderer over a registered `app://` secure standard scheme (never file://) so
// the app's ES module workers (export + captions), dynamic import(),
// IndexedDB, Cache Storage and other secure-context APIs behave exactly as on
// the web. The origin (`app://olpremiere`) is PINNED forever: changing it (or
// the appId/productName) would orphan the user's IndexedDB.

import { app, BrowserWindow, protocol, ipcMain, powerMonitor, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import * as backups from './backups'
import type { NativeExportConfig, UpdateStatus } from './ipc-types'
import { SPLASH_MELON_POP_MS, SPLASH_MELON_PX, SPLASH_WINDOW_H, SPLASH_WINDOW_W } from './ipc-types'
import * as native from './nativeExport'
import * as proxy from './proxy'
import * as remux from './remux'
import { IDLE_POLL_MS, updateApplyDecision } from './updateApply'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// --- userData: `reel` -> `OL Premiere`, before ANYTHING touches a path --------
//
// Electron derives userData from package.json `name`, so renaming the package
// silently repoints the app at an empty directory and every saved project
// "disappears": 6.8 GB of them on the author's machine. The data does not need
// copying, only re-addressing: a directory rename on the same volume is atomic
// and instant whatever it holds.
//
// Must run before app.getPath('userData') is read for the first time, hence the
// placement at module top level rather than inside whenReady.
const LEGACY_USER_DATA_NAME = 'reel'
try {
  const userData = app.getPath('userData')
  if (!existsSync(userData)) {
    const legacy = path.join(path.dirname(userData), LEGACY_USER_DATA_NAME)
    // Only when the legacy directory is really there and the new one is not, so
    // this can never clobber a live profile and is a no-op on every later launch.
    if (existsSync(legacy)) renameSync(legacy, userData)
  }
} catch {
  // A locked or in-use profile: fall through and let Electron create a fresh
  // userData rather than refusing to start. The legacy directory is untouched,
  // so the next launch tries again.
}

// ESM main has no __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Built layout: out/main/main.js → ../renderer = out/renderer. When packaged
// this resolves INSIDE app.asar, and readFile is asar-aware.
const RENDERER_DIST = path.join(__dirname, '../renderer')
const DEV_URL = process.env.ELECTRON_RENDERER_URL // set by `electron-vite dev`
const isDev = !!DEV_URL

// Stable, PINNED app origin. Never rotate the host. The IndexedDB partition is
// keyed on it, so a change would orphan saved projects.
const APP_ORIGIN_HOST = 'olpremiere'

/** The main window, so native-export handlers can target it (save dialog, progress). */
let mainWindow: BrowserWindow | null = null

/**
 * The splash: its own frameless, transparent, always-on-top window, floating over
 * his desktop the way the Vegas one does. His words, looking at the old in-app
 * version: "no background, no X, it would just show the desktop."
 *
 * It is a separate WINDOW rather than a screen inside the app because the editor
 * window cannot be shown until it has something to show, and a maximized black
 * rectangle with a small card in the middle is exactly what he did not want.
 */
let splashWindow: BrowserWindow | null = null
/** True once the editor said the startup work is done, which is when the melon goes up. */
let bootFinished = false
/** True once the editor window has been shown, so every route into that swap is idempotent. */
let entered = false
/** Rescue timer: fires only if the boot never reports at all. Cleared the moment it does. */
let bootBackstop: ReturnType<typeof setTimeout> | null = null

function createSplash(): void {
  const win = new BrowserWindow({
    width: SPLASH_WINDOW_W,
    // The card is 660 wide and about 400 tall now that the startup has eleven rows
    // in two groups, and the window is deliberately larger so the drop shadow has
    // somewhere to land on a transparent background. This was still 344, sized for
    // the seven-row card of v0.1.16, so the card was being clipped in its own window.
    height: SPLASH_WINDOW_H,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  splashWindow = win
  win.once('ready-to-show', () => {
    // He may already be in the editor if this window was slow off a cold disk.
    if (entered) {
      win.close()
      return
    }
    win.show()
    // The boot can also finish before the page is ready, on a fast disk. Tell it
    // now, or the card would sit at 100% forever and the melon would never come.
    if (bootFinished) win.webContents.send('boot:ready')
  })
  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null
    // The splash is frameless with no close button, but Alt+F4 still reaches it.
    // Losing it must never leave him with a running app and no window at all.
    if (!entered) enterEditor()
  })
  void win.loadURL(isDev ? `${DEV_URL}/splash.html` : `app://${APP_ORIGIN_HOST}/splash.html`)
}

/**
 * The startup work is done. The editor deliberately does NOT open here.
 *
 * His ask: the card gives way to the melon, and the melon is the button that
 * opens the app. So the splash keeps the screen, plays its card out and shrinks
 * to a square around the fruit, and nothing swaps until he clicks. Waiting on a
 * person is not a hang, so the rescue timer stands down here.
 */
function bootReady(): void {
  if (bootFinished || entered) return
  bootFinished = true
  if (bootBackstop) clearTimeout(bootBackstop)
  bootBackstop = null
  const win = splashWindow
  // No splash to hand over to (it failed to open, or he closed it): just open.
  if (!win || win.isDestroyed()) {
    enterEditor()
    return
  }
  win.webContents.send('boot:ready')
}

/** The card has finished its exit: pull the window in around the melon, in place. */
function shrinkSplash(): void {
  const win = splashWindow
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  // Shrink about the CENTRE, so a window he dragged somewhere stays where he put it.
  const half = Math.round(SPLASH_MELON_PX / 2)
  // A non-resizable window refuses a programmatic resize on Windows, so lift the
  // flag for exactly this one call and put it straight back.
  win.setResizable(true)
  win.setBounds({
    x: b.x + Math.round(b.width / 2) - half,
    y: b.y + Math.round(b.height / 2) - half,
    width: SPLASH_MELON_PX,
    height: SPLASH_MELON_PX,
  })
  win.setResizable(false)
  win.focus() // it is a button now, so it has to be the thing that has focus
}

/** Open the editor and retire the splash. Safe to call twice, from any route. */
function enterEditor(): void {
  if (entered) return
  entered = true
  bootFinished = true
  if (bootBackstop) clearTimeout(bootBackstop)
  bootBackstop = null
  const win = mainWindow
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.maximize()
    win.show()
  }
  // The splash outlives the swap by the length of the melon's pop, so the fruit
  // bursts OVER the opening editor instead of blinking out a beat before it.
  const splash = splashWindow
  splashWindow = null
  if (splash && !splash.isDestroyed()) {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close()
    }, SPLASH_MELON_POP_MS)
  }
}

/**
 * Where the auto-updater stands. Held here (not just broadcast) because the
 * renderer needs to be able to ASK: it starts up alongside the check, and the
 * loading card must be able to say truthfully whether the check finished.
 * `unsupported` until proven otherwise: an unpackaged build runs no updater.
 */
let updateStatus: UpdateStatus = { kind: 'unsupported' }
function setUpdateStatus(status: UpdateStatus): void {
  updateStatus = status
  mainWindow?.webContents.send('update:status', status)
}

// Content types we must set explicitly: a `type:module` worker hard-fails if it
// is not served as JS, and a streaming WebAssembly.instantiate needs
// application/wasm. (This is the V2 fix: we read via asar-aware fs and set the
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
      // GPU/WebGL/WebCodecs stay ON because the compositor + fast export depend on it.
      // NEVER call app.disableHardwareAcceleration().
    },
  })
  mainWindow = win
  // The editor window stays HIDDEN until the boot finishes, so while the app loads
  // he sees the small card on his desktop and nothing else. It opens MAXIMIZED,
  // not fullscreen, because an editor still needs its title bar and the taskbar.
  win.once('ready-to-show', () => {
    // While a splash is up, the editor stays hidden even after the boot finishes:
    // the melon is a deliberate gate, and he is the one who opens it.
    if (entered || !splashWindow) {
      win.maximize()
      win.show()
    }
  })
  // Backstop: if the renderer never reports a finished boot (an old bundle, a
  // startup crash), show the editor anyway rather than stranding him on a splash.
  // It does NOT police the melon: a melon waiting to be clicked is not a hang, so
  // bootReady cancels this the moment the real boot reports in.
  bootBackstop = setTimeout(enterEditor, 15_000)
  win.on('closed', () => {
    if (bootBackstop) clearTimeout(bootBackstop)
    bootBackstop = null
  })
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
    // DevTools is OPT IN, not automatic. His words, 2026-08-08: "every time you reload and open
    // something, it just opens the electron thing and it opens OL Premiere on my desktop, which is
    // kind of annoying." He was reading something at the time, and a detached DevTools window on
    // top of a dev shell he never asked for took his screen. He does not develop this app, he uses
    // it, so nothing here may assume a human who wants a debugger. Set OLP_DEVTOOLS=1 to get it.
    if (process.env.OLP_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadURL(`app://${APP_ORIGIN_HOST}/index.html`)
  }
}

app.whenReady().then(() => {
  // A transcode that died mid-flight leaves its temp behind forever, because the
  // only cleanup is a finally that a killed process never reaches. One of his was
  // 427 MB. Fire and forget: tidying up must never delay the window.
  void proxy.sweepProxyTemps()
  // Same reason, and the stakes are higher: a remux temp is a FULL SIZE copy of
  // his source, not a downscaled preview, so one abandoned run is gigabytes.
  void remux.sweepRemuxTemps()

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

  // Allowlist exactly what the editor uses, deny everything else. 'media' is the
  // voiceover recorder + monitoring; 'fullscreen' is the Monitor's Fullscreen
  // button (Electron routes requestFullscreen through here, so denying it made
  // the button silently do nothing in the desktop build while working on the
  // web); 'clipboard-sanitized-write' is the collab "copy room link".
  const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(ALLOWED_PERMISSIONS.has(permission)),
  )

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

  // A preview copy is an optimisation, never a requirement: a failure here is
  // logged and swallowed so an odd file cannot stop it being imported or edited.
  ipcMain.handle('proxy:begin', () => proxy.beginProxy())
  ipcMain.handle('proxy:chunk', (_e, id: string, bytes: ArrayBuffer) => proxy.chunkProxy(id, bytes))
  ipcMain.handle('proxy:cancel', (_e, id: string) => proxy.cancelProxy(id))
  ipcMain.handle('proxy:finish', async (_e, id: string) => {
    try {
      return await proxy.finishProxy(id)
    } catch (err) {
      console.warn('OL Premiere: preview copy failed, preview will use the original', err)
      return null
    }
  })

  // ⛔ A conversion is NOT optional the way a preview copy is. Without it his
  // .mkv cannot be imported at all, so a failure here must reach the renderer
  // with its reason attached and be reported, never swallowed into a null the
  // way `proxy:finish` is.
  ipcMain.handle('remux:begin', () => remux.beginRemux())
  ipcMain.handle('remux:chunk', (_e, id: string, bytes: ArrayBuffer) => remux.chunkRemux(id, bytes))
  ipcMain.handle('remux:finish', (_e, id: string) => remux.finishRemux(id))
  ipcMain.handle('remux:read', (_e, id: string, offset: number, length: number) =>
    remux.readRemux(id, offset, length),
  )
  ipcMain.handle('remux:release', (_e, id: string) => remux.releaseRemux(id))

  // --- Backups -------------------------------------------------------------
  ipcMain.handle('backup:write', (_e, projectName: string, json: string) => backups.writeBackup(projectName, json))
  ipcMain.handle('backup:list', () => backups.listBackups())
  ipcMain.handle('backup:dir', () => backups.backupDir())
  ipcMain.handle('backup:read', async (_e, filePath: string) => {
    // The renderer may only read back what WE wrote. Without this, a compromised
    // or buggy renderer could hand over any path on the machine and have main
    // read it out. The backup feature must not become a file-read primitive.
    const dir = path.resolve(backups.backupDir())
    const target = path.resolve(filePath)
    if (!target.startsWith(dir + path.sep) || !target.endsWith('.olpbak')) {
      throw new Error('Refused: not a backup file')
    }
    return readFile(target, 'utf8')
  })
  ipcMain.handle('backup:reveal', async () => {
    const dir = backups.backupDir()
    await mkdir(dir, { recursive: true }) // opening a folder that does not exist just fails silently
    await shell.openPath(dir)
  })

  // Whatever ends the app (user quit, or an auto-update install), never leave a
  // native ffmpeg child orphaned or its temp files behind. before-quit can't await,
  // so use the synchronous teardown (SIGKILL + unlinkSync) rather than the async
  // cancel() whose unlink would race the process exit.
  app.on('before-quit', () => native.cancelSync())

  // Splash FIRST, so it is on screen while the editor window loads behind it.
  createSplash()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // The editor renderer is the only thing that knows what the real startup work is
  // doing, so it drives the splash and decides when it is done.
  ipcMain.on('boot:progress', (_e, progress) => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('boot:progress', progress)
  })
  ipcMain.on('boot:finished', () => bootReady())
  // Both come from the splash window itself, driving its own two beats: the card
  // has finished leaving, and then the melon has been clicked.
  ipcMain.on('boot:shrink', (e) => {
    if (e.sender === splashWindow?.webContents) shrinkSplash()
  })
  ipcMain.on('boot:enter', () => enterEditor())

  // Auto-update: on a packaged build, check GitHub Releases (electron-builder.yml
  // `publish`) and download a newer version in the background. A failed check
  // (offline / no release) logs and is ignored. We re-check every 15 minutes so
  // an app left open still gets a release the same day it ships.
  //
  // APPLY POLICY (David's ask was "every time I start, just update to the newest"):
  // if the update finishes downloading shortly after LAUNCH (before the user has
  // settled into editing), quit + install + relaunch straight into it, so every
  // start converges to the newest build with zero clicks. If it lands LATER
  // (mid-edit) we must not yank the app out from under active work, so we surface
  // the "Restart to update" toast instead. Either way, after the relaunch the
  // renderer shows a "Updated to vX" toast and the always-on version tag confirms
  // exactly which build is running (App.tsx / TopBar). The "what version am I on"
  // confusion is gone.
  // The updater's state, kept here so the renderer can ASK as well as listen. The
  // loading card narrates this check as one of its rows, and it mounts a beat after
  // the check starts. Without a pull, a fast answer would land before anyone was
  // listening and the row would claim to still be checking.
  ipcMain.handle('update:status:get', () => updateStatus)

  // The reload button's half of the job. Lives in MAIN because main outlives the
  // renderer's reload, so the check it starts is not cancelled a moment later.
  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) return
    if (updateStatus.kind !== 'downloaded') setUpdateStatus({ kind: 'checking' })
    void autoUpdater.checkForUpdatesAndNotify()
  })

  if (app.isPackaged) {
    const launchedAt = Date.now()
    const AUTO_APPLY_WINDOW_MS = 3 * 60 * 1000
    let pendingVersion = ''
    // Set once an update is downloaded and waiting for him to step away. See
    // ./updateApply for why idleness is the second door.
    let idleApplyTimer: ReturnType<typeof setInterval> | null = null
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true // a pending update also installs on any quit
    autoUpdater.on('error', (e) => {
      // NEVER swallow this. A silent failure here is indistinguishable from "no
      // update available", which is exactly how a dead update feed (an
      // unreachable repo, a 404 on latest.yml) hid for weeks.
      const msg = e instanceof Error ? e.message : String(e)
      console.error('OL Premiere auto-update error:', e)
      mainWindow?.webContents.send('update:error', msg)
      setUpdateStatus({ kind: 'error', message: msg })
    })
    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:none')
      setUpdateStatus({ kind: 'none' })
    })
    // Found one, and the download starts itself (autoDownload), so say so, and then
    // say how far it has got. A 240 MB installer arriving in silence is the thing
    // that made the app look stuck on "checking".
    autoUpdater.on('update-available', (info) => {
      pendingVersion = info.version
      setUpdateStatus({ kind: 'available', version: info.version })
    })
    autoUpdater.on('download-progress', (p) => {
      setUpdateStatus({ kind: 'downloading', version: pendingVersion, percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      setUpdateStatus({ kind: 'downloaded', version: info.version })
      // Auto-apply only in the fresh-launch window AND only when no native export
      // is mid-render (a force-quit would truncate the file + orphan ffmpeg). Even
      // then we don't quit blindly: we ASK the renderer, which flushes a save and
      // restarts only if no critical work is in flight. Otherwise it falls back to
      // the "Restart to update" toast. Outside the window we always just offer the toast.
      // proxyBusy for the same reason as isExporting: a restart mid-transcode
      // orphans an ffmpeg child and leaves half a proxy behind.
      const busy = (): boolean => native.isExporting() || proxy.proxyBusy() || remux.remuxBusy()
      const decide = (): 'now' | 'when-idle' | 'never' =>
        updateApplyDecision({
          freshLaunch: Date.now() - launchedAt < AUTO_APPLY_WINDOW_MS,
          idleSeconds: powerMonitor.getSystemIdleTime(),
          busy: busy(),
        })

      if (decide() === 'now') {
        console.log(`OL Premiere update ${info.version} downloaded at launch, asking renderer to auto-apply`)
        mainWindow?.webContents.send('update:autoApply', info.version)
        return
      }

      // He asked for the click to go, 2026-08-17: "Make it automatic." So the toast
      // is the FALLBACK now rather than the plan. The update also applies itself the
      // moment he is not using the machine, and `getSystemIdleTime` is the whole
      // machine rather than this app, so it cannot fire while he is typing anywhere.
      console.log(`OL Premiere update ${info.version} downloaded, offering restart and watching for idle`)
      mainWindow?.webContents.send('update:ready', info.version)
      if (idleApplyTimer) clearInterval(idleApplyTimer)
      idleApplyTimer = setInterval(() => {
        if (decide() !== 'now') return
        if (idleApplyTimer) clearInterval(idleApplyTimer)
        idleApplyTimer = null
        console.log(`OL Premiere update ${info.version}: he has been idle, applying it`)
        mainWindow?.webContents.send('update:autoApply', info.version)
      }, IDLE_POLL_MS)
    })
    // Apply from the toast (and the renderer's save-then-restart path): quit and
    // relaunch into the downloaded version.
    //
    // Both arguments matter and neither is the default. Silent runs the installer
    // with /S, so nothing is put in front of him; force-run-after starts the new
    // version once it lands, so the app he was using comes back on its own. With
    // the defaults, updating meant an installer window and a Finish button, which
    // is the thing he asked to be rid of.
    ipcMain.on('update:install', () => autoUpdater.quitAndInstall(true, true))
    setUpdateStatus({ kind: 'checking' })
    void autoUpdater.checkForUpdatesAndNotify()
    const FIFTEEN_MIN = 15 * 60 * 1000
    setInterval(() => {
      // A later check must not erase a staged update: "restart to install" is the
      // truer answer than "checking" once a version is already on disk.
      if (updateStatus.kind !== 'downloaded') setUpdateStatus({ kind: 'checking' })
      void autoUpdater.checkForUpdatesAndNotify()
    }, FIFTEEN_MIN)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
