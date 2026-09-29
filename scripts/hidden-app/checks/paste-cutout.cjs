// Pastes a picture (a red disc on white) with a SYNTHETIC paste event, never
// the real clipboard, picks "Remove background", and waits for the cut out clip
// on the timeline. Needs CutStudio: set OLP_CUTSTUDIO to its cutstudio.exe (the
// throwaway profile moves the Desktop, so the working copy is not found alone).
const fs = require('fs')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ wc, root, log }) => {
  const js = (code) => wc.executeJavaScript(code)
  const waitFor = async (cond, ms, what) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const v = await js(cond)
      if (v) return v
      await sleep(300)
    }
    throw new Error('timed out waiting for ' + what)
  }
  await waitFor(`!!document.querySelector('[data-testid=add-title]')`, 60000, 'the editor')
  await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 240)
    x.fillStyle = '#d22'; x.beginPath(); x.arc(160, 120, 70, 0, Math.PI * 2); x.fill()
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor(`!!document.querySelector('[data-testid=paste-picture-dialog]')`, 5000, 'the paste dialog')
  const t0 = Date.now()
  await js(`document.querySelector('[data-testid=paste-picture-remove]').click()`)
  const outcome = await waitFor(`(() => {
    const p = document.querySelector('[data-testid=paste-picture-problem]')
    if (p && p.innerText.trim()) return 'problem: ' + p.innerText.trim()
    return document.querySelector('[data-testid=paste-picture-dialog]') ? '' : 'closed'
  })()`, 150000, 'CutStudio')
  log('outcome', outcome, 'after', Date.now() - t0, 'ms')
  if (outcome !== 'closed') throw new Error(outcome)
  await waitFor(`document.querySelectorAll('[data-clip-kind]').length > 0`, 30000, 'the clip on the timeline')
  await sleep(2500)
  fs.writeFileSync(path.join(root, 'after-paste.png'), (await wc.capturePage()).toPNG())
  return { outcome, ms: Date.now() - t0 }
}
