// Runs the REAL built app (out/, from `npm run build:electron`) with no window on
// his screen and a throwaway profile, then hands the editor to one check script.
// Started by ../run.mjs, which sets the three OLP_HIDDEN_* variables below.
//
// ⛔ WHY A WRAPPER APP. NODE_OPTIONS --require cannot patch Electron first:
// `electron` is not requirable there. So this is the app Electron starts, and it
// imports the real main process only after the patches are in place.
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { app, BrowserWindow, dialog } = require('electron')

const REPO = path.resolve(__dirname, '..', '..', '..')
const root = process.env.OLP_HIDDEN_DIR
if (!root) throw new Error('OLP_HIDDEN_DIR is missing: start this through scripts/hidden-app/run.mjs')
const log = (...a) => fs.appendFileSync(path.join(root, 'log.txt'), a.map(String).join(' ') + '\n')

// Every folder the app writes to moves under the throwaway folder: his projects
// live in Documents and his media in AppData, and none of it may be touched.
for (const k of ['userData', 'appData', 'documents', 'desktop', 'videos', 'downloads']) {
  const d = path.join(root, k)
  fs.mkdirSync(d, { recursive: true })
  app.setPath(k, d)
}
// ffmpeg and the rest are found from the app path, which must be the repo.
app.getAppPath = () => REPO

// No window ever reaches his screen: every way a window shows is a no-op.
for (const m of ['show', 'showInactive', 'focus', 'maximize', 'restore', 'setFullScreen', 'moveTop', 'flashFrame']) {
  BrowserWindow.prototype[m] = function () {}
}
app.on('browser-window-created', (_e, w) => {
  w.setSkipTaskbar(true)
  // A hidden window is throttled like a background tab; the app must run at speed.
  w.webContents.setBackgroundThrottling(false)
})

// Every dialog answers itself. A save goes into the throwaway folder.
const exportPath = path.join(root, 'export.mp4')
dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
dialog.showSaveDialogSync = () => exportPath
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
dialog.showMessageBoxSync = () => 0
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showOpenDialogSync = () => undefined
dialog.showErrorBox = (title, content) => log('errorBox', title, content)

const check = process.env.OLP_HIDDEN_CHECK
let started = false
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => {
    const m = ev.message ?? ''
    if (/error|fail|emoji/i.test(m)) log('console:', m.slice(0, 300))
  })
  wc.on('did-finish-load', async () => {
    const url = wc.getURL()
    log('loaded', url)
    if (started || !check || !/\/index\.html$|olpremiere(lab)?\/$/.test(url)) return
    started = true
    const t0 = Date.now()
    let out
    try {
      out = { ok: true, result: await require(check)({ wc, root, log, exportPath, repo: REPO }) }
    } catch (err) {
      out = { ok: false, error: String((err && err.stack) || err) }
    }
    out.ms = Date.now() - t0
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(out, null, 1))
    // ⚠️ exit() skips before-quit, so anything the app started (CutStudio's
    // server) is not stopped by it. run.mjs lists what is left over.
    app.exit(0)
  })
})
setTimeout(() => {
  log('timed out')
  app.exit(3)
}, Number(process.env.OLP_HIDDEN_TIMEOUT_MS || 300000))

import(pathToFileURL(path.join(REPO, 'out', 'main', 'main.js')).href).catch((err) => {
  log('the app failed to load', (err && err.stack) || err)
  app.exit(4)
})
