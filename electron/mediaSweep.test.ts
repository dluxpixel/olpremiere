// Letting go of spare copies nothing has used for 7 days, his call 2026-10-06.
//
// These are his footage's second home, so every rule here is a rule for KEEPING:
// a copy any project, any project in Trash or any backup uses stays, whatever its
// age; a copy goes only after 7 days of being seen unused AND 7 days since its file
// was written; and anything the sweep cannot read stops it removing anything at all.
// Real files in a temp folder, because the folders are the point.

import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepUnusedSpareCopies, UNUSED_FOR_MS, type SweepPlaces } from './mediaSweep'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 6, 12)

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

/** A spare copy, written `daysAgo` days before T0. */
async function copy(id: string, daysAgo = 30, dir = places.mediaDirs[0]!): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, id)
  await writeFile(file, new Uint8Array(1000))
  const when = new Date(T0 - daysAgo * DAY)
  await utimes(file, when, when)
}

/** A project file using `ids`, the way the Projects folder, Trash and backups hold them. */
async function projectFile(dir: string, name: string, ids: string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const assets = Object.fromEntries(ids.map((id) => [id, { id, name: `${id}.mp4`, blobKey: `asset/${id}` }]))
  await writeFile(path.join(dir, name), JSON.stringify({ kind: 'ol-premiere-backup', version: 1, project: { id: name, assets } }))
}

const onDisk = async (dir = places.mediaDirs[0]!): Promise<string[]> => (await readdir(dir).catch(() => [])).sort()
const store = (assetIds: string[] = [A.live]) => ({ projects: 3, assetIds })

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'olp-sweep-'))
  const projects = path.join(root, 'Projects')
  places = {
    mediaDirs: [path.join(root, 'media'), path.join(root, 'old', 'media')],
    projectDirs: [projects, path.join(projects, 'Trash')],
    backupDirs: [path.join(root, 'Backups')],
    ledgerFile: path.join(root, 'spare-copies-unused.json'),
  }
  await mkdir(places.mediaDirs[0]!, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('⛔ what is never let go, however old', () => {
  it('a copy a project in the store uses, a project file uses, one in Trash uses, or a backup uses', async () => {
    for (const id of [A.live, A.file, A.trash, A.backup]) await copy(id, 400)
    await projectFile(places.projectDirs[0]!, 'Green_aa.olpbak', [A.file])
    await projectFile(places.projectDirs[1]!, '2026-01-01_best cat_bb.olpbak', [A.trash])
    await projectFile(places.backupDirs[0]!, '2026-01-01_cc_GYM.olpbak', [A.backup])
    // Even with a ledger that says they have been unused for a year.
    const year = Object.fromEntries([A.live, A.file, A.trash, A.backup].map((id) => [id, T0 - 365 * DAY]))
    await writeFile(places.ledgerFile, JSON.stringify(year))

    const r = await sweepUnusedSpareCopies(places, store([A.live]), T0)

    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([A.live, A.file, A.trash, A.backup].sort())
    // Used copies are off the ledger, so a later unused spell starts its 7 days from zero.
    expect(JSON.parse(await readFile(places.ledgerFile, 'utf8'))).toEqual({})
  })

  it('anything that is not an asset id: Library copies, part files, his own files', async () => {
    const names = [`lib-${A.gone}`, `lib-thumb-${A.gone}`, `${A.gone}.part`, 'notes.txt', 'abc']
    for (const n of names) await copy(n, 400)
    await writeFile(places.ledgerFile, JSON.stringify(Object.fromEntries(names.map((n) => [n, T0 - 365 * DAY]))))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(await onDisk()).toEqual([...names].sort())
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
    await writeFile(places.ledgerFile, JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
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
    await writeFile(places.ledgerFile, JSON.stringify({ [A.gone]: T0 + 100 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0 + 3 * DAY)
    expect(r.removed).toEqual([])
    expect(JSON.parse(await readFile(places.ledgerFile, 'utf8'))[A.gone]).toBe(T0 + 3 * DAY)
  })

  it('a ledger that will not read starts every clock again, and lets nothing go that run', async () => {
    await copy(A.gone, 30)
    await writeFile(places.ledgerFile, '{"half')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([])
    expect(r.waiting).toBe(1)
  })

  it('lets go of the copy in every folder it is in, the old profile folder too', async () => {
    await copy(A.gone, 30)
    await copy(A.gone, 30, places.mediaDirs[1]!)
    await writeFile(places.ledgerFile, JSON.stringify({ [A.gone]: T0 - 8 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.removed).toEqual([A.gone])
    expect(await onDisk(places.mediaDirs[0]!)).toEqual([])
    expect(await onDisk(places.mediaDirs[1]!)).toEqual([])
  })

  it('takes only the unused one from beside the used ones', async () => {
    await copy(A.live, 30)
    await copy(A.gone, 30)
    await copy(A.gone2, 30)
    await projectFile(places.projectDirs[1]!, 'x_trash.olpbak', [A.gone2])
    await writeFile(places.ledgerFile, JSON.stringify({ [A.gone]: T0 - 8 * DAY, [A.gone2]: T0 - 8 * DAY }))
    const r = await sweepUnusedSpareCopies(places, store([A.live]), T0)
    expect(r.removed).toEqual([A.gone])
    expect(await onDisk()).toEqual([A.live, A.gone2].sort())
  })
})

describe('⛔ when it cannot prove a copy is unused, it lets nothing go', () => {
  beforeEach(async () => {
    await copy(A.gone, 30)
    await writeFile(places.ledgerFile, JSON.stringify({ [A.gone]: T0 - 30 * DAY }))
  })

  it('a store that read empty (the morning it was wiped)', async () => {
    const r = await sweepUnusedSpareCopies(places, { projects: 0, assetIds: [] }, T0)
    expect(r.refused).toMatch(/no projects/)
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a project file that will not parse', async () => {
    await mkdir(places.projectDirs[0]!, { recursive: true })
    await writeFile(path.join(places.projectDirs[0]!, 'half_dd.olpbak'), '{"project":{"id":"dd","ass')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toMatch(/could not read every project file/)
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a backup that does not say what media it uses', async () => {
    await mkdir(places.backupDirs[0]!, { recursive: true })
    await writeFile(path.join(places.backupDirs[0]!, 'odd.olpbak'), '{"project":{"id":"x"}}')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toBeTruthy()
    expect(await onDisk()).toEqual([A.gone])
  })

  it('a project folder it cannot look into', async () => {
    // A file where the folder should be: readdir fails with something other than "not there".
    await writeFile(path.join(root, 'Projects'), 'not a folder')
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toBeTruthy()
    expect(await onDisk()).toEqual([A.gone])
  })

  it('no Projects, Trash or backups folder yet is not a reason to refuse', async () => {
    const r = await sweepUnusedSpareCopies(places, store(), T0)
    expect(r.refused).toBeUndefined()
    expect(r.removed).toEqual([A.gone])
  })
})
