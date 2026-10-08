// Electron main process for OL Premiere (ESM). Serves the EXISTING built
// renderer over a registered `app://` secure standard scheme (never file://) so
// the app's ES module workers (export + captions), dynamic import(),
// IndexedDB, Cache Storage and other secure-context APIs behave exactly as on
// the web. The origin (`app://olpremiere`) is PINNED forever: changing it (or
// the appId/productName) would orphan the user's IndexedDB.

import { app, BrowserWindow, crashReporter, dialog, Menu, net, protocol, ipcMain, powerMonitor, screen, session, shell } from 'electron'

// ⛔ ONE COPY OF THE APP AT A TIME. Two launches, a slow first start plus an
// impatient second click, or a copy still alive after a crash, used to start a
// second whole engine on the SAME profile: the same IndexedDB, the same project
// files in Documents, the same backups, all written by two processes that know
// nothing of each other. That is the shape of every "the store rebuilt itself"
// that was never explained. The second copy now hands over and quits; the first
// one comes to the front.
//
// ⛔ exit, NOT quit, 2026-10-06. Before the app is ready, quit() is only a request:
// the ready event still fired and this copy ran the whole startup first, and the
// startup's first job is sweeping temp files "nobody can be using". On one profile
// those were the FIRST copy's live files: an .mkv mid conversion lost its source.
// exit() before ready ends the process on the spot. The lock has already handed his
// click to the first copy by the time it returns.
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.exit(0)
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import * as backups from './backups'
import { createCutstudio, realCutstudioDeps } from './cutstudio'
import { createEmojiFontStore, downloadBytes, EMOJI_ROUTE } from './emojiFont'
import * as projectFiles from './projectFiles'
import * as libraryFile from './libraryFile'
import * as captionStylesFile from './captionStylesFile'
import * as usageFiles from './usageFiles'
import * as saveFiles from './saveFiles'
import type { NativeExportConfig, UpdateStatus } from './ipc-types'
import {
  SPLASH_MELON_POP_MS,
  SPLASH_MELON_PX,
  SPLASH_WINDOW_H,
  SPLASH_WINDOW_W,
  UPDATE_MELON_TIMEOUT_MS,
  UPDATE_SCREEN_DELAY_MS,
  UPDATE_SCREEN_MAX_PCT,
  UPDATE_SCREEN_UNBIDDEN,
} from './ipc-types'
import * as native from './nativeExport'
import * as proxy from './proxy'
import * as mediaStore from './mediaStore'
import * as remux from './remux'
import { CRASH_LOG_NAME, crashLogLine, crashPlan } from './crashPlan'
import { exportPathFromPage, exportPathUsed } from './exportChoice'
import { appliedWhileAway, launchMode, parseQuietMarker, QUIET_START_FILE, secondInstanceAction } from './launchMode'
import { centreIn, readWindowState, restoreBounds, WINDOW_STATE_FILE, writeWindowState, type Placement } from './windowState'
import { fileQuietStore, startUpdateFlow, type UpdateFlow } from './updateFlow'
import { MAIN_LOG_NAME, mainLog, mainLogger, setMainLogFile } from './mainLog'
import { appendUpdateLog, UPDATE_LOG_NAME } from './updateLog'
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

// A crash dump stays on his disk (userData/Crashpad) and goes nowhere else. After the
// userData rename above, so the dumps land in the profile he really uses.
try {
  crashReporter.start({ uploadToServer: false })
} catch {
  // A crash reporter that will not start must never be the reason the app does not.
}

// ESM main has no __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Built layout: out/main/main.js → ../renderer = out/renderer. When packaged
// this resolves INSIDE app.asar, and readFile is asar-aware.
const RENDERER_DIST = path.join(__dirname, '../renderer')
const DEV_URL = process.env.ELECTRON_RENDERER_URL // set by `electron-vite dev`
const isDev = !!DEV_URL

/**
 * THE LAB BUILD: a second copy of the app that shares nothing with his.
 *
 * His ask, 2026-08-19: *"Can you work on a separate version of the OL Premiere
 * so I can work on edits while you work on making the program better?"* Fair,
 * and the shape of the answer is that every place two apps could collide has to
 * be different, not just the icon:
 *
 *   - a different product name, so Windows installs it beside his rather than
 *     over it, and the two have separate folders
 *   - a different saved-projects origin, right below, because a browser engine
 *     keys storage on the origin and NOTHING else. Same origin means the same
 *     projects, so a test run in the lab would be editing his real work
 *   - no auto-update, further down, because the lab is built from whatever is
 *     on the bench and must never replace itself with the shipped app
 *
 * The flavour is decided by the packaged name. The lab build that set it was
 * removed on 2026-08-24 at his request; the branch stays because APP_ORIGIN_HOST
 * below is the IndexedDB partition key and changing it orphans every project. His
 * build never passes it, so his build is untouched by all of this.
 */
export const IS_LAB = app.getName().toLowerCase().includes('lab')

// Stable, PINNED app origin. Never rotate the host. The IndexedDB partition is
// keyed on it, so a change would orphan saved projects. The lab's own host is
// pinned in exactly the same way, and the two must never meet.
const APP_ORIGIN_HOST = IS_LAB ? 'olpremierelab' : 'olpremiere'

/** The main window, so native-export handlers can target it (save dialog, progress). */
let mainWindow: BrowserWindow | null = null
/** Set once an update install has begun closing the window. See 'update:install'. */
let installing = false
/** After the window is gone, how long the engine gets to finish writing before the installer runs. */
const INSTALL_FLUSH_MS = 1500
/** How long to wait for the window to close before installing the old way regardless. */
const INSTALL_CLOSE_TIMEOUT_MS = 5000
/** Set on before-quit, so a page ending because the app is ending is not mistaken for a crash. */
let quitting = false
/** Closed with an update waiting: the settle before the installer is running (window-all-closed). */
let quittingToInstall = false
/** His click on the icon during that settle: the installer should open the new version after. */
let openAfterInstall = false

// --- A page that dies under him (./crashPlan) ---------------------------------
/** When the editor's page died before, so a page that keeps dying stops reloading. */
const editorDeaths: number[] = []
/** Set by a reload after a crash. The new page asks for it once and says what happened. */
let recoveredFromCrash = false
/** The editor's page died for good: the app ends on his answer, and nothing shows the dead editor. */
let editorStopped = false

/** One line in logs/crash.log. Never throws, like the update log it shares a writer with. */
function crashLog(line: string): void {
  appendUpdateLog(path.join(app.getPath('logs'), CRASH_LOG_NAME), line)
}

/**
 * The editor's page is gone. Load it again, and write down why. See ./crashPlan for
 * why this exists and why it gives up on the third death in five minutes.
 */
function onEditorGone(win: BrowserWindow, details: Electron.RenderProcessGoneDetails): void {
  if (quitting || installing || win.isDestroyed()) return
  const now = Date.now()
  const plan = crashPlan(details.reason, editorDeaths, now)
  if (plan === 'nothing') return
  editorDeaths.push(now)
  crashLog(crashLogLine(new Date(now), 'editor page gone', details, app.getVersion(), plan))
  if (plan === 'reload') {
    recoveredFromCrash = true
    win.webContents.reload()
    return
  }
  const box = {
    type: 'error' as const,
    buttons: ['Close'],
    defaultId: 0,
    noLink: true,
    title: 'OL Premiere stopped',
    message: 'OL Premiere stopped working.',
    detail: 'Your work up to the last save is safe. Close it and open it again.',
  }
  // ⛔ NOTHING OF OURS MAY COVER THE BOX. While the app opens, the editor is hidden and
  // the opening card is ALWAYS ON TOP, so a box with no parent opened UNDER the card,
  // and 15 s later the boot backstop showed the dead editor maximized over it: a blank
  // editor, and an app that would not quit until he found the box. A page that dies on
  // every load (a GPU start crash, a bad store) is exactly when this box comes up, and
  // three deaths inside those 15 s is what that looks like. So the dead editor is never
  // revealed now (revealEditor, enterEditor), the cards go before the box, and the box
  // takes the editor as its parent only when the editor is really on his screen.
  // scripts/hidden-app/checks/crash-stop.cjs runs it.
  editorStopped = true
  if (bootBackstop) clearTimeout(bootBackstop)
  bootBackstop = null
  if (updateOpenTimer) clearTimeout(updateOpenTimer)
  updateOpenTimer = null
  for (const card of [splashWindow, updateWindow]) {
    if (card && !card.isDestroyed()) card.destroy()
  }
  const onScreen = win.isVisible() && !win.isMinimized()
  void (onScreen ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).finally(() => app.quit())
}

/**
 * A small window (the opening card, the update card) whose page died. It is frameless,
 * transparent and on top of everything with no close button, so a dead one would sit
 * over his screen as a frozen picture. It closes instead: the opening card's own
 * `closed` handler then opens the editor.
 */
function closeWhenGone(win: BrowserWindow, what: string): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting || win.isDestroyed()) return
    crashLog(crashLogLine(new Date(), `${what} page gone`, details, app.getVersion(), 'close'))
    win.close()
  })
}

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
/**
 * True when an update applied itself while he was away and the installer started us
 * (./launchMode). No card and no melon: the editor opens minimized on the taskbar.
 */
let quietStart = false
/** Where the editor opens (./windowState): his last screen, size and maximized state. */
let editorPlace: Placement | null = null

/** Work out where the editor opens. Once, before the first window, so the card can follow. */
function placeEditor(): Placement {
  editorPlace ??= restoreBounds(
    readWindowState(path.join(app.getPath('userData'), WINDOW_STATE_FILE)),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
  )
  return editorPlace
}

/** The middle of the given screen for a card, or Electron's own centring if it is gone. */
function cardPosition(displayId: number | undefined): { x: number; y: number } | { center: true } {
  const d = screen.getAllDisplays().find((x) => x.id === displayId)
  return d ? centreIn(d.workArea, SPLASH_WINDOW_W, SPLASH_WINDOW_H) : { center: true }
}

/**
 * Keep the editor's place as he moves and sizes it, a beat after he stops, and once
 * more as it closes. Not while hidden, minimized or full screen: none of those is a
 * place he would want it to open in.
 */
function keepWindowState(win: BrowserWindow): void {
  const file = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFullScreen()) return
    const bounds = win.getNormalBounds()
    writeWindowState(file, { bounds, maximized: win.isMaximized(), displayId: screen.getDisplayMatching(bounds).id })
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}

/** Read and remove the marker an unattended update left, and decide how to open. */
function readLaunchMode(): void {
  const file = path.join(app.getPath('userData'), QUIET_START_FILE)
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
    unlinkSync(file) // one start only, whatever it decides
  } catch {
    // no marker: an ordinary start
  }
  quietStart = launchMode({ argv: process.argv, markerAt: parseQuietMarker(text), now: Date.now() }) === 'quiet'
}

/**
 * Called as an update is applied. If he is away from the machine, leave the marker
 * that makes the new version start quietly (./launchMode).
 */
function markQuietStartIfAway(): void {
  if (!appliedWhileAway(powerMonitor.getSystemIdleTime())) return
  try {
    writeFileSync(path.join(app.getPath('userData'), QUIET_START_FILE), JSON.stringify({ at: Date.now() }))
  } catch {
    // worst case the new version opens the ordinary way
  }
}

/**
 * Put the editor on screen. Normally maximized and in front, the way he opens it. After
 * an update that applied while he was away it goes on the taskbar minimized instead,
 * without taking focus, and maximizes when he brings it up.
 */
function revealEditor(win: BrowserWindow): void {
  // A page that died for good is never put on screen, by any route (the editor's own
  // ready-to-show included): the "stopped" box is up instead. See onEditorGone.
  if (editorStopped) return
  const maximized = editorPlace?.maximized ?? true
  if (quietStart) {
    if (win.isVisible()) return
    win.once('restore', () => {
      if (maximized) win.maximize()
    })
    // On a hidden window this shows it minimized WITHOUT activating it.
    win.minimize()
    return
  }
  if (maximized) win.maximize()
  win.show()
}

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
    // On the screen the editor will open on, which is not always the main one.
    ...cardPosition(placeEditor().displayId),
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
  // The splash is the window he actually looks at while the app loads, so it is
  // the FIRST thing that has to say which app this is. See the editor window for
  // why the page does not get to override it.
  if (IS_LAB) {
    win.setTitle('OL Premiere Lab')
    win.on('page-title-updated', (e) => e.preventDefault())
  }
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
    if (!entered && !quitting) enterEditor()
  })
  closeWhenGone(win, 'opening card')
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
  // A page that died for good is never put on screen: the "stopped" box is up instead.
  if (entered || editorStopped) return
  entered = true
  bootFinished = true
  if (bootBackstop) clearTimeout(bootBackstop)
  bootBackstop = null
  const win = mainWindow
  if (win && !win.isDestroyed() && !win.isVisible()) revealEditor(win)
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
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send('update:status', status)
  if (status.kind === 'downloading') armUpdateWindow(status)
  // A terminal answer ends his click's authority. Without this the flag leaks into
  // the fifteen minute poll and a card opens over his timeline unbidden, which is
  // the exact thing the flag exists to prevent.
  if (status.kind === 'none' || status.kind === 'downloaded' || status.kind === 'error' || status.kind === 'pending') userAsked = false
}

/**
 * The update card: the same screen he opens the app with, while a version
 * downloads. His ask, 2026-08-24.
 *
 * ⛔ IT IS NOT `createSplash`. That function's `closed` handler calls
 * `enterEditor()` and its `ready-to-show` sends `boot:ready`, both of which are
 * exactly wrong here.
 */
let updateWindow: BrowserWindow | null = null
/** The updater's rules (./updateFlow). Only in a packaged build that is not the lab. */
let updateFlow: UpdateFlow | null = null
/** His melon click, and only his. Cleared by any terminal status. */
let userAsked = false
let updateOpenTimer: ReturnType<typeof setTimeout> | null = null

/** Every gate, in order, before a card is allowed over his editor. */
function armUpdateWindow(s: Extract<UpdateStatus, { kind: 'downloading' }>): void {
  if (updateWindow || updateOpenTimer) return
  // Never over the "stopped" box, which is the last thing the app shows.
  if (editorStopped) return
  // Never two frameless transparent always-on-top windows at once.
  if (!entered || splashWindow) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!userAsked && !UPDATE_SCREEN_UNBIDDEN) return
  if (s.percent >= UPDATE_SCREEN_MAX_PCT) return
  updateOpenTimer = setTimeout(() => {
    updateOpenTimer = null
    if (updateStatus.kind === 'downloading') createUpdateWindow()
  }, UPDATE_SCREEN_DELAY_MS)
}

function createUpdateWindow(): void {
  const win = new BrowserWindow({
    width: SPLASH_WINDOW_W,
    height: SPLASH_WINDOW_H,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Over the editor, on whichever screen he has it.
    ...cardPosition(mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()).id : undefined),
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  updateWindow = win
  if (IS_LAB) {
    win.setTitle('OL Premiere Lab')
    win.on('page-title-updated', (e) => e.preventDefault())
  }
  win.once('ready-to-show', () => {
    // So the first painted frame is true rather than an empty card.
    win.webContents.send('update:status', updateStatus)
    // Backstop: if the page never says it painted, show it anyway rather than
    // leaving an invisible always-on-top window holding a download nobody can see.
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
    }, 1500)
  })
  win.on('closed', () => {
    if (updateWindow === win) updateWindow = null
  })
  closeWhenGone(win, 'update card')
  void win.loadURL(isDev ? `${DEV_URL}/update.html` : `app://${APP_ORIGIN_HOST}/update.html`)
}

/**
 * `shrinkSplash` without the focus call.
 *
 * ⛔ THE UPDATE WINDOW NEVER TAKES FOCUS. The splash may, because nothing else is
 * on screen when it runs. This one opens over a timeline he is working in, and
 * stealing the keyboard mid-caption is worse than any amount of polish. The cost
 * is that Enter and Escape only reach the melon after he clicks the window, and
 * the melon is a mouse target anyway.
 */
function shrinkUpdate(): void {
  const win = updateWindow
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const half = Math.round(SPLASH_MELON_PX / 2)
  win.setResizable(true)
  win.setBounds({
    x: b.x + Math.round(b.width / 2) - half,
    y: b.y + Math.round(b.height / 2) - half,
    width: SPLASH_MELON_PX,
    height: SPLASH_MELON_PX,
  })
  win.setResizable(false)
  // The boot melon waits forever because nothing else is on screen. This one is
  // sitting on his timeline, and the update installs itself at the next start
  // either way, so it lets itself out.
  setTimeout(() => {
    if (updateWindow === win && !win.isDestroyed()) win.close()
  }, UPDATE_MELON_TIMEOUT_MS)
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

// Must run BEFORE app is ready. codeCache: V8 keeps the compiled pages in the profile,
// so a launch stops compiling the editor's JS from scratch (Chromium does that only for
// http(s) unless a scheme asks). Hashed file names mean a new version is a new entry.
// Hidden app, same profile, warm starts: the editor's page loaded about 40 to 100 ms
// sooner with it (medians 188 against 287 ms on a busy machine), and its workers gain too.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
])

function createWindow(): void {
  // Where he left it (./windowState), or the main screen the first time.
  const place = placeEditor()
  const win = new BrowserWindow({
    ...place.bounds,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#060709',
    show: false,
    autoHideMenuBar: true,
    // Named apart on the taskbar too, so a window on his screen is never a
    // question. See IS_LAB.
    title: IS_LAB ? 'OL Premiere Lab' : 'OL Premiere',
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
  // Again after creation: a window made on a screen with a different scale than the
  // main one can come out the wrong size, and setting it once more puts that right.
  win.setBounds(place.bounds)
  keepWindowState(win)
  // ⛔ AND THE PAGE DOES NOT GET TO ARGUE. The renderer sets `document.title`, and
  // Electron follows it, so the lab came up on the taskbar reading "OL Premiere"
  // like his real editor: two identical windows, one of them a bench copy, and no
  // way to tell them apart at a glance. Which window is which is the entire point
  // of building a second one.
  if (IS_LAB) win.on('page-title-updated', (e) => e.preventDefault())
  // The editor window stays HIDDEN until the boot finishes, so while the app loads
  // he sees the small card on his desktop and nothing else. It opens MAXIMIZED,
  // not fullscreen, because an editor still needs its title bar and the taskbar.
  win.once('ready-to-show', () => {
    // While a splash is up, the editor stays hidden even after the boot finishes:
    // the melon is a deliberate gate, and he is the one who opens it.
    if (entered || !splashWindow) revealEditor(win)
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

  // ⛔ A PREVIEW COPY OR A CONVERSION OUTLIVES THE PAGE THAT STARTED IT, because
  // both live in main. A reload leaves their temps on disk until the next app
  // start sweeps them, and a remux temp is a FULL SIZE copy of his source. It
  // would also leave the updater believing work is in flight that nothing can
  // ever ask for again. The page going away is the moment they are certainly
  // dead: this fires BEFORE the new page exists, so it can never take a job the
  // new one started.
  const dropOrphans = (): void => {
    void proxy.releaseAllProxies()
    void remux.releaseAllRemuxes()
    // A half written mirror copy is in the same boat, and its writer slot would
    // otherwise be pinned for the life of main, refusing that asset forever.
    void mediaStore.dropWriters()
    // And a project file he was saving to his own folder: its `.olpart` sits beside
    // his file, as big as the project, and no sweep ever looks there.
    void saveFiles.dropWrites()
    // And an export. The page feeds ffmpeg its frames, so with the page gone
    // ffmpeg would wait on its pipe forever, the half made file would stay,
    // and the updater would believe an export is running until the app quits.
    // A reload he chose over a running export (below) is exactly this.
    void native.cancel()
  }
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) dropOrphans()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    dropOrphans()
    onEditorGone(win, details)
  })

  // ⛔ LEAVING DURING AN EXPORT ASKS FIRST. The page refuses to unload while one
  // runs (src/state/unloadGuard.ts), and on its own that refusal is silent: the
  // window just stays open. That read fine while the export dialog covered the
  // editor and said why. Since 2026-09-28 the export runs behind his work, his
  // words: *"Make it so that while the video is exporting, I can work on other
  // videos too, because the export time is sometimes very long."* So a close
  // can now be refused with nothing on screen to explain it, and it looks like
  // a broken window. Asking turns the refusal into his choice. A reload lands
  // here too, which is why the words fit both.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep exporting', 'Stop the export'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Still exporting',
      message: 'A video is still exporting.',
      detail: 'If you leave now, the export stops and the video will not be finished.',
    })
    // Here preventDefault means "overrule the page": the close goes ahead.
    if (choice === 1) e.preventDefault()
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

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  const action = secondInstanceAction({ hasWindow: !!win, quittingToInstall })
  // See ./launchMode: the settle still runs in full, it only ends in a relaunch.
  if (action === 'install-and-open') openAfterInstall = true
  if (action !== 'focus' || !win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  // A second copy never gets here (exit above), but if it ever did, it must not sweep
  // the first copy's temps or open windows on its profile.
  if (!singleInstance) return
  // The main process's diary (./mainLog): a packaged build has no console to read.
  setMainLogFile(path.join(app.getPath('logs'), MAIN_LOG_NAME))
  // No application menu at all. The bar was hidden, but Electron's default menu
  // stayed live behind it, so Ctrl+W (Close Window) quit the whole app from a
  // browser habit, and Ctrl+R reloaded the editor under an edit. The app's own
  // keymap owns every shortcut; text fields keep native copy and paste.
  Menu.setApplicationMenu(null)
  // A transcode that died mid-flight leaves its temp behind forever, because the
  // only cleanup is a finally that a killed process never reaches. One of his was
  // 427 MB. Fire and forget: tidying up must never delay the window.
  void proxy.sweepProxyTemps()
  // Same reason, and the stakes are higher: a remux temp is a FULL SIZE copy of
  // his source, not a downscaled preview, so one abandoned run is gigabytes.
  void remux.sweepRemuxTemps()
  // Half written media mirrors from a run that died.
  void mediaStore.sweepMediaTemps()

  // Serve the built renderer from out/renderer over app://. Read with the
  // asar-aware fs and set Content-Type ourselves so module workers + wasm load.
  // His Apple emoji (electron/emojiFont.ts): fetched onto this computer the
  // first time a title asks for it, never shipped inside the app.
  const emojiFont = createEmojiFontStore({
    dir: path.join(app.getPath('userData'), 'fonts'),
    download: (url) => downloadBytes(url, (u) => net.fetch(u)),
  })
  // Fetched once, quietly, a little after launch, so the first emoji he pastes is
  // already Apple's instead of waiting on a download. A failure is retried the
  // next time a title asks for it.
  setTimeout(() => void emojiFont.path().catch(() => undefined), 30_000)
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    if (url.pathname === EMOJI_ROUTE) {
      try {
        // Streamed off his disk in 4 MB pieces, never held whole in main: the face is
        // 66 MB and every page or worker that draws an emoji asks for it. Read whole it
        // was three copies of it at once; the hidden app's emoji check timed both the
        // same within noise.
        const font = Readable.toWeb(createReadStream(await emojiFont.path(), { highWaterMark: 4 << 20 })) as ReadableStream<Uint8Array>
        return new Response(font, { headers: { 'content-type': 'font/ttf' } })
      } catch (err) {
        mainLog('warn', 'OL Premiere: the Apple emoji font could not be fetched', err)
        return new Response('Not available', { status: 503 })
      }
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const filePath = path.join(RENDERER_DIST, rel)
    // Path-traversal guard: never serve outside the renderer dir.
    if (filePath !== RENDERER_DIST && !filePath.startsWith(RENDERER_DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      // Handed over as read: a Uint8Array copy of it first was a second copy of every
      // file the pages load (the editor's main chunk alone is 2.4 MB).
      return new Response(await readFile(filePath), { headers: { 'content-type': mimeFor(filePath) } })
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
  // Asked once by each new editor page: was it loaded because the last one crashed?
  ipcMain.handle('app:takeCrashRecovered', () => {
    const was = recoveredFromCrash
    recoveredFromCrash = false
    return was
  })
  // The GPU process and the rest. Chromium brings a GPU process back by itself, but
  // why it died is exactly what a "the preview went black" hunt needs.
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    crashLog(crashLogLine(new Date(), 'child process gone', details, app.getVersion()))
  })

  // Native ffmpeg export.
  ipcMain.handle('native:probe', () => native.probe())
  ipcMain.handle('native:prepareAudio', async (_e, wav: ArrayBuffer) => {
    await native.prepareAudio(wav)
    return { ok: true }
  })
  ipcMain.handle('native:start', (_e, config: NativeExportConfig) => {
    if (!mainWindow) return { started: false, error: 'no window' }
    // ⛔ The movie goes only where he picked in MAIN's save dialog. ffmpeg writes with
    // -y, so a destination the page could simply name would let page code overwrite any
    // file on his PC. The page may hand back the answer that dialog gave (it asks before
    // making the sound), and nothing else: see ./exportChoice. Anything else is dropped
    // and the export asks him itself.
    return native.start({ ...config, outPath: exportPathFromPage(config.outPath) }, mainWindow)
  })
  ipcMain.handle('native:writeFrame', async (_e, frame: ArrayBuffer) => {
    try {
      await native.writeFrame(frame)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('native:finish', async () => {
    const done = await native.finish()
    // A finished movie spends his answer: the next export asks again.
    if (done.ok) exportPathUsed(done.outPath)
    return done
  })
  ipcMain.handle('native:cancel', () => native.cancel())

  // A preview copy is an optimisation, never a requirement: a failure here is
  // logged and swallowed so an odd file cannot stop it being imported or edited.
  // The media mirror: his footage as real files, so a rebuilt database cannot
  // orphan it again. See electron/mediaStore.ts for why this exists at all.
  ipcMain.handle('media:list', () => mediaStore.listMedia())
  ipcMain.handle('media:begin', (_e, id: string) => mediaStore.beginMedia(id))
  ipcMain.handle('media:chunk', (_e, id: string, bytes: ArrayBuffer) => mediaStore.chunkMedia(id, bytes))
  ipcMain.handle('media:finish', (_e, id: string) => mediaStore.finishMedia(id))
  ipcMain.handle('media:cancel', (_e, id: string) => mediaStore.cancelMedia(id))
  ipcMain.handle('media:read', (_e, id: string, offset: number, length: number) => mediaStore.readMedia(id, offset, length))
  ipcMain.handle('media:delete', (_e, id: string) => mediaStore.deleteMedia(id))

  ipcMain.handle('proxy:begin', () => proxy.beginProxy())
  ipcMain.handle('proxy:chunk', (_e, id: string, bytes: ArrayBuffer) => proxy.chunkProxy(id, bytes))
  ipcMain.handle('proxy:release', (_e, id: string) => proxy.releaseProxy(id))
  ipcMain.handle('proxy:finish', async (_e, id: string) => {
    try {
      return await proxy.finishProxy(id)
    } catch (err) {
      mainLog('warn', 'OL Premiere: preview copy failed, preview will use the original', err)
      return null
    }
  })
  // The copy is read back a chunk at a time, like a remux. See proxy.ts: his own
  // footage makes a 423 MB preview copy, so the whole-buffer hand back this used
  // to do was four live copies of it at once.
  ipcMain.handle('proxy:read', (_e, id: string, offset: number, length: number) => proxy.readProxy(id, offset, length))

  // ⛔ A conversion is NOT optional the way a preview copy is. Without it his
  // .mkv cannot be imported at all, so a failure here must reach the renderer
  // with its reason attached and be reported, never swallowed into a null the
  // way `proxy:finish` is.
  ipcMain.handle('remux:begin', () => remux.beginRemux())
  ipcMain.handle('remux:chunk', (_e, id: string, bytes: ArrayBuffer) => remux.chunkRemux(id, bytes))
  // A conversion that re-encodes (an HDR phone clip, a rescue) takes real time,
  // so it says how far it has got. Sent to the page that asked, by job id.
  ipcMain.handle('remux:finish', (e, id: string, mode?: 'convert' | 'rescue' | 'sdr') =>
    remux.finishRemux(id, mode, (frac) => {
      if (!e.sender.isDestroyed()) e.sender.send('remux:progress', id, frac)
    }),
  )
  ipcMain.handle('remux:read', (_e, id: string, offset: number, length: number) =>
    remux.readRemux(id, offset, length),
  )
  ipcMain.handle('remux:release', (_e, id: string) => remux.releaseRemux(id))

  // The file he just exported, selected in Explorer. The path comes back from
  // the export itself; here it is only opened in the shell, never read, and
  // only when it is a finished movie that exists.
  ipcMain.handle('export:reveal', (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !/\.(mp4|mov)$/i.test(filePath) || !existsSync(filePath)) return
    shell.showItemInFolder(filePath)
  })

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

  // --- Project files ----------------------------------------------------------
  // One file per project, current on every save. See electron/projectFiles.ts
  // for why the browser store stopped being the only copy.
  ipcMain.handle('project:write', (_e, id: string, projectName: string, json: string) =>
    projectFiles.writeProjectFile(id, projectName, json),
  )
  ipcMain.handle('project:list', () => projectFiles.listProjectFiles())
  ipcMain.handle('project:read', async (_e, filePath: string) => {
    // Same guard as backup:read, same reason: main reads back only what it wrote.
    if (!projectFiles.isProjectFilePath(filePath)) throw new Error('Refused: not a project file')
    return readFile(filePath, 'utf8')
  })
  ipcMain.handle('project:trash', (_e, id: string) => projectFiles.trashProjectFile(id))
  ipcMain.handle('project:dir', () => projectFiles.projectDir())
  // The Library's records beside them, one fixed file. See electron/libraryFile.ts.
  ipcMain.handle('library:write', (_e, json: string) => libraryFile.writeLibraryFile(json))
  ipcMain.handle('library:read', () => libraryFile.readLibraryFile())
  // His caption styles beside them, one fixed file. See electron/captionStylesFile.ts.
  ipcMain.handle('captionStyles:write', (_e, json: string) => captionStylesFile.writeCaptionStylesFile(json))
  ipcMain.handle('captionStyles:read', () => captionStylesFile.readCaptionStylesFile())

  // --- The private usage log (electron/usageFiles.ts) ----------------------------
  // His own record of what he uses, one file a day in the app's own data folder.
  // It lives in userData, so a throwaway profile gets its own and never his.
  const usageDir = (): string => path.join(app.getPath('userData'), 'Usage log')
  ipcMain.handle('usage:append', (_e, day: string, lines: string) => usageFiles.appendUsage(usageDir(), day, lines))
  ipcMain.handle('usage:dir', () => usageDir())
  ipcMain.handle('usage:reveal', async () => {
    await mkdir(usageDir(), { recursive: true }) // opening a folder that does not exist just fails silently
    await shell.openPath(usageDir())
  })
  void usageFiles.pruneUsage(usageDir(), usageFiles.localDay(new Date())).catch(() => undefined)

  // --- Files he saves himself (saveFiles.ts) ---------------------------------
  // A numbered name in his last folder, then the bytes streamed in chunks, and
  // only ever to the path he picked in that dialog.
  ipcMain.handle('file:pickSave', (e, kind: saveFiles.SaveKind, base: string, ext: string, filterName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    return saveFiles.pickSavePath(win, kind, base, ext, filterName)
  })
  ipcMain.handle('file:openWrite', (_e, target: string) => saveFiles.openForWrite(target))
  ipcMain.handle('file:writeChunk', (_e, id: number, chunk: ArrayBuffer) => saveFiles.writeChunk(id, chunk))
  ipcMain.handle('file:close', (_e, id: number, ok: boolean) => saveFiles.closeWrite(id, ok))

  // --- A pasted picture, cut out by CutStudio (electron/cutstudio.ts) ---------
  // His words, 2026-09-28: *"When I paste something, I can select, when pasting
  // it, to remove the background automatically."* Only picture bytes are passed
  // on, and only to CutStudio on this computer.
  const cutstudio = createCutstudio(realCutstudioDeps(app.getPath('desktop')))
  ipcMain.handle('cutstudio:removeBackground', (_e, bytes: unknown, mime: unknown) => {
    const isBytes = bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)
    if (!isBytes || typeof mime !== 'string' || !mime.startsWith('image/')) {
      return { ok: false, reason: 'failed', detail: 'that is not a picture' }
    }
    return cutstudio.removeBackground(bytes, mime)
  })

  // Whatever ends the app (user quit, or an auto-update install), never leave a
  // native ffmpeg child orphaned or its temp files behind. before-quit can't await,
  // so use the synchronous teardown (SIGKILL + unlinkSync) rather than the async
  // cancel() whose unlink would race the process exit.
  app.on('before-quit', () => {
    quitting = true
    native.cancelSync()
    // And the preview copies: a proxy build that outlived the app kept its
    // ffmpeg running to the end, holding a temp file open that the sweep could
    // not delete.
    proxy.killAllProxyChildren()
    // And a conversion, for the same reason: it is a full size copy of his source.
    remux.killAllRemuxChildren()
    // And a project file still being written to his folder.
    saveFiles.dropWritesSync()
    // And CutStudio's server, when this app is the one that started it. One he
    // started himself stays running.
    cutstudio.stop()
  })

  // Splash FIRST, so it is on screen while the editor window loads behind it. Not
  // after an update that applied itself while he was away: see ./launchMode.
  readLaunchMode()
  if (!quietStart) createSplash()
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

  // The update card. Every one guarded on the SENDER, the way boot:shrink is: any
  // other renderer asking to shrink or quit this window is not this window.
  ipcMain.on('update:show', (e) => {
    if (e.sender === updateWindow?.webContents) updateWindow?.showInactive()
  })
  ipcMain.on('update:shrink', (e) => {
    if (e.sender === updateWindow?.webContents) shrinkUpdate()
  })
  ipcMain.on('update:dismiss', (e) => {
    if (e.sender === updateWindow?.webContents) updateWindow?.close()
  })
  ipcMain.on('update:apply', (e) => {
    if (e.sender !== updateWindow?.webContents) return
    // ⛔ NOT quitAndInstall. This goes through the renderer's own decision, which
    // refuses to restart through an in-flight export and flushes a save first.
    const v = 'version' in updateStatus ? updateStatus.version : ''
    mainWindow?.webContents.send('update:autoApply', v)
    // The fruit bursts over the restart, the same beat the splash melon plays.
    setTimeout(() => updateWindow?.close(), SPLASH_MELON_POP_MS)
  })

  // Auto-update: on a packaged build, check GitHub Releases (electron-builder.yml
  // `publish`) and download a newer version in the background. A failed check
  // (offline / no release) logs and is ignored. We re-check every 15 minutes so
  // an app left open still gets a release the same day it ships.
  //
  // APPLY POLICY, his pick 2026-09-27: "Only when I close it". A downloaded
  // update goes on when he closes the app (autoInstallOnAppQuit, with the same
  // settle as a restart, see window-all-closed) or once he has been away from
  // the machine for five minutes (./updateApply). It NEVER applies because the
  // app has just been opened: until 2026-09-27 it did, inside a three minute
  // window after launch, and opening the app meant watching it restart into a
  // patch. The "Restart to update" toast stays as his own shortcut. After an
  // update the renderer shows a "Updated to vX" toast and the always-on version
  // tag confirms exactly which build is running (App.tsx / TopBar).
  // The updater's state, kept here so the renderer can ASK as well as listen. The
  // loading card narrates this check as one of its rows, and it mounts a beat after
  // the check starts. Without a pull, a fast answer would land before anyone was
  // listening and the row would claim to still be checking.
  // ⛔ THE RENDERER CANNOT SEE THIS. navigator.deviceMemory is capped at 8 GB by
  // the spec and reports TOTAL, not free, so on his 32 GB machine it says 8 and
  // on a 4 GB one it says 4. Measured 2026-08-24 with the app closed: 7.6 GB
  // available and a commit charge of 47 GB against 31.7 GB of RAM, which is a
  // machine already paging. The caches were taking 960 MB of that on a constant.
  ipcMain.handle('system:memory', () => {
    const m = process.getSystemMemoryInfo()
    return { totalKb: m.total, freeKb: m.free }
  })

  ipcMain.handle('update:status:get', () => updateStatus)

  // The reload button's half of the job. Lives in MAIN because main outlives the
  // renderer's reload, so the check it starts is not cancelled a moment later.
  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) return
    // ⛔ THE FLAG IS SET BEFORE EVERY EARLY RETURN, AND IT USED TO BE SET AFTER
    // ONE, 2026-08-24. His words: *"clicking the melon doesn't really update the
    // app. There's still no updating animation."*
    //
    // `autoDownload` is on, so a version is usually ALREADY arriving by the time
    // he clicks. The guard below returned before this line, so `userAsked` stayed
    // false, `armUpdateWindow` refused (it needs his click while
    // UPDATE_SCREEN_UNBIDDEN is false), and the melon did nothing he could see:
    // no reload, because `reloadAndCheckForUpdates` refuses to reload on top of a
    // found update, and no card, because the click never registered. The one
    // moment he asks to be shown something was the one moment nothing could be.
    userAsked = true
    // Re-finding a file that is already arriving would write {checking} over the
    // percent and blank the card mid-download. But his click still has to be
    // ANSWERED, so the card is armed off the status that is already live.
    if (updateStatus.kind === 'downloading') {
      armUpdateWindow(updateStatus)
      return
    }
    // Already sitting on disk waiting for a restart: there is no download left to
    // animate, and the honest answer is the card in its finished state rather
    // than silence. `update.html` reads the same status feed, so it opens on
    // "ready" and the melon pops.
    if (updateStatus.kind === 'downloaded') {
      if (!updateWindow && !updateOpenTimer && entered && !splashWindow && mainWindow && !mainWindow.isDestroyed()) {
        createUpdateWindow()
      }
      return
    }
    updateFlow?.check()
  })

  // What the RENDERER says it is doing, because main cannot see it: an export
  // that runs in the browser engine, a live microphone, a take he has not kept.
  // Any of them makes an automatic relaunch destructive.
  let rendererBusy = false
  ipcMain.on('update:busy', (_e, on: boolean) => {
    rendererBusy = !!on
  })

  // ⛔ NOT IN THE LAB. It is built from the bench, so the shipped release is
  // usually OLDER than what it is running, and letting it update would quietly
  // replace the thing under test with the thing it was being tested against.
  if (app.isPackaged && !IS_LAB) {
    // The rules live in ./updateFlow, where they are run in tests rather than read.
    // The busy list is main's to know: an export, a preview copy or a conversion
    // mid flight would be truncated by a restart, and the renderer reports its own
    // (an in-browser export, a live microphone, a take not yet kept).
    updateFlow = startUpdateFlow({
      updater: autoUpdater,
      getStatus: () => updateStatus,
      setStatus: setUpdateStatus,
      send: (channel, arg) => mainWindow?.webContents.send(channel, arg),
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      busy: () => rendererBusy || native.isExporting() || proxy.proxyBusy() || remux.remuxBusy(),
      log: (entry) => appendUpdateLog(path.join(app.getPath('logs'), UPDATE_LOG_NAME), entry),
      quiet: fileQuietStore(path.join(app.getPath('userData'), 'update-quiet-since.json')),
      logger: mainLogger,
    })
    // Apply from the toast (and the renderer's save-then-restart path): quit and
    // relaunch into the downloaded version.
    //
    // Both arguments matter and neither is the default. Silent runs the installer
    // with /S, so nothing is put in front of him; force-run-after starts the new
    // version once it lands, so the app he was using comes back on its own. With
    // the defaults, updating meant an installer window and a Finish button, which
    // is the thing he asked to be rid of.
    //
    // ⛔ THE WINDOW CLOSES FIRST, AND THE INSTALLER IS NOT SPAWNED UNTIL IT HAS.
    // quitAndInstall starts the installer and quits in the same breath, and the
    // installer gives a running app a few seconds before it kills it. The
    // browser engine closes its databases during that quit. A kill that lands
    // inside that close leaves a half written database, and the engine's answer
    // to a half written database is to throw it away and start a new one. That
    // is the leading explanation for the four times his projects vanished
    // (2026-07-26, 08-19, 08-23, and once between 08-24 and 09-12), each one on
    // or near an update. It is not proven from here. What is certain is that a
    // window that has already closed has no database open to be killed.
    //
    // So: close the window, wait for it to be gone, give the engine a moment to
    // finish writing, and only then install. If the window will not close (an
    // export he chose to restart through anyway), fall back to the old path
    // after five seconds rather than leave the update stuck.
    ipcMain.on('update:install', () => {
      markQuietStartIfAway()
      const win = mainWindow
      if (!win || win.isDestroyed()) {
        autoUpdater.quitAndInstall(true, true)
        return
      }
      installing = true
      let done = false
      const go = (): void => {
        if (done) return
        done = true
        autoUpdater.quitAndInstall(true, true)
      }
      win.once('closed', () => setTimeout(go, INSTALL_FLUSH_MS))
      setTimeout(go, INSTALL_CLOSE_TIMEOUT_MS)
      win.close()
    })
  }
})

app.on('window-all-closed', () => {
  // An update install closes the window itself and quits through quitAndInstall,
  // which relaunches the app afterwards. A plain quit here would install too
  // (autoInstallOnAppQuit) but would NOT bring the app back.
  if (installing) return
  if (process.platform === 'darwin') return
  // ⛔ CLOSING IS THE MAIN WAY AN UPDATE GOES ON NOW (his pick 2026-09-27), so it
  // gets the restart path's settle. The installer is started on quit and gives a
  // running app a few seconds before it kills it; a kill inside the engine's
  // database close is the leading suspect for his vanished projects. The window
  // is already gone here, so waiting the same beat before quitting means the
  // installer starts on an engine that has finished writing.
  if (updateStatus.kind === 'downloaded' && app.isPackaged && !IS_LAB) {
    quittingToInstall = true
    // His click on the icon in the meantime means "open it again": install the same
    // way, silently, and start the new version after.
    setTimeout(() => (openAfterInstall ? autoUpdater.quitAndInstall(true, true) : app.quit()), INSTALL_FLUSH_MS)
    return
  }
  app.quit()
})
