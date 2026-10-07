// Letting go of spare copies nothing has used for 7 days, his call 2026-10-06.
//
// These are his footage's second home, so every rule here is a rule for KEEPING:
// a copy any project, any project in Trash or any backup uses stays, whatever its
// age; a copy goes only after 7 days of being seen unused AND 7 days since its file
// was written; and anything the sweep cannot read stops it removing anything at all.
// Real files in a temp folder, because the folders are the point.

import { mkdir, mkdtemp, readdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOLD_FOR_MS,
  holdFile,
  holdSweep,
  ledgerFile,
  spareCopyDir,
  sweepUnusedSpareCopies,
  UNUSED_FOR_MS,
  type SweepPlaces,
} from './mediaSweep'

const DAY = 24 * 60 * 60 * 1000
// Well after the real clock, so a file's creation (now, as the test writes it)
// reads as old as its back dated write time says.
const T0 = Date.now() + 60 * DAY

/** Asset ids the way newId makes them. */
const A = {
  live: '11111111-1111-4111-8111-111111111111',
  file: '22222222-2222-4222-8222-222222222222',
  trash: '33333333-3333-4333-8333-333333333333',
  backup: '44444444-4444-4444-8444-444444444444',
  gone: '55555555-5555-4555-8555-555555555555',
  gone2: '66666666-6666-4666-8666-666666666666',
}

let root = ''
let places: SweepPlaces
/** This profile's own spare copy folder: the only one a run may delete from. */
let media = ''
/** An older profile's folder, which mediaStore reads as a fallback. */
let oldMedia = ''
let trash = ''

/** A spare copy, written `daysAgo` days before T0. */
async function copy(id: string, daysAgo = 30, dir = media): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, id)
  await writeFile(file, new Uint8Array(1000))
  const when = new Date(T0 - daysAgo * DAY)
  await utimes(file, when, when)
}

/** A project file using `ids`, the way the Projects folder, Trash and backups hold them. */
async function projectFile(dir: string, name: string, ids: string[], projectId = name): Promise<void> {
  await mkdir(dir, { recursive: true })
  const assets = Object.fromEntries(ids.map((id) => [id, { id, name: `${id}.mp4`, blobKey: `asset/${id}` }]))
  await writeFile(
    path.join(dir, name),
    JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id: projectId, assets } }),
  )
}

const onDisk = async (dir = media): Promise<string[]> => (await readdir(dir).catch(() => [])).sort()
/** The store: three projects, the open one ('p1') with its file in Projects. */
const store = (assetIds: string[] = [A.live]) => ({ projectIds: ['p1', 'p2', 'p3'], assetIds })
const ledger = (): string => ledgerFile(places)

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'olp-sweep-'))
  places = {
    profileDir: path.join(root, 'OL Premiere'),
    projectsDir: path.join(root, 'Documents', 'OL Premiere Projects'),
    backupDir: path.join(root, 'Documents', 'OL Premiere Backups'),
  }
  media = spareCopyDir(places)
  oldMedia = path.join(root, 'reel', 'media')
  trash = path.join(places.projectsDir, 'Trash')
  await mkdir(media, { recursive: true })
  // A healthy machine: the open project's file in Projects, and a Trash and a
  // Backups folder beside it.
  await projectFile(places.projectsDir, 'Open_p1.olpbak', [], 'p1')
  await mkdir(trash, { recursive: true })
  await mkdir(places.backupDir, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('⛔ what is never let go, however old', () => {
  it('a copy a project in the store uses, a project file uses, one in Trash uses, or a backup uses', async () => {
    for (const id of [A.live, A.file, A.trash, A.backup]) await copy(id, 400)
    await projectFile(places.projectsDir, 'Green_aa.olpbak', [A.file])
    await projectFile(trash, '2026-01-01_best cat_bb.olpbak', [A.trash])
    await projectFile(places.backupDir, '2026-01-01_cc_GYM.olpbak', [A.backup])
    // Even with a ledger that says they have been unused for a year.
    const year = Object.fromEntries([A.live, A.file, A.trash, A.backup].map((id) => [id, T0 - 365 * DAY]))
    await writeFile(ledger(), JSON.stringify(year))

    const r = await sweepUnusedSpareCopies(places, store([A.live]), T0)

    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.live, A.file, A.trash, A.backup].sort())
    // Used copies are off the ledger, so a later unused spell starts its 7 days from zero.
    expect(JSON.parse(await readFile(ledger(), 'utf8'))).toEqual({})
  })

  it('anything that is not an asset id: Library copies, part files, his own files', async () => {
    const names = [`lib-${A.gone}`, `lib-thumb-${A.gone}`, `${A.gone}.part`, 'notes.txt', 'abc']
    for (const n of names) await copy(n, 400)
    await writeFile(ledger(), JSON.stringify(Object.fromEntries(names.map((n) => [n, T0 - 365 * DAY]))))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([...names].sort())
  })

  it('a copy a project file uses only through a clip whose media record is gone (the same count as the page)', async () => {
    await copy(A.gone2, 400)
    const project = {
      id: 'old',
      assets: {},
      sequences: { s1: { id: 's1', tracks: [{ clips: [{ id: 'c1', assetId: A.gone2 }] }] } },
    }
    await writeFile(path.join(trash, 'old_cut.olpbak'), JSON.stringify({ kind: 'ol-premiere-backup', project }))
    await writeFile(ledger(), JSON.stringify({ [A.gone2]: T0 - 30 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone2])
  })

  it('a copy put back under another case than the id the project uses', async () => {
    const lower = 'abcdef12-abcd-4abc-8abc-abcdefabcdef'
    const upper = lower.toUpperCase()
    await copy(upper, 30)
    await writeFile(ledger(), JSON.stringify({ [upper]: T0 - 30 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store([A.live, lower]), T0)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([upper])
  })

  it('a copy put back by hand: its write time is old, but the file itself is new', async () => {
    // Explorer and a copy by hand keep the old write time; only the creation is new.
    const file = path.join(media, A.gone)
    await writeFile(file, new Uint8Array(1000))
    const old = new Date(Date.now() - 400 * DAY)
    await utimes(file, old, old)
    const now = Date.now() + 2 * DAY
    await writeFile(ledger(), JSON.stringify({ [A.gone]: now - 30 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), now)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone])
  })
})

describe('the 7 days', () => {
  it('a copy nothing uses is only noted on the first run, kept at 6 days, and let go at 7', async () => {
    await copy(A.gone, 30)
    const first = await sweepUnusedSpareCopies(places, store(), T0)
    expect(first.removed).toEqual([])
    expect(first.waiting).toBe(1)

    const sixDays = await sweepUnusedSpareCopies(places, store(), T0 + 6 * DAY)
    expect(sixDays.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone])

    const sevenDays = await sweepUnusedSpareCopies(places, store(), T0 + UNUSED_FOR_MS)
    expect(sevenDays.removed).toEqual([A.gone])
    expect(sevenDays.freedBytes).toBe(1000)
    expect(await onDisk()).toEqual([])
  })

  it('a copy written less than 7 days ago stays, whatever the ledger says', async () => {
    await copy(A.gone, 2)
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a copy used again in between starts its 7 days over', async () => {
    await copy(A.gone, 30)
    await sweepUnusedSpareCopies(places, store(), T0)
    // Day 5: a project uses it again (an Undo, a project put back).
    await sweepUnusedSpareCopies(places, store([A.gone]), T0 + 5 * DAY)
    // Day 8: unused again, but only for 3 days.
    const r = await sweepUnusedSpareCopies(places, store(), T0 + 8 * DAY)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a ledger stamped in the future (a clock put back) never counts as old', async () => {
    await copy(A.gone, 30)
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 + 100 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0 + 3 * DAY)
    expect(r.removed).toEqual([])
    expect(JSON.parse(await readFile(ledger(), 'utf8'))[A.gone]).toBe(T0 + 3 * DAY)
  })

  it('a ledger that will not read starts every clock again, and lets nothing go that run', async () => {
    await copy(A.gone, 30)
    await writeFile(ledger(), '{"half')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(r.waiting).toBe(1)
  })

  it('takes only the unused one from beside the used ones', async () => {
    await copy(A.live, 30)
    await copy(A.gone, 30)
    await copy(A.gone2, 30)
    await projectFile(trash, 'x_trash.olpbak', [A.gone2])
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 8 * DAY, [A.gone2]: T0 - 8 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store([A.live]), T0)
    expect(r.removed).toEqual([A.gone])
    expect(await onDisk()).toEqual([A.live, A.gone2].sort())
  })
})

// ⛔ The delete set is never wider than what the run can see is used: the store,
// the Projects folder and the backups are THIS profile's, so only this profile's
// copies may go. A throwaway or lab profile sees none of his projects, and to it
// every copy of his footage is unused.
describe('⛔ only the spare copy folder of the profile it runs in is ever deleted from', () => {
  it('an older profile folder is never touched, even where the same copy goes from this one', async () => {
    await copy(A.gone, 30)
    await copy(A.gone, 30, oldMedia)
    await copy(A.gone2, 400, oldMedia)
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 8 * DAY, [A.gone2]: T0 - 365 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([A.gone])
    expect(await onDisk(media)).toEqual([])
    expect(await onDisk(oldMedia)).toEqual([A.gone, A.gone2].sort())
  })

  it('a throwaway profile, a week old, never removes a copy from his real folder', async () => {
    // His real profile, with copies only his own projects use.
    const his = path.join(root, 'OL Premiere', 'media')
    for (const id of [A.file, A.trash, A.backup]) await copy(id, 400, his)
    // A throwaway profile beside it: its own store, Projects, Backups and ledger.
    const lab: SweepPlaces = {
      profileDir: path.join(root, 'olp-verify-bed'),
      projectsDir: path.join(root, 'olp-verify-bed', 'Projects'),
      backupDir: path.join(root, 'olp-verify-bed', 'Backups'),
    }
    await projectFile(lab.projectsDir, 'Untitled_t1.olpbak', [], 't1')
    await mkdir(path.join(lab.projectsDir, 'Trash'), { recursive: true })
    await mkdir(lab.backupDir, { recursive: true })
    await writeFile(
      ledgerFile(lab),
      JSON.stringify(Object.fromEntries([A.file, A.trash, A.backup].map((id) => [id, T0 - 30 * DAY]))),
    )
    const r = await sweepUnusedSpareCopies(lab, { projectIds: ['t1'], assetIds: [] }, T0)
    expect(r.removed).toEqual([])
    expect(await onDisk(his)).toEqual([A.file, A.trash, A.backup].sort())
  })
})

describe('⛔ when it cannot prove a copy is unused, it lets nothing go', () => {
  beforeEach(async () => {
    await copy(A.gone, 30)
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
  })

  it('a store that read empty (the morning it was wiped)', async () => {
    const r = await sweepUnusedSpareCopies(places, { projectIds: [], assetIds: [] }, T0)
    expect(r.refused).toMatch(/no projects/)
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a project file that will not parse', async () => {
    await writeFile(path.join(places.projectsDir, 'half_dd.olpbak'), '{"project":{"id":"dd","ass')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/could not read every project file/)
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a backup that does not say what media it uses', async () => {
    await writeFile(path.join(places.backupDir, 'odd.olpbak'), '{"project":{"id":"x"}}')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toBeTruthy()
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a project folder it cannot look into', async () => {
    // A file where the folder should be: readdir fails with something other than "not there".
    await rm(places.projectsDir, { recursive: true, force: true })
    await writeFile(places.projectsDir, 'not a folder')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toBeTruthy()
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a file far too big to be a project file, without reading it whole', async () => {
    const big = path.join(places.backupDir, 'renamed bundle.olpbak')
    await writeFile(big, '{"project":')
    await truncate(big, 65 * 1024 * 1024)
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/too big to be a project file/)
    expect(await onDisk()).toEqual([A.gone])
  })

  // ⛔ A FOLDER THAT IS NOT THERE IS THE WRONG PLACE, NOT AN EMPTY ONE. Documents
  // moved (OneDrive backup switched off, its location changed, the folder renamed)
  // leaves every project file on the disk, just not where the run looks.
  describe('a Projects, Trash or Backups folder that is not there', () => {
    it('no Projects folder, while the store has projects', async () => {
      await rm(places.projectsDir, { recursive: true, force: true })
      const r = await sweepUnusedSpareCopies(places, store(), T0)
      expect(r.refused).toMatch(/Projects folder is not there/)
      expect(await onDisk()).toEqual([A.gone])
    })

    it('no Trash folder', async () => {
      await rm(trash, { recursive: true, force: true })
      const r = await sweepUnusedSpareCopies(places, store(), T0)
      expect(r.refused).toMatch(/Trash folder is not there/)
      expect(await onDisk()).toEqual([A.gone])
    })

    it('no Backups folder', async () => {
      await rm(places.backupDir, { recursive: true, force: true })
      const r = await sweepUnusedSpareCopies(places, store(), T0)
      expect(r.refused).toMatch(/Backups folder is not there/)
      expect(await onDisk()).toEqual([A.gone])
    })

    it('none of the three (a moved Documents): nothing goes, and the ledger is left as it was', async () => {
      await rm(path.join(root, 'Documents'), { recursive: true, force: true })
      const r = await sweepUnusedSpareCopies(places, store(), T0 + 100 * DAY)
      expect(r.refused).toBeTruthy()
      expect(r.removed).toEqual([])
      expect(await onDisk()).toEqual([A.gone])
      expect(JSON.parse(await readFile(ledger(), 'utf8'))).toEqual({ [A.gone]: T0 - 30 * DAY })
    })
  })

  it('a Projects folder with no project files in it, while the store has projects', async () => {
    await rm(path.join(places.projectsDir, 'Open_p1.olpbak'))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/holds no project files/)
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a Projects folder whose files are none of the projects in the store (the wrong folder)', async () => {
    await rm(path.join(places.projectsDir, 'Open_p1.olpbak'))
    await projectFile(places.projectsDir, 'Someone else_zz.olpbak', [], 'zz')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/no file in the Projects folder is a project in the store/)
    expect(await onDisk()).toEqual([A.gone])
  })
})

// ⛔ The morning the store lost something (2026-07-26: media in the store, the
// project record never written, so no file and no backup) the spare copies are
// the last trace of that footage. The page holds the cleanup; it must stand down.
describe('⛔ a hold stands the cleanup down for 30 days, then every clock starts again', () => {
  it('a copy a lost project used is not let go while held, nor at once when the hold ends', async () => {
    await copy(A.gone, 30)
    // Seen unused long before the loss: without the hold it would go on day one.
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
    await holdSweep(places, 'the store had no project to open at start', T0)

    const held = await sweepUnusedSpareCopies(places, store(), T0 + 8 * DAY)
    expect(held.refused).toMatch(/held until .*the store had no project to open at start/)
    expect(await onDisk()).toEqual([A.gone])

    // The day the hold ends: its clock starts then, not 30 days before.
    const ended = await sweepUnusedSpareCopies(places, store(), T0 + HOLD_FOR_MS)
    expect(ended.refused).toBeUndefined()
    expect(ended.removed).toEqual([])
    expect(await onDisk()).toEqual([A.gone])
    const sixDaysOn = await sweepUnusedSpareCopies(places, store(), T0 + HOLD_FOR_MS + 6 * DAY)
    expect(sixDaysOn.removed).toEqual([])

    // Still unused 7 days after the hold: only now does it go.
    const sevenDaysOn = await sweepUnusedSpareCopies(places, store(), T0 + HOLD_FOR_MS + UNUSED_FOR_MS)
    expect(sevenDaysOn.removed).toEqual([A.gone])
  })

  it('a second hold never shortens a longer one already in place', async () => {
    await holdSweep(places, 'first', T0)
    await holdSweep(places, 'second', T0 - 10 * DAY)
    const hold = JSON.parse(await readFile(holdFile(places), 'utf8')) as { until: number }
    expect(hold.until).toBe(T0 + HOLD_FOR_MS)
  })

  it('a hold that will not read refuses, rather than reading as no hold', async () => {
    await copy(A.gone, 30)
    await writeFile(ledger(), JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
    await writeFile(holdFile(places), '{"unt')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/hold/)
    expect(await onDisk()).toEqual([A.gone])
  })
})
