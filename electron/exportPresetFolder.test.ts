// An export preset's folder, in main: the system folder picker, and a file name in
// that folder that nothing there has. Real files in a throwaway folder; only the
// dialog is faked.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** What the fake folder picker answers, and what it was asked. */
  answer: { canceled: false, filePaths: [] as string[] },
  asked: [] as unknown[],
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  dialog: {
    showOpenDialog: async (_win: unknown, opts: unknown) => {
      h.asked.push(opts)
      return h.answer
    },
  },
}))

const root = mkdtempSync(path.join(tmpdir(), 'olp-preset-folder-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const { exportPathFromPage } = await import('./exportChoice')
const { nearestExistingFolder, pickPresetFolder, presetFileName, presetOutput, refreshPick, sanitizeBase } = await import(
  './exportPresetFolder'
)

let gym = ''
beforeEach(() => {
  gym = mkdtempSync(path.join(root, 'gym-'))
  h.asked = []
  h.answer = { canceled: false, filePaths: [gym] }
})

describe('the folder picker', () => {
  it('hands back the folder he chose, asked for a folder (and may make one), titled with the preset', async () => {
    const got = await pickPresetFolder({} as never, 'Folder for Gym', null)
    expect(got).toBe(gym)
    expect(h.asked[0]).toMatchObject({ title: 'Folder for Gym', properties: ['openDirectory', 'createDirectory'] })
  })

  it('dismissing it is a quiet null', async () => {
    h.answer = { canceled: true, filePaths: [] }
    expect(await pickPresetFolder({} as never, 'Folder for Gym', null)).toBeNull()
  })

  it('opens where the old folder was, or the nearest folder above it that is still there', async () => {
    expect(nearestExistingFolder(path.join(gym, 'gone', 'deeper'))).toBe(gym)
    expect(nearestExistingFolder(gym)).toBe(gym)
    expect(nearestExistingFolder('relative/path')).toBeUndefined()
    expect(nearestExistingFolder(null)).toBeUndefined()
    await pickPresetFolder({} as never, 'Folder for Gym', path.join(gym, 'gone'))
    expect(h.asked[0]).toMatchObject({ defaultPath: gym })
  })
})

describe('the name of a preset export', () => {
  it('is the project name, then 2, 3 and on: never one that is already there', () => {
    const there = new Set(['Leg day.mp4', 'Leg day 2.mp4'])
    expect(presetFileName('Leg day', 'mp4', (n) => there.has(n))).toBe('Leg day 3.mp4')
    expect(presetFileName('Leg day', 'mp4', () => false)).toBe('Leg day.mp4')
  })

  it('is made in the chosen folder, and each export gets its own', () => {
    const first = presetOutput(gym, 'Leg day', 'x264')
    expect(first).toEqual({ ok: true, outPath: path.join(gym, 'Leg day.mp4') })
    writeFileSync(path.join(gym, 'Leg day.mp4'), 'the first video')
    const second = presetOutput(gym, 'Leg day', 'x264')
    expect(second).toEqual({ ok: true, outPath: path.join(gym, 'Leg day 2.mp4') })
    writeFileSync(path.join(gym, 'Leg day 2.mp4'), 'the second video')
    expect(presetOutput(gym, 'Leg day', 'x264')).toEqual({ ok: true, outPath: path.join(gym, 'Leg day 3.mp4') })
    expect(readdirSync(gym).sort()).toEqual(['Leg day 2.mp4', 'Leg day.mp4'])
  })

  it('ProRes lands as .mov', () => {
    expect(presetOutput(gym, 'Leg day', 'prores')).toEqual({ ok: true, outPath: path.join(gym, 'Leg day.mov') })
  })

  it('⛔ a project name cannot leave the folder', () => {
    const res = presetOutput(gym, '..\\..\\evil/../name:*?', 'x264')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(path.dirname(res.outPath)).toBe(gym)
      expect(path.basename(res.outPath)).not.toMatch(/[\\/:*?"<>|]/)
    }
    expect(sanitizeBase('..')).toBe('export')
    expect(sanitizeBase('   ')).toBe('export')
    expect(sanitizeBase(42)).toBe('export')
    expect(sanitizeBase('Gym.')).toBe('Gym')
  })

  it('asks for another folder when this one is gone, relative, a file, or not a text', () => {
    rmSync(gym, { recursive: true, force: true })
    expect(presetOutput(gym, 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    expect(presetOutput('relative/folder', 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    expect(presetOutput(42, 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    const file = path.join(root, 'a-file.txt')
    writeFileSync(file, 'x')
    expect(presetOutput(file, 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
  })

  it('⛔ is the one path the page may hand back to start the export, and no other', () => {
    const res = presetOutput(gym, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    expect(exportPathFromPage(res.outPath)).toBe(path.resolve(res.outPath))
    expect(exportPathFromPage(path.join(gym, 'Something else.mp4'))).toBeUndefined()
  })

  it('writes land in the chosen folder: folder pick, then name, then the file', async () => {
    const folder = await pickPresetFolder({} as never, 'Folder for Gym', null)
    const res = presetOutput(folder, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    writeFileSync(res.outPath, 'video bytes')
    expect(readdirSync(gym)).toEqual(['Leg day.mp4'])
  })
})

describe('the name is checked again when ffmpeg starts', () => {
  it('⛔ a file that appeared since the name was made is never overwritten: the next free name is used', () => {
    const res = presetOutput(gym, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    expect(refreshPick(res.outPath)).toBe(res.outPath)
    writeFileSync(res.outPath, 'somebody else made this while the sound was rendering')
    const moved = refreshPick(res.outPath)
    expect(moved).toBe(path.join(gym, 'Leg day 2.mp4'))
    expect(exportPathFromPage(moved)).toBe(path.resolve(moved))
  })

  it('leaves a path main did not name alone', () => {
    const other = path.join(gym, 'Chosen in a save dialog.mp4')
    writeFileSync(other, 'x')
    expect(refreshPick(other)).toBe(other)
    mkdirSync(path.join(gym, 'sub'))
  })
})
