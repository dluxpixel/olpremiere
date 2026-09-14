// A project is a file. These pin the three things that make that true: the
// file is complete or absent, never half; a rename leaves one file not two; and
// his delete moves the file, never unlinks it.
//
// Real files in a temp folder, because the atomic write is the whole point and
// a mocked fs cannot fail half way.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let appName = 'OL Premiere'
let userData = ''
const paths = (): Record<string, string> => ({ documents: 'C:/Users/skyle/Documents', userData })

vi.mock('electron', () => ({
  app: {
    getName: () => appName,
    getPath: (k: string) => paths()[k],
  },
}))

const files = await import('./projectFiles')

/** Every test runs as a throwaway profile, so the folder is the temp one, never his Documents. */
const realArgv = process.argv
beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'olp-projects-'))
  process.argv = ['electron.exe', '.', `--user-data-dir=${userData}`]
  appName = 'OL Premiere'
})
afterEach(async () => {
  process.argv = realArgv
  await rm(userData, { recursive: true, force: true })
})

const doc = (id: string, name: string, updatedAt = 1): string =>
  JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id, name, updatedAt, sequences: {} } })

describe('where the files go', () => {
  it('is a folder of his Documents named after the app, beside the backups', () => {
    process.argv = ['electron.exe', '.']
    expect(files.projectDir().replace(/\\/g, '/')).toBe('C:/Users/skyle/Documents/OL Premiere Projects')
  })

  it('⛔ stays out of his Documents for a throwaway profile and for the lab', () => {
    // The e2e harness and the cold start check write dozens of projects. Not
    // one may land in the folder his real work lives in.
    expect(files.projectDir().replace(/\\/g, '/')).toBe(`${userData.replace(/\\/g, '/')}/Projects`)
    process.argv = ['electron.exe', '.']
    appName = 'OL Premiere Lab'
    expect(files.projectDir()).not.toContain('Documents')
  })
})

describe('writing', () => {
  it('names the file by his name and the id, so Explorer reads it and a rename can find it', () => {
    expect(files.projectFileName('Green', 'ab9fe413-4312-4c0e-9d7e-000000000000')).toBe('Green_ab9fe413.olpbak')
    expect(files.projectFileName('', 'ab9fe413-4312')).toBe('project_ab9fe413.olpbak')
    expect(files.projectFileName('Spirit (recovered)', 'c65a3f80-42e0')).toBe('Spirit recovered_c65a3f80.olpbak')
  })

  it('leaves exactly one complete file, and no temp file, after a write', async () => {
    await files.writeProjectFile('ab9fe413-4312', 'Green', doc('ab9fe413-4312', 'Green'))
    const dir = files.projectDir()
    expect(await readdir(dir)).toEqual(['Green_ab9fe413.olpbak'])
    expect(JSON.parse(await readFile(path.join(dir, 'Green_ab9fe413.olpbak'), 'utf8')).project.name).toBe('Green')
  })

  it('⛔ a rename replaces the old file instead of leaving two projects', async () => {
    // Two files with one id would list as one project (the newer wins) but the
    // stale one would sit there forever and come back if the new one were
    // trashed. The write clears every other file carrying the same id.
    await files.writeProjectFile('ab9fe413-4312', 'Green', doc('ab9fe413-4312', 'Green', 1))
    await files.writeProjectFile('ab9fe413-4312', 'Green final', doc('ab9fe413-4312', 'Green final', 2))
    expect(await readdir(files.projectDir())).toEqual(['Green final_ab9fe413.olpbak'])
  })

  it('a stray temp file from a cut off write is never listed and never trashed', async () => {
    const dir = files.projectDir()
    await files.writeProjectFile('ab9fe413-4312', 'Green', doc('ab9fe413-4312', 'Green'))
    await writeFile(path.join(dir, 'Green_ab9fe413.olpbak.tmp'), '{"project":{"id":"ab9fe413-4312"', 'utf8')
    const rows = await files.listProjectFiles()
    expect(rows.map((r) => r.name)).toEqual(['Green'])
  })
})

describe('listing', () => {
  it('reads the id, name and time out of each file, newest first', async () => {
    await files.writeProjectFile('a1', 'Old', doc('a1', 'Old', 100))
    await files.writeProjectFile('b2', 'New', doc('b2', 'New', 200))
    const rows = await files.listProjectFiles()
    expect(rows.map((r) => [r.id, r.name, r.updatedAt])).toEqual([
      ['b2', 'New', 200],
      ['a1', 'Old', 100],
    ])
    expect(rows[0].path.replace(/\\/g, '/')).toBe(`${files.projectDir().replace(/\\/g, '/')}/New_b2.olpbak`)
  })

  it('is empty, not an error, before the folder exists', async () => {
    expect(await files.listProjectFiles()).toEqual([])
  })

  it('skips a file that is not a project, and a half written one', async () => {
    const dir = files.projectDir()
    await files.writeProjectFile('a1', 'Real', doc('a1', 'Real'))
    await writeFile(path.join(dir, 'notes_zz.olpbak'), '{"hello":1}', 'utf8')
    await writeFile(path.join(dir, 'half_yy.olpbak'), '{"project":{"id":"yy","na', 'utf8')
    expect((await files.listProjectFiles()).map((r) => r.id)).toEqual(['a1'])
  })

  it('sees a rewrite of the same file, so the cache never serves a stale name', async () => {
    await files.writeProjectFile('a1', 'First', doc('a1', 'First', 1))
    expect((await files.listProjectFiles())[0].name).toBe('First')
    // Same name, same file, newer content. Only the mtime can tell them apart.
    await new Promise((r) => setTimeout(r, 15))
    await files.writeProjectFile('a1', 'First', doc('a1', 'First', 2))
    expect((await files.listProjectFiles())[0].updatedAt).toBe(2)
  })
})

describe('his delete', () => {
  it('⛔ moves the file into Trash instead of deleting it', async () => {
    await files.writeProjectFile('a1', 'Green', doc('a1', 'Green'))
    expect(await files.trashProjectFile('a1')).toBe(1)
    const dir = files.projectDir()
    expect((await readdir(dir)).filter((f) => f.endsWith('.olpbak'))).toEqual([])
    const trashed = await readdir(path.join(dir, 'Trash'))
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/_Green_a1\.olpbak$/)
    expect(await files.listProjectFiles()).toEqual([])
  })

  it('is quiet about a project that never had a file', async () => {
    expect(await files.trashProjectFile('nobody')).toBe(0)
  })
})

describe('the read guard', () => {
  it('allows only our files in our folder, and nothing in Trash', () => {
    const dir = files.projectDir()
    expect(files.isProjectFilePath(path.join(dir, 'Green_a1.olpbak'))).toBe(true)
    expect(files.isProjectFilePath(path.join(dir, 'Trash', 'x_Green_a1.olpbak'))).toBe(false)
    expect(files.isProjectFilePath(path.join(dir, '..', 'secrets.olpbak'))).toBe(false)
    expect(files.isProjectFilePath(path.join(dir, 'Green_a1.olpbak.tmp'))).toBe(false)
    expect(files.isProjectFilePath('C:/Windows/system.ini')).toBe(false)
  })
})
