import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Where the save dialog "picks", and the app's own folder. Both throwaway. */
const where = vi.hoisted(() => ({ dir: '', chosen: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => where.dir },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: where.chosen }) },
}))
const { closeWrite, hasRoomFor, numberedFileName, openForWrite, pickSavePath, writeChunk } = await import('./saveFiles')

describe('the name an export or a project file is offered', () => {
  it('is the project name when the folder does not have it yet', () => {
    expect(numberedFileName('Green', 'mp4', () => false)).toBe('Green.mp4')
  })
  it('never offers a name that is already there: _1, _2 and on', () => {
    // His words: "Every time I export something, it asks me, Do you want to replace that? Of course not."
    const there = new Set(['Untitled Project.mp4', 'Untitled Project_1.mp4'])
    expect(numberedFileName('Untitled Project', 'mp4', (n) => there.has(n))).toBe('Untitled Project_2.mp4')
  })
  it('numbers per extension, so a video does not push the project file along', () => {
    const there = new Set(['BC.mp4'])
    expect(numberedFileName('BC', 'olstudio', (n) => there.has(n))).toBe('BC.olstudio')
  })
})

// The renderer streams a big file through these. They must only ever write
// where he chose, and a write that fails must leave nothing in his folder.
describe('writing a file he picked', () => {
  beforeEach(async () => {
    where.dir = await mkdtemp(path.join(tmpdir(), 'olp-save-'))
    where.chosen = path.join(where.dir, 'GYM.olstudio')
  })
  afterEach(async () => {
    await rm(where.dir, { recursive: true, force: true })
  })
  const pick = () => pickSavePath({} as never, 'project', 'GYM', 'olstudio', 'OL Premiere project')

  it('⛔ refuses a path he did not choose in the save dialog', async () => {
    await expect(openForWrite(path.join(where.dir, 'elsewhere.olstudio'))).rejects.toThrow(/not chosen/)
    expect(await readdir(where.dir)).toEqual([])
  })

  it('a chosen path is good for ONE write, not for ever', async () => {
    await pick()
    const id = await openForWrite(where.chosen)
    await closeWrite(id, false)
    await expect(openForWrite(where.chosen)).rejects.toThrow(/not chosen/)
  })

  it('a finished write lands under his name, and no part file is left', async () => {
    await pick()
    const id = await openForWrite(where.chosen)
    await writeChunk(id, new TextEncoder().encode('his project').buffer)
    await closeWrite(id, true)
    expect(await readdir(where.dir)).toContain('GYM.olstudio')
    expect((await readdir(where.dir)).filter((f) => f.endsWith('.olpart'))).toEqual([])
    expect(await readFile(where.chosen, 'utf8')).toBe('his project')
  })

  it('⛔ a failed write throws the part file away and never touches his name', async () => {
    await pick()
    const id = await openForWrite(where.chosen)
    await writeChunk(id, new Uint8Array(16).buffer)
    await closeWrite(id, false)
    expect((await readdir(where.dir)).filter((f) => f !== 'save-folders.json')).toEqual([])
  })

  it('⛔ refuses before writing a byte when the drive has no room for it', async () => {
    await pick()
    await expect(openForWrite(where.chosen, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/ENOSPC/)
    expect((await readdir(where.dir)).filter((f) => f !== 'save-folders.json')).toEqual([])
  })
})

describe('hasRoomFor', () => {
  it('compares what the drive has free with what is needed', async () => {
    const drive = async () => ({ bavail: 100, bsize: 4096 })
    expect(await hasRoomFor('D:/', 409_600, drive)).toBe(true)
    expect(await hasRoomFor('D:/', 409_601, drive)).toBe(false)
  })
  it('lets the write itself decide when the drive cannot be asked', async () => {
    expect(await hasRoomFor('D:/', 1, async () => Promise.reject(new Error('EPERM')))).toBe(true)
  })
})
