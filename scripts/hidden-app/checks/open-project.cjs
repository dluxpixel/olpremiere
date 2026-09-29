// Opens one of his projects from a --bed run (a COPY of his projects and media)
// and reports what loaded: clips on the timeline, cards in the bin, and whether
// any media is missing. Set OLP_HIDDEN_PROJECT to part of the project's name
// (default "Green"). Writes project.png. A check that needs his real footage
// in the real app starts from here.
const fs = require('fs')
const path = require('path')

const WANT = (process.env.OLP_HIDDEN_PROJECT || 'Green').toLowerCase()
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
  await waitFor(`!!document.querySelector('[data-testid=open-projects]')`, 60000, 'the editor')
  await js(`document.querySelector('[data-testid=open-projects]').click()`)
  await waitFor(`document.querySelectorAll('[data-testid=project-row]').length > 0`, 20000, 'the project list')
  const names = await js(`[...document.querySelectorAll('[data-testid=project-row]')].map((r) => r.innerText.split('\\n')[0])`)
  log('projects:', JSON.stringify(names))
  const opened = await js(`(() => {
    const row = [...document.querySelectorAll('[data-testid=project-row]')].find((r) => r.innerText.toLowerCase().includes(${JSON.stringify(WANT)}))
    if (!row) return 'no row'
    const btn = row.querySelector('[data-testid=project-open]')
    if (btn) { btn.click(); return 'opened' }
    return 'already open'
  })()`)
  if (opened === 'no row') throw new Error(`no project matching "${WANT}" in ${JSON.stringify(names)}`)
  await waitFor(`document.querySelectorAll('[data-clip-kind]').length > 0`, 60000, 'clips on the timeline')
  // Give the media a moment to come back from the copied media folder.
  await sleep(8000)
  const state = await js(`({
    project: (document.querySelector('[data-testid=project-name]') || {}).value || '',
    clips: document.querySelectorAll('[data-clip-kind]').length,
    cards: document.querySelectorAll('[data-testid=asset-card]').length,
    missing: [...document.querySelectorAll('[data-testid=asset-card]')].filter((c) => /missing|offline|find/i.test(c.innerText)).length,
  })`)
  fs.writeFileSync(path.join(root, 'project.png'), (await wc.capturePage()).toPNG())
  return { names, ...state }
}
