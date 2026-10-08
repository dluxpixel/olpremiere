// Run with --quiet-update-start. An update that applied itself while he was away must
// start the new version quietly (electron/launchMode.ts): no opening card, and the
// editor minimized on the taskbar, never shown or maximized in front of him. What this
// cannot see is whether Windows activates that minimize: minimize() is stubbed here
// (see the note in electron/main.ts revealEditor).
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ wc, root, log }) => {
  const js = (code) => wc.executeJavaScript(code)
  const t = Date.now()
  while (!(await js(`!!document.querySelector('[data-testid=open-projects]')`).catch(() => false))) {
    if (Date.now() - t > 60000) throw new Error('timed out waiting for the editor')
    await sleep(300)
  }
  // Long enough for the boot to report and any reveal to have run.
  await sleep(3000)
  const loaded = fs.readFileSync(path.join(root, 'log.txt'), 'utf8')
  const splash = /loaded \S*splash\.html/.test(loaded)
  const editorId = BrowserWindow.fromWebContents(wc).id
  const calls = global.__olpWindowCalls.filter((c) => c.id === editorId).map((c) => c.m)
  const marker = fs.existsSync(path.join(app.getPath('userData'), 'quiet-start.json'))
  log('editor window calls:', JSON.stringify(calls), 'splash:', splash, 'marker left:', marker)
  if (splash) throw new Error('the opening card was shown on a quiet start')
  if (!calls.includes('minimize')) throw new Error('the editor was not put on the taskbar')
  for (const loud of ['show', 'maximize', 'focus']) {
    if (calls.includes(loud)) throw new Error(`the editor called ${loud}() on a quiet start`)
  }
  if (marker) throw new Error('the marker was left behind for the next start')
  return { calls, splash, marker }
}
