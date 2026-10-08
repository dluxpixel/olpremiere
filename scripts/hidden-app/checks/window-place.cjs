// The editor must open where he left it (electron/windowState.ts): those bounds, NOT
// maximized when it was not, and the opening card in the middle of that same screen.
// Run with a saved place seeded into the profile, a file holding
//   {"bounds":{"x":100,"y":80,"width":1200,"height":760},"maximized":false}
//   node scripts/hidden-app/run.mjs scripts/hidden-app/checks/window-place.cjs --seed window-state.json=<that file>
const { BrowserWindow, screen } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WANT = { x: 100, y: 80, width: 1200, height: 760 }

module.exports = async ({ wc, log }) => {
  const js = (code) => wc.executeJavaScript(code)
  const t = Date.now()
  while (!(await js(`!!document.querySelector('[data-testid=open-projects]')`).catch(() => false))) {
    if (Date.now() - t > 60000) throw new Error('timed out waiting for the editor')
    await sleep(300)
  }
  const editor = BrowserWindow.fromWebContents(wc)
  // The opening card is still up (nobody clicks the melon here): it must be centred on
  // the editor's screen.
  const splash = BrowserWindow.getAllWindows().find((w) => w !== editor && /splash\.html/.test(w.webContents.getURL()))
  const sb = splash && !splash.isDestroyed() ? splash.getBounds() : null
  // Reveal the editor the way the melon does, then look at what it was asked to do.
  require('electron').ipcMain.emit('boot:enter')
  await sleep(500)
  const bounds = editor.getBounds()
  const calls = global.__olpWindowCalls.filter((c) => c.id === editor.id).map((c) => c.m)
  const wa = screen.getDisplayMatching(WANT).workArea
  log('editor bounds:', JSON.stringify(bounds), 'calls:', JSON.stringify(calls), 'splash:', JSON.stringify(sb), 'workArea:', JSON.stringify(wa))
  if (JSON.stringify(bounds) !== JSON.stringify(WANT)) throw new Error('the editor did not open where it was left: ' + JSON.stringify(bounds))
  if (calls.includes('maximize')) throw new Error('the editor was maximized although he left it not maximized')
  if (!calls.includes('show')) throw new Error('the editor was never shown')
  if (sb) {
    const cx = sb.x + sb.width / 2
    const cy = sb.y + sb.height / 2
    if (Math.abs(cx - (wa.x + wa.width / 2)) > 2 || Math.abs(cy - (wa.y + wa.height / 2)) > 2) {
      throw new Error('the opening card is not centred on the editor screen')
    }
  }
  return { bounds, calls, splash: sb }
}
