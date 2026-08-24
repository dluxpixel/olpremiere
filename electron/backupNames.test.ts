// TWO PROJECTS SAVED IN THE SAME SECOND MUST BE TWO FILES.
//
// ⛔ Found 2026-08-24, inside the very code written to stop him losing work.
// The backup filename was a seconds-resolution stamp plus the project NAME, and
// every project of his is called "Untitled Project". The shelf-wide sweep writes
// them in one tight loop, so several land inside the same second and the write
// simply overwrote. Worse, the sweep still recorded every one of them as
// written, and a finished project never changes again, so its fingerprint never
// changes and it was never retried. Net effect: one file survives each sweep and
// the rest are marked done forever.
//
// His words, on what was at stake: *"I had some projects archived, some projects
// Working on and a few on later."*

import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock('electron', () => ({
  app: { getName: () => 'OL Premiere', getPath: (k: string) => ({ documents: 'C:/Docs', userData: 'C:/profile' })[k] },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: () => Promise.resolve(undefined),
  writeFile: (p: string, data: string) => {
    disk.files.set(p, data)
    return Promise.resolve()
  },
  readdir: () => Promise.resolve([...disk.files.keys()].map((p) => p.split('/').pop() as string)),
  readFile: (p: string) => Promise.resolve(disk.files.get(p) ?? ''),
  stat: () => Promise.resolve({ mtimeMs: 1 }),
  unlink: (p: string) => {
    disk.files.delete(p)
    return Promise.resolve()
  },
}))

const { writeBackup } = await import('./backups')

const doc = (id: string, name = 'Untitled Project'): string =>
  JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id, name } })

beforeEach(() => {
  disk.files.clear()
})

describe('a backup filename identifies the project, not just the second', () => {
  it('keeps two same-named projects saved in the same second as two files', async () => {
    const a = await writeBackup('Untitled Project', doc('ab9fe413-431f-4579-bbe8-4893ff85550d'))
    const b = await writeBackup('Untitled Project', doc('697b8f69-fd2b-4245-94b6-e7ff9c29de62'))
    expect(a).not.toBe(b)
    expect(disk.files.size).toBe(2)
  })

  it('puts the project id in the name so the file says which edit it is', async () => {
    const p = await writeBackup('Untitled Project', doc('ab9fe413-431f-4579-bbe8-4893ff85550d'))
    expect(p).toContain('ab9fe413')
    expect(p.endsWith('.olpbak')).toBe(true)
  })

  it('still writes a backup when the json will not parse, rather than failing', async () => {
    const p = await writeBackup('Untitled Project', 'not json at all')
    expect(p.endsWith('.olpbak')).toBe(true)
    expect(disk.files.size).toBe(1)
  })

  it('writes the whole shelf, not one survivor', async () => {
    const ids = ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003']
    for (const id of ids) await writeBackup('Untitled Project', doc(id))
    expect(disk.files.size).toBe(3)
    for (const id of ids) {
      expect([...disk.files.keys()].some((p) => p.includes(id.slice(0, 8)))).toBe(true)
    }
  })
})
