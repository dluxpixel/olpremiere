// Adds a title with emoji, captures the editor, exports in the background and
// grabs one frame of the file. Proves: Apple emoji in the preview AND the
// export, and the background export (the "Keep working" chip) end to end.
// Run with --keep and look at preview.png and export-frame.png.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const TEXT = process.env.OLP_HIDDEN_TITLE || 'Big W 😂🔥💀 👍🏽👨‍👩‍👧🇨🇿'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ wc, root, log, exportPath, repo }) => {
  const js = (code) => wc.executeJavaScript(code)
  const waitFor = async (cond, ms, what) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (await js(cond)) return
      await sleep(250)
    }
    throw new Error('timed out waiting for ' + what)
  }
  await waitFor(`!!document.querySelector('[data-testid=add-title]')`, 60000, 'the editor')
  await js(`document.querySelector('[data-testid=add-title]').click()`)
  await waitFor(`!!document.querySelector('[data-testid=title-text]')`, 10000, 'the title text box')
  // React only hears a value set through the native setter plus an input event.
  await js(`(() => {
    const ta = document.querySelector('[data-testid=title-text]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(TEXT)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(4000)
  fs.writeFileSync(path.join(root, 'preview.png'), (await wc.capturePage()).toPNG())

  await js(`document.querySelector('[data-testid=export-open]').click()`)
  const t0 = Date.now()
  let sawChip = false
  for (;;) {
    if (Date.now() - t0 > 180000) throw new Error('the export did not finish')
    const s = await js(`({
      keep: !!document.querySelector('[data-testid=export-keep-working]'),
      chip: !!document.querySelector('[data-testid=export-chip]'),
      text: (document.querySelector('[data-testid=export-dialog]') || {}).innerText || '',
    })`)
    if (s.keep) await js(`document.querySelector('[data-testid=export-keep-working]').click()`)
    if (s.chip) sawChip = true
    if (/error|failed/i.test(s.text)) throw new Error('the export failed: ' + s.text.slice(0, 300))
    if (!s.chip && fs.existsSync(exportPath) && fs.statSync(exportPath).size > 1000 && Date.now() - t0 > 3000) break
    await sleep(500)
  }
  log('export done in', Date.now() - t0, 'ms')
  const ffmpeg = path.join(repo, 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', exportPath, '-frames:v', '1', path.join(root, 'export-frame.png')], { windowsHide: true })
  return { text: TEXT, sawChip, exportBytes: fs.statSync(exportPath).size }
}
