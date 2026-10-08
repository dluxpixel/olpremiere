// The hidden app's two promises about his PC: a bed is a copy, judged by where it
// really leads, and a run neither lags his machine nor leaves anything running.
// Real folders and a real junction, all in the system temp: a fake APPDATA stands in
// for his, so nothing here ever looks at the real one.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bedProblem } from './bed.mjs'

let tmp = ''
let appData = ''
const links = []

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'olp-bed-'))
  appData = path.join(tmp, 'Roaming')
  mkdirSync(path.join(appData, 'OL Premiere', 'media'), { recursive: true })
})
afterEach(() => {
  // The links first, by themselves, so removing the folder never reaches through one.
  for (const l of links.splice(0)) unlinkSync(l)
  rmSync(tmp, { recursive: true, force: true })
})

/** A bed with its own Projects, and `media` as given: a folder of its own, or a link. */
function makeBed(name, mediaLinksTo) {
  const bed = path.join(tmp, name)
  mkdirSync(path.join(bed, 'Projects'), { recursive: true })
  if (mediaLinksTo) {
    symlinkSync(mediaLinksTo, path.join(bed, 'media'), 'junction')
    links.push(path.join(bed, 'media'))
  } else {
    mkdirSync(path.join(bed, 'media'))
  }
  return bed
}

describe('a bed', () => {
  it('that is a copy is used', () => {
    expect(bedProblem(makeBed('bed'), appData)).toBeNull()
  })

  it('that is his real folder is refused, however it is spelled', () => {
    expect(bedProblem(path.join(appData, 'OL Premiere'), appData)).toMatch(/must be a COPY/)
    expect(bedProblem(path.join(appData, 'ol premiere', 'media', '..'), appData)).toMatch(/must be a COPY/)
  })

  it('⛔ whose media is a link to his real media folder is refused', () => {
    const bed = makeBed('linked', path.join(appData, 'OL Premiere', 'media'))
    expect(bedProblem(bed, appData)).toMatch(/the bed's media leads into his real OL Premiere folder/)
  })

  // ⛔ His media folder can itself be a link to another drive. A bed linked to where it
  // leads is outside his profile by path, and is still his real footage.
  it('⛔ whose media leads where his real media folder leads is refused, when that is another drive', () => {
    const footage = path.join(tmp, 'D-drive', 'OLMedia')
    mkdirSync(path.join(footage, 'clips'), { recursive: true })
    const real = path.join(appData, 'OL Premiere', 'media')
    rmSync(real, { recursive: true })
    symlinkSync(footage, real, 'junction')
    links.push(real)
    expect(bedProblem(makeBed('same', footage), appData)).toMatch(/the bed's media leads into his real media folder/)
    expect(bedProblem(makeBed('under', path.join(footage, 'clips')), appData)).toMatch(/must be a COPY/)
    // A copy beside it on that drive is still a copy.
    const copy = path.join(tmp, 'D-drive', 'OLMedia-copy')
    mkdirSync(copy)
    expect(bedProblem(makeBed('copy', copy), appData)).toBeNull()
  })

  it('that leads into his old profile is refused too', () => {
    mkdirSync(path.join(appData, 'reel', 'media'), { recursive: true })
    expect(bedProblem(makeBed('old', path.join(appData, 'reel', 'media')), appData)).toMatch(/must be a COPY/)
  })
})

describe('the hidden app itself', () => {
  const main = readFileSync(new URL('./app/main.cjs', import.meta.url), 'utf8')
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('drops to below normal before it does anything else', () => {
    const lower = code.indexOf('os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)')
    expect(lower).toBeGreaterThan(0)
    expect(lower).toBeLessThan(code.indexOf('app.setPath('))
  })

  it('runs the app\'s own teardown before every exit, so nothing it started outlives the run', () => {
    expect(code.match(/app\.exit\(/g)).toHaveLength(1)
    const end = code.slice(code.indexOf('function end('))
    expect(end.indexOf("app.emit('before-quit'")).toBeGreaterThan(0)
    expect(end.indexOf("app.emit('before-quit'")).toBeLessThan(end.indexOf('app.exit('))
  })
})
