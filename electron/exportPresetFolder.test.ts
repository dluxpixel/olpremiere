// An export preset's folder, in main: the system folder picker, and a file name in
// that folder that nothing there has. Real files in a throwaway folder; only the
// dialog is faked.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const { nearestExistingFolder, pickPresetFolder, claimPick, presetFileName, presetOutput, sanitizeBase } = await import(
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

describe('⛔ a Windows device name never becomes the file', () => {
  it('NUL, con, COM1 and NUL.x get a plain word in front', () => {
    expect(sanitizeBase('NUL')).toBe('export NUL')
    expect(sanitizeBase('con')).toBe('export con')
    expect(sanitizeBase('COM1')).toBe('export COM1')
    expect(sanitizeBase('NUL.x')).toBe('export NUL.x')
    expect(sanitizeBase('lpt¹')).toBe('export lpt¹')
    expect(sanitizeBase('Console')).toBe('Console')
    expect(sanitizeBase('COM10')).toBe('COM10')
    const res = presetOutput(gym, 'Aux', 'x264')
    expect(res).toEqual({ ok: true, outPath: path.join(gym, 'export Aux.mp4') })
  })

  it('a long name is cut so the whole path stays short enough for Windows', () => {
    const res = presetOutput(gym, 'x'.repeat(400), 'x264')
    if (!res.ok) throw new Error('expected a path')
    expect(path.basename(res.outPath, '.mp4').length).toBe(Math.max(24, 240 - gym.length))
  })
})

describe('⛔ never a network folder', () => {
  it('\\\\host\\share and \\\\?\\ paths are refused, so the page asks with the picker again', () => {
    expect(presetOutput('\\\\host\\share\\Gym', 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    expect(presetOutput('//host/share/Gym', 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    expect(presetOutput(`\\\\?\\${gym}`, 'Leg day', 'x264')).toEqual({ ok: false, reason: 'no-folder' })
    expect(nearestExistingFolder('\\\\host\\share\\Gym')).toBeUndefined()
    expect(nearestExistingFolder(`\\\\?\\${gym}`)).toBeUndefined()
  })
})

describe('⛔ the name is taken for real when ffmpeg starts', () => {
  it('claims the name as an empty file, so nothing can take it before ffmpeg writes', () => {
    const res = presetOutput(gym, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    expect(claimPick(res.outPath)).toEqual({ outPath: res.outPath, placeholder: true })
    expect(readFileSync(res.outPath, 'utf8')).toBe('')
  })

  it('a file that appeared since the name was made is never touched: the next free name is claimed', () => {
    const res = presetOutput(gym, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    writeFileSync(res.outPath, 'somebody else made this while the sound was rendering')
    const moved = claimPick(res.outPath)
    expect(moved).toEqual({ outPath: path.join(gym, 'Leg day 2.mp4'), placeholder: true })
    expect(readFileSync(res.outPath, 'utf8')).toBe('somebody else made this while the sound was rendering')
    expect(exportPathFromPage(moved.outPath)).toBe(path.resolve(moved.outPath))
  })

  it('a folder that refuses the file throws, and makes nothing', () => {
    const res = presetOutput(gym, 'Leg day', 'x264')
    if (!res.ok) throw new Error('expected a path')
    rmSync(gym, { recursive: true, force: true })
    expect(() => claimPick(res.outPath)).toThrow(/ENOENT/)
  })

  it('leaves a path main did not name alone', () => {
    const other = path.join(gym, 'Chosen in a save dialog.mp4')
    writeFileSync(other, 'x')
    expect(claimPick(other)).toEqual({ outPath: other, placeholder: false })
    expect(readFileSync(other, 'utf8')).toBe('x')
    mkdirSync(path.join(gym, 'sub'))
  })
})
