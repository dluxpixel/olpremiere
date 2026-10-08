// Kills the editor's page three times in a row while the app is still opening, the
// way a page that dies on every load does (a GPU start crash, a bad store). The third
// death stops reloading and shows "OL Premiere stopped" (electron/crashPlan.ts).
//
// ⛔ THAT BOX HAS TO BE THE THING ON TOP. The opening card is always on top and the
// editor is hidden behind it, so a box with no parent opened UNDER the card, and 15 s
// later the boot backstop showed the dead editor maximized over it. He saw a blank
// editor and the app would not quit until he found the box. This check holds the box
// open (it never answers) and asks: what of ours was still on top when it opened, and
// did anything put the dead editor on screen afterwards?
const { BrowserWindow, dialog, ipcMain } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ wc, log }) => {
  const editorId = BrowserWindow.fromWebContents(wc).id
  let bootFinished = false
  ipcMain.on('boot:finished', () => {
    bootFinished = true
  })

  let box = null
  const boxShown = new Promise((resolve) => {
    dialog.showMessageBox = (...args) => {
      const parent = args[0] instanceof BrowserWindow ? args[0] : null
      const opts = parent ? args[1] : args[0]
      const alive = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      box = {
        title: opts && opts.title,
        parent: parent ? (parent.id === editorId ? 'editor' : parent.webContents.getURL()) : null,
        // The cards still there when the box opens, and anything of ours on top of all.
        // (A window this harness never shows does not report always on top, so the first
        // is the one that can fail here.)
        cards: alive.map((w) => w.webContents.getURL()).filter((u) => /(splash|update)\.html/.test(u)),
        onTop: alive.filter((w) => w.isAlwaysOnTop()).map((w) => w.webContents.getURL()),
        callsBefore: global.__olpWindowCalls.length,
        bootFinished,
      }
      resolve()
      // He has not answered yet: the app stays up for the rest of the check.
      return new Promise(() => {})
    }
  })

  // Three deaths, each as soon as the page has loaded, before its boot can report.
  for (let i = 1; i <= 3; i++) {
    const reloaded = i < 3 ? new Promise((r) => wc.once('did-finish-load', r)) : null
    const gone = new Promise((r) => wc.once('render-process-gone', (_e, d) => r(d.reason)))
    wc.forcefullyCrashRenderer()
    log(`death ${i}:`, await Promise.race([gone, sleep(10000).then(() => 'no gone event')]))
    if (reloaded && !(await Promise.race([reloaded.then(() => true), sleep(30000).then(() => false)]))) {
      throw new Error(`the page was not loaded again after death ${i}`)
    }
  }
  if (!(await Promise.race([boxShown.then(() => true), sleep(10000).then(() => false)]))) {
    throw new Error('the third death did not show "OL Premiere stopped"')
  }

  // Past the 15 s boot backstop, counted from when the editor window was made.
  await sleep(17000)
  const after = global.__olpWindowCalls.slice(box.callsBefore).filter((c) => c.id === editorId).map((c) => c.m)
  log('box:', JSON.stringify(box), 'editor calls after it:', JSON.stringify(after))
  if (box.title !== 'OL Premiere stopped') throw new Error(`unexpected box: ${box.title}`)
  if (box.cards.length) throw new Error(`the box opened with the always on top card still up: ${box.cards.join(', ')}`)
  if (box.onTop.length) throw new Error(`the box opened under a window that is always on top: ${box.onTop.join(', ')}`)
  for (const loud of ['show', 'maximize', 'focus', 'minimize']) {
    if (after.includes(loud)) throw new Error(`the dead editor was put on screen over the box (${loud})`)
  }
  return { box, after }
}
