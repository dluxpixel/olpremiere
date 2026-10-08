// Where a page may have main write a movie (./exportChoice): only the file he chose in
// main's own save dialog, so the export can ask once, before the sound is made, and the
// page still cannot point ffmpeg (which writes with -y) at any other file on his PC.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const where = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => where.dir }, dialog: {} }))
where.dir = mkdtempSync(path.join(tmpdir(), 'olp-export-choice-'))
afterAll(() => rmSync(where.dir, { recursive: true, force: true }))

const { choseExportPath, exportFinished, exportPathFromPage } = await import('./exportChoice')
const { rememberFolder } = await import('./saveFiles')

const ANSWER = path.join(where.dir, 'Videos', 'Green_2.mp4')
const ELSEWHERE = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
/** What native:finish answers for a movie that was written, and for one that was not. */
const FINISHED = { ok: true, outPath: ANSWER, sizeBytes: 1 }
const FAILED = { ok: false, error: 'ffmpeg exited with code 1' }

beforeEach(() => {
  // End whatever job an earlier test left, so each starts with no answer on record.
  exportFinished(FINISHED)
})

describe('a destination a page names', () => {
  it('is dropped when he never chose it, so the export asks him itself', () => {
    expect(exportPathFromPage(ELSEWHERE)).toBeUndefined()
    expect(exportPathFromPage(undefined)).toBeUndefined()
  })

  it('is taken when it is the answer main\'s own export dialog gave', () => {
    choseExportPath(ANSWER)
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })

  it('⛔ is dropped when it is anything else, even right after he answered', () => {
    choseExportPath(ANSWER)
    expect(exportPathFromPage(ELSEWHERE)).toBeUndefined()
    expect(exportPathFromPage(`${ANSWER}.exe`)).toBeUndefined()
    expect(exportPathFromPage({ toString: () => ANSWER })).toBeUndefined()
    expect(exportPathFromPage(['x'])).toBeUndefined()
  })

  // ⛔ NOT A ONE USE PASS. The loudness switch restarts the export by cancelling it and
  // starting again with the same answer, and Try again starts again after a failure.
  // A slot spent by the first start made both of those ask him a second time.
  it('⛔ is taken for every start of the same job: a restart after a cancel, Try again after a failure', () => {
    choseExportPath(ANSWER)
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER)) // the first start
    // The loudness switch: native:cancel (which never reaches exportChoice), then a start.
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
    // ffmpeg failed: native:finish answers not ok, and Try again starts once more.
    exportFinished(FAILED)
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
    // Any other path, at any point of the job, is still refused.
    expect(exportPathFromPage(ELSEWHERE)).toBeUndefined()
    exportFinished(undefined)
    exportFinished({ ok: 'yes' })
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })

  it('⛔ is cleared when the job ends with a finished movie: the next export asks again', () => {
    choseExportPath(ANSWER)
    exportFinished(FINISHED)
    expect(exportPathFromPage(ANSWER)).toBeUndefined()
  })

  it('belongs to his LAST answer only: a new pick replaces it', () => {
    const first = path.join(where.dir, 'Videos', 'first.mp4')
    choseExportPath(first)
    choseExportPath(ANSWER)
    expect(exportPathFromPage(first)).toBeUndefined()
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })
})

describe('his answer is recorded by the dialog itself', () => {
  // Every save dialog in main ends in rememberFolder: the export one (native:pickOutput,
  // and the dialog start() falls back to) and the file picker (file:pickSave).
  it('an export dialog\'s answer is the one destination a page may hand back', () => {
    expect(exportPathFromPage(ANSWER)).toBeUndefined()
    rememberFolder('export', ANSWER)
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })

  it('a project file he saves is never a place a movie may go', () => {
    const project = path.join(where.dir, 'Documents', 'Green.olstudio')
    rememberFolder('project', project)
    expect(exportPathFromPage(project)).toBeUndefined()
  })
})
