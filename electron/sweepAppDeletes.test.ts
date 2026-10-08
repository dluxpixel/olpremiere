// The app's own deletes never stop the spare copy cleanup.
//
// ⛔ THE CLEANUP STOPS FOR GOOD WHEN A PROJECT IT ONCE SAW IN TRASH OR THE BACKUPS
// IS IN NONE OF THE FOLDERS ANY MORE (mediaSweep.ts). Right for a file that
// vanishes outside the app. Wrong for one the app removes on an ordinary day: that
// would end the cleanup he asked for ("every 7 days") the first time it happened,
// with nothing he could do about it. So these run the app's REAL delete code
// between two runs, on real files in a temp folder: his delete (the file moves into
// Trash), a delete he takes back, the file a rename leaves behind, and the backup
// rotation. The app has no way to empty Trash or delete a file in it, so that is
// every project file the app ever removes. A Trash file deleted by hand, outside
// the app, still stops it.

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '' }))
// The lab build keeps Projects and Backups inside its own profile: here, a temp folder.
vi.mock('electron', () => ({
  app: { getName: () => 'OL Premiere Lab', getPath: () => env.root },
}))

const { backupDir, writeBackup } = await import('./backups')
const { projectDir, trashProjectFile, writeProjectFile } = await import('./projectFiles')
const { spareCopyDir, sweepUnusedSpareCopies } = await import('./mediaSweep')

const DAY = 24 * 60 * 60 * 1000
// Well after the real clock, so a copy written now reads as old as its back dated time says.
const T0 = Date.now() + 60 * DAY

/** Spare copies, named the way newId makes asset ids. */
const GONE = '55555555-5555-4555-8555-555555555555' // nothing uses it: the one a run lets go
const TRASHED = '33333333-3333-4333-8333-333333333333' // only a project in Trash uses it
const BACKED = '44444444-4444-4444-8444-444444444444' // only a backup uses it

const places = () => ({ profileDir: env.root, projectsDir: projectDir(), backupDir: backupDir() })
const sweep = (projectIds: string[], at: number) =>
  sweepUnusedSpareCopies(places(), { projectIds, assetIds: [] }, at)
const onDisk = async (): Promise<string[]> => (await readdir(spareCopyDir(places()))).sort()
const trashDir = (): string => path.join(projectDir(), 'Trash')

/** A project the way the page sends it to main (backupFormat.ts serialize). */
function doc(id: string, name: string, assetIds: string[] = []): string {
  const assets = Object.fromEntries(assetIds.map((a) => [a, { id: a, name: `${a}.mp4`, blobKey: `asset/${a}` }]))
  return JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id, name, updatedAt: 1, assets } })
}

async function copy(id: string): Promise<void> {
  const dir = spareCopyDir(places())
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, id), new Uint8Array(1000))
  const when = new Date(T0 - 400 * DAY)
  await utimes(path.join(dir, id), when, when)
}

/**
 * His shelf, made by the app's own code: p1 (open), p2 and p3, each with its file
 * and a backup; p9, deleted months ago, in Trash only; p8, with nothing left but
 * its one backup.
 */
async function hisShelf(): Promise<void> {
  for (const id of [GONE, TRASHED, BACKED]) await copy(id)
  for (const id of ['p1', 'p2', 'p3']) {
    await writeProjectFile(id, `Edit ${id}`, doc(id, `Edit ${id}`))
    await writeBackup(`Edit ${id}`, doc(id, `Edit ${id}`))
  }
  await writeProjectFile('p9', 'best cat', doc('p9', 'best cat', [TRASHED]))
  expect(await trashProjectFile('p9')).toBe(1)
  await writeBackup('GYM', doc('p8', 'GYM', [BACKED]))
}

beforeEach(async () => {
  env.root = await mkdtemp(path.join(tmpdir(), 'olp-sweep-deletes-'))
})
afterEach(async () => {
  await rm(env.root, { recursive: true, force: true })
})

describe('⛔ the app deleting a project file never stops the spare copy cleanup', () => {
  it('his delete moves the file into Trash, and the next run still lets go of what nothing uses', async () => {
    await hisShelf()
    const first = await sweep(['p1', 'p2', 'p3'], T0)
    expect(first.code).toBeUndefined()
    // He deletes p2, takes it back with Undo (its file is written again), and deletes p3.
    expect(await trashProjectFile('p2')).toBe(1)
    await writeProjectFile('p2', 'Edit p2', doc('p2', 'Edit p2'))
    expect(await trashProjectFile('p3')).toBe(1)

    const r = await sweep(['p1', 'p2'], T0 + 8 * DAY)
    expect(r.code).toBeUndefined()
    expect(r.removed).toEqual([GONE])
    expect(await onDisk()).toEqual([BACKED, TRASHED].sort())
    // p9 from months ago, then p2 and p3: Trash only ever grew.
    expect((await readdir(trashDir())).length).toBe(3)
  })

  it('a rename clears the file under the old name, and the next run still lets go of what nothing uses', async () => {
    await hisShelf()
    expect((await sweep(['p1', 'p2', 'p3'], T0)).code).toBeUndefined()
    // He renames p2; and opens p9 from Trash (its file is written into Projects) and renames it too.
    await writeProjectFile('p2', 'Green', doc('p2', 'Green'))
    await writeProjectFile('p9', 'best cat', doc('p9', 'best cat', [TRASHED]))
    await writeProjectFile('p9', 'best cat 2', doc('p9', 'best cat 2', [TRASHED]))
    const inProjects = (await readdir(projectDir())).filter((f) => f.endsWith('.olpbak')).sort()
    expect(inProjects).toEqual(['Edit p1_p1.olpbak', 'Edit p3_p3.olpbak', 'Green_p2.olpbak', 'best cat 2_p9.olpbak'])

    const r = await sweep(['p1', 'p2', 'p3', 'p9'], T0 + 8 * DAY)
    expect(r.code).toBeUndefined()
    expect(r.removed).toEqual([GONE])
    expect(await onDisk()).toEqual([BACKED, TRASHED].sort())
  })

  it('the backup rotation (forty kept) prunes, and the next run still lets go of what nothing uses', async () => {
    await hisShelf()
    expect((await sweep(['p1', 'p2', 'p3'], T0)).code).toBeUndefined()
    // A long session on the open edit: far more backups than the forty kept.
    for (let i = 1; i <= 45; i += 1) await writeBackup(`Edit ${i}`, doc('p1', `Edit ${i}`))
    const backups = await readdir(backupDir())
    expect(backups.filter((f) => f.endsWith('.olpbak')).length).toBe(40)

    const r = await sweep(['p1', 'p2', 'p3'], T0 + 8 * DAY)
    expect(r.code).toBeUndefined()
    expect(r.removed).toEqual([GONE])
    expect(await onDisk()).toEqual([BACKED, TRASHED].sort())
    // p8's one backup, its only copy anywhere, is never the one pruned.
    expect(backups.some((f) => f.includes('_p8_'))).toBe(true)
    // Each backup is flushed to the disk before it lands: with every test file running
    // at once, forty-five of them can take longer than the default 5 seconds.
  }, 60_000)

  it('a Trash file deleted by hand, outside the app, still stops it for good', async () => {
    await hisShelf()
    expect((await sweep(['p1', 'p2', 'p3'], T0)).code).toBeUndefined()
    const [p9] = await readdir(trashDir())
    await rm(path.join(trashDir(), p9!))

    for (const at of [T0 + 8 * DAY, T0 + 60 * DAY]) {
      const r = await sweep(['p1', 'p2', 'p3'], at)
      expect(r.code).toBe('project-gone')
      expect(r.removed).toEqual([])
    }
    expect(await onDisk()).toEqual([BACKED, GONE, TRASHED].sort())
  })
})
