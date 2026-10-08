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

const { choseExportPath, exportPathFromPage, exportPathUsed } = await import('./exportChoice')
const { rememberFolder } = await import('./saveFiles')

const ANSWER = path.join(where.dir, 'Videos', 'Green_2.mp4')
const ELSEWHERE = 'C:\\Windows\\System32\\drivers\\etc\\hosts'

beforeEach(() => {
  // Spend whatever an earlier test left, so each starts with no answer on record.
  exportPathUsed(ANSWER)
  exportPathUsed(ELSEWHERE)
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

  it('is still taken for a restart or Try again of the same export, which send it again', () => {
    choseExportPath(ANSWER)
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
    // The loudness switch cancels and starts again with the same answer.
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })

  it('⛔ is spent once a finished movie was written there: the next export asks again', () => {
    choseExportPath(ANSWER)
    exportPathUsed(ANSWER)
    expect(exportPathFromPage(ANSWER)).toBeUndefined()
  })

  it('belongs to his LAST answer only', () => {
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
