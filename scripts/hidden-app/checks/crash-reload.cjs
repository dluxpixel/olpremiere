// Crashes the editor's page on purpose and checks that the app loads it again, writes
// one line to logs/crash.log, and tells him on the new page (electron/crashPlan.ts).
// Before 2026-10-06 a crashed editor stayed a blank window that took no input.
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = async ({ wc, log }) => {
  const js = (code) => wc.executeJavaScript(code)
  const waitFor = async (cond, ms, what) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const v = await js(cond).catch(() => false)
      if (v) return v
      await sleep(300)
    }
    throw new Error('timed out waiting for ' + what)
  }
  await waitFor(`!!document.querySelector('[data-testid=open-projects]')`, 60000, 'the editor')

  const crashLog = path.join(app.getPath('logs'), 'crash.log')
  const before = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, 'utf8') : ''
  const reloaded = new Promise((resolve) => wc.once('did-finish-load', resolve))
  const gone = new Promise((resolve) => wc.once('render-process-gone', (_e, d) => resolve(d.reason)))
  wc.forcefullyCrashRenderer()
  const reason = await Promise.race([gone, sleep(10000).then(() => 'no gone event')])
  log('gone:', reason)
  const back = await Promise.race([reloaded.then(() => true), sleep(30000).then(() => false)])
  if (!back) throw new Error('the page was not loaded again after the crash')

  await waitFor(`!!document.querySelector('[data-testid=open-projects]')`, 60000, 'the editor after the reload')
  const toast = await waitFor(
    `[...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && /Something went wrong, so OL Premiere opened again/.test(e.textContent || ''))`,
    15000,
    'the toast that says it opened again',
  )

  const after = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, 'utf8') : ''
  const lines = after.slice(before.length).split('\n').filter(Boolean)
  log('crash log:', JSON.stringify(lines))
  if (lines.length !== 1) throw new Error(`expected one crash log line, got ${lines.length}`)
  if (!/editor page gone reason=\S+ .*then=reload/.test(lines[0])) throw new Error('unexpected crash log line: ' + lines[0])
  return { reason, reloaded: back, toast: !!toast, line: lines[0] }
}
