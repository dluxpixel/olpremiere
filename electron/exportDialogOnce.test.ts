// One save dialog per export, and what dismissing it does (merge check, item 1).
//
// exportChoice.test.ts pins the slot on its own. This proves it through the real
// dialog code (nativeExport.pickOutput and start) and through main's wiring: the
// export asks BEFORE the sound is made, then every start of the same job (the first,
// the loudness switch's restart, Try again) reuses that answer without opening a
// second dialog; any other path is refused and he is asked again; dismissing the
// dialog is a quiet cancel; and native:cancel never clears his answer.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  dir: '',
  empty: '',
  /** What the (fake) save dialog answers, and how many times it was opened. */
  answer: { canceled: false, filePath: '' } as { canceled: boolean; filePath?: string },
  opened: 0,
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    // A folder with no ffmpeg in it: a start gets past the dialog and stops at the
    // spawn, so no encoder runs and every start answers the same way.
    getAppPath: () => h.empty,
    getPath: (k: string) => `${h.dir}/${k}`,
  },
  dialog: {
    showSaveDialog: async () => {
      h.opened++
      return h.answer
    },
  },
}))
h.dir = mkdtempSync(path.join(tmpdir(), 'olp-export-dialog-'))
h.empty = path.join(h.dir, 'no-ffmpeg-here')
afterAll(() => rmSync(h.dir, { recursive: true, force: true }))

const { choseExportPath, exportFinished, exportPathFromPage } = await import('./exportChoice')
const native = await import('./nativeExport')
const { presetOutput } = await import('./exportPresetFolder')

const ANSWER = path.join(h.dir, 'Videos', 'Green_2.mp4')
const ELSEWHERE = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
const win = { webContents: { send: () => undefined } } as unknown as Parameters<typeof native.start>[1]
const config = (outPath: string | undefined) => ({
  width: 64,
  height: 64,
  fps: 30,
  totalFrames: 3,
  encoder: 'x264' as const,
  quality: 18,
  hasAudio: false,
  outPath,
  suggestedName: 'Green',
})
const main = readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8')

beforeEach(() => {
  exportFinished({ ok: true }) // no answer on record
  h.opened = 0
  h.answer = { canceled: false, filePath: ANSWER }
})

describe('one dialog per export', () => {
  it('⛔ asks once, before the sound; the start, a restart and Try again reuse the answer and never ask again', async () => {
    const picked = await native.pickOutput('x264', 'Green', win)
    expect(picked).toBe(ANSWER)
    expect(h.opened).toBe(1)

    // The first start, the loudness switch (cancel, then start again), then Try again
    // after a failed movie: each hands main the same answer, and main takes it.
    for (const step of ['first start', 'restart', 'try again']) {
      if (step === 'restart') await native.cancel() // native:cancel
      if (step === 'try again') exportFinished({ ok: false, error: 'ffmpeg exited with code 1' }) // native:finish
      const outPath = exportPathFromPage(picked)
      expect(outPath, step).toBe(path.resolve(ANSWER))
      const res = await native.start(config(outPath), win)
      // Past the dialog and into the spawn, which has no ffmpeg here.
      expect(res.error, step).toMatch(/^could not start ffmpeg/)
      expect(res.cancelled, step).toBeUndefined()
      expect(h.opened, step).toBe(1)
    }
  })

  it('⛔ any other path is refused, so the export asks him itself', async () => {
    await native.pickOutput('x264', 'Green', win)
    const outPath = exportPathFromPage(ELSEWHERE)
    expect(outPath).toBeUndefined()
    h.answer = { canceled: false, filePath: path.join(h.dir, 'Videos', 'Other.mp4') }
    const res = await native.start(config(outPath), win)
    expect(h.opened).toBe(2)
    expect(res.error).toMatch(/^could not start ffmpeg/)
  })
})

describe('dismissing the dialog', () => {
  it('⛔ is a quiet cancel: no error, nothing started, nothing recorded', async () => {
    h.answer = { canceled: true }
    expect(await native.pickOutput('x264', 'Green', win)).toBeNull()
    expect(exportPathFromPage(ANSWER)).toBeUndefined()

    const res = await native.start(config(undefined), win)
    expect(res).toEqual({ started: false, cancelled: true })
    expect(native.isExporting()).toBe(false)
    expect(h.opened).toBe(2)
  })

  it('leaves an earlier answer of his as it was', async () => {
    choseExportPath(ANSWER)
    h.answer = { canceled: true }
    expect(await native.pickOutput('x264', 'Green', win)).toBeNull()
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })
})

describe('native:cancel', () => {
  it('⛔ never clears his answer, because main cannot tell his cancel from the loudness switch', async () => {
    choseExportPath(ANSWER)
    await native.cancel()
    expect(exportPathFromPage(ANSWER)).toBe(path.resolve(ANSWER))
  })

  it('is wired to the encoder alone: only native:finish ends the job, and native:start takes the page\'s path through the slot', () => {
    expect(main).toContain("ipcMain.handle('native:cancel', () => native.cancel())")
    expect(main).toContain('native.start({ ...config, outPath: exportPathFromPage(config.outPath) }, mainWindow)')
    const calls = main.match(/\bexportFinished\(/g) ?? []
    expect(calls).toHaveLength(1)
    const finish = main.indexOf("ipcMain.handle('native:finish'")
    const call = main.indexOf('exportFinished(')
    expect(finish).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(finish)
    expect(call - finish).toBeLessThan(400)
  })
})

describe('a preset export', () => {
  it('⛔ moves off a name that was taken after it was made, and never asks with a dialog', async () => {
    const folder = path.join(h.dir, 'GymFolder')
    mkdirSync(folder, { recursive: true })
    const made = presetOutput(folder, 'Green', 'x264')
    expect(made).toEqual({ ok: true, outPath: path.join(folder, 'Green.mp4') })
    if (!made.ok) return
    // The sound takes a while to make, and a file of that name shows up in the meantime.
    writeFileSync(made.outPath, 'someone else')
    const res = await native.start(config(exportPathFromPage(made.outPath)), win)
    expect(res.error).toMatch(/^could not start ffmpeg/)
    expect(h.opened).toBe(0)
    expect(readFileSync(made.outPath, 'utf8')).toBe('someone else')
    // The answer on record is now the next free name, so a restart can use it.
    const next = path.join(folder, 'Green 2.mp4')
    expect(exportPathFromPage(next)).toBe(path.resolve(next))
  })

  it('leaves a path from his own save dialog exactly as it is', async () => {
    const folder = path.join(h.dir, 'DialogFolder')
    mkdirSync(folder, { recursive: true })
    const picked = path.join(folder, 'Mine.mp4')
    writeFileSync(picked, 'old take')
    choseExportPath(picked)
    await native.start(config(exportPathFromPage(picked)), win)
    expect(exportPathFromPage(picked)).toBe(path.resolve(picked))
    expect(readFileSync(picked, 'utf8')).toBe('old take')
  })

  it('is wired in main: the folder picker and the file name each have a handler', () => {
    expect(main).toContain("ipcMain.handle('export:pickFolder'")
    expect(main).toContain('pickPresetFolder(mainWindow, title, hint)')
    expect(main).toContain("ipcMain.handle('export:presetOutput'")
    expect(main).toContain('presetOutput(folder, base, encoder)')
  })
})
