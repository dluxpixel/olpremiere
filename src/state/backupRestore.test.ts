// Recovering an automatic backup.
//
// The rule this file exists to hold: RECOVERING NEVER DESTROYS. It is reached
// for at the worst possible moment, when work has apparently gone missing and he
// is guessing which of forty files is the right one, so picking wrong has to
// cost nothing but another click.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../engine/types'

const saved: Project[] = []
const opened: string[] = []
const toasts: { text: string; kind: string }[] = []
let backupText = ''
/** Blob keys that still have their bytes. Everything else counts as missing. */
let liveBlobKeys = new Set<string>()

/** The projects the store holds, for the sweep. */
let shelf: Project[] = []
const deleted: string[] = []

vi.mock('./persistence', () => ({
  saveProject: (p: Project) => {
    saved.push(p)
    return Promise.resolve()
  },
  getBlob: (key: string) => Promise.resolve(liveBlobKeys.has(key) ? new Blob(['x']) : null),
  listProjects: () =>
    Promise.resolve(
      shelf.map((p) => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
        assetCount: Object.keys(p.assets ?? {}).length,
        clipCount: 0,
      })),
    ),
  loadProjectById: (id: string) => Promise.resolve(shelf.find((p) => p.id === id) ?? null),
  deleteProject: (id: string) => {
    deleted.push(id)
    shelf = shelf.filter((p) => p.id !== id)
    return Promise.resolve()
  },
}))
vi.mock('./projectActions', () => ({
  openProject: (id: string) => {
    opened.push(id)
    return Promise.resolve()
  },
}))
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (text: string, kind = 'info') => void toasts.push({ text, kind }) }) },
}))

/** Backups keyed by path, for the tests that need more than one file on disk. */
let backupFiles: Record<string, string> = {}
let backupRows: { path: string; name: string; modifiedMs: number; sizeBytes: number }[] = []
/** The one thing the auto recovery remembers between boots. */
const store = new Map<string, string>()

const { readBackup, restoreBackup, recoverFromWipe, sweepEmptyRecoveries } = await import('./backupRestore')
const { markDoNotAutoRecover } = await import('./recoveryMemory')

const backupOf = (project: unknown, mediaNames: Record<string, string> = {}) =>
  JSON.stringify({ kind: 'ol-premiere-backup', version: 1, savedAt: '', appVersion: 'desktop', project, mediaNames })

/** A project as the backup file holds it: one sequence, one clip, one asset. */
const projectFixture = (over: Record<string, unknown> = {}) => ({
  id: 'old-project',
  name: 'Pear',
  createdAt: 10,
  updatedAt: 20,
  assets: { a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'blob-1', durationS: 5 } },
  sequences: {
    'old-seq': {
      id: 'old-seq',
      name: 'Sequence 1',
      fps: 30,
      width: 1920,
      height: 1080,
      durationS: 5,
      markers: [],
      tracks: [
        {
          id: 't1',
          kind: 'video',
          name: 'V1',
          clips: [{ id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 5, speed: 1, effects: [] }],
        },
      ],
    },
  },
  activeSequenceId: 'old-seq',
  ...over,
})

beforeEach(() => {
  saved.length = 0
  opened.length = 0
  toasts.length = 0
  liveBlobKeys = new Set(['blob-1'])
  backupText = backupOf(projectFixture())
  backupFiles = {}
  backupRows = []
  store.clear()
  ;(globalThis as { window?: unknown }).window = {
    api: {
      backupRead: (p: string) => Promise.resolve(backupFiles[p] ?? backupText),
      backupList: () => Promise.resolve(backupRows),
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  }
})

describe('reading a backup tells him what is in it', () => {
  it('counts the clips and the media, without changing anything', async () => {
    const contents = await readBackup('C:/backups/one.olpbak')
    expect(contents?.clipCount).toBe(1)
    expect(contents?.assetCount).toBe(1)
    expect(contents?.project.name).toBe('Pear')
    expect(saved).toHaveLength(0)
  })

  it('says nothing rather than guessing when the file is not readable', async () => {
    backupText = 'this is not json'
    expect(await readBackup('C:/backups/broken.olpbak')).toBeNull()
  })

  it('refuses a file that parses but carries no project', async () => {
    backupText = backupOf(null)
    expect(await readBackup('C:/backups/empty.olpbak')).toBeNull()
  })
})

describe('recovering never destroys', () => {
  it('lands as a NEW project rather than over the old one', async () => {
    expect(await restoreBackup('C:/backups/one.olpbak')).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].id).not.toBe('old-project')
    expect(saved[0].name).toBe('Pear (recovered)')
    expect(opened).toEqual([saved[0].id])
  })

  it('gives the sequences fresh ids too, so two projects can never share one', async () => {
    await restoreBackup('C:/backups/one.olpbak')
    const ids = Object.keys(saved[0].sequences)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('old-seq')
    // The pointer follows the rename, or the editor opens on nothing.
    expect(saved[0].activeSequenceId).toBe(ids[0])
    expect(saved[0].sequences[ids[0]].id).toBe(ids[0])
    // The edit itself came through untouched.
    expect(saved[0].sequences[ids[0]].tracks[0].clips).toHaveLength(1)
  })

  it('does not file the recovery away, whatever shelf the original was on', async () => {
    backupText = backupOf(projectFixture({ archivedAt: 5, laterAt: 6 }))
    await restoreBackup('C:/backups/one.olpbak')
    expect(saved[0].archivedAt).toBeUndefined()
    expect(saved[0].laterAt).toBeUndefined()
  })

  it('names the files to re-import when their bytes are gone', async () => {
    liveBlobKeys = new Set()
    await restoreBackup('C:/backups/one.olpbak')
    expect(toasts.at(-1)?.text).toContain('clip.mp4')
  })

  it('just says how much came back when the media is all still there', async () => {
    await restoreBackup('C:/backups/one.olpbak')
    expect(toasts.at(-1)?.text).toBe('Recovered 1 clips')
    expect(toasts.at(-1)?.kind).toBe('success')
  })

  it('saves nothing and opens nothing when the file cannot be read', async () => {
    backupText = 'not json at all'
    expect(await restoreBackup('C:/backups/broken.olpbak')).toBe(false)
    expect(saved).toHaveLength(0)
    expect(opened).toHaveLength(0)
  })
})

// --- Opening blank while the copies are on the disk ---------------------------

describe('the app never opens empty while his backups exist', () => {
  const rows = (...paths: string[]) =>
    paths.map((p, i) => ({ path: p, name: p, modifiedMs: 1000 - i, sizeBytes: 10 }))

  /** Storage as `listProjects` reports it: an empty store, or one blank project. */
  const emptyStore = [{ clipCount: 0, assetCount: 0 }]

  beforeEach(() => {
    store.clear()
  })

  it('brings the newest real backup back when storage came up with nothing', async () => {
    backupFiles = { 'C:/b/new.olpbak': backupOf(projectFixture({ name: 'Pear' })) }
    backupRows = rows('C:/b/new.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got).toEqual({ name: 'Pear', clipCount: 1, assetCount: 1, projectCount: 1 })
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('Pear (recovered)')
  })

  /** Two clips on one track, so this project is plainly the bigger of the two. */
  const bigFixture = (over: Record<string, unknown> = {}) => {
    const base = projectFixture(over) as { sequences: Record<string, { tracks: { clips: unknown[] }[] }> }
    const track = Object.values(base.sequences)[0].tracks[0]
    track.clips = [...track.clips, { id: 'c2', assetId: 'a1', startS: 6, inS: 0, outS: 5, speed: 1, effects: [] }]
    return base
  }

  it('brings back EVERY project the wipe took, not just the newest file', async () => {
    backupFiles = {
      'C:/b/small.olpbak': backupOf(projectFixture({ id: 'p-small', name: 'Test' })),
      'C:/b/big.olpbak': backupOf(bigFixture({ id: 'p-big', name: 'The Short' })),
    }
    backupRows = rows('C:/b/small.olpbak', 'C:/b/big.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.projectCount).toBe(2)
    expect(saved.map((p) => p.name).sort()).toEqual(['Test (recovered)', 'The Short (recovered)'])
  })

  it('leaves the BIGGEST edit open, because that is the one he is looking for', async () => {
    backupFiles = {
      'C:/b/small.olpbak': backupOf(projectFixture({ id: 'p-small', name: 'Test' })),
      'C:/b/big.olpbak': backupOf(bigFixture({ id: 'p-big', name: 'The Short' })),
    }
    backupRows = rows('C:/b/small.olpbak', 'C:/b/big.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.name).toBe('The Short')
    const bigOne = saved.find((p) => p.name === 'The Short (recovered)')!
    expect(opened).toEqual([bigOne.id])
  })

  // ⛔ FOUND ON HIS SCREEN, 2026-08-22. He opened the app and got SIX rows all
  // called "Untitled Project (recovered)", and the one that OPENED was a wall of
  // caption harness fixtures a test run had left in his backups folder. Their
  // media were imported into a throwaway profile and have never existed in his
  // store, so each came back as a shell he cannot play, cannot export, and did
  // not ask for.
  it('leaves behind a project whose media are ALL gone, because there is no edit left to rescue', async () => {
    backupFiles = {
      'C:/b/his.olpbak': backupOf(projectFixture({ id: 'p-his', name: 'The Short' })),
      'C:/b/junk.olpbak': backupOf(
        bigFixture({ id: 'p-junk', name: 'harness', assets: { a1: { id: 'a1', name: '9-music-only-rigid-60s.wav', kind: 'audio', blobKey: 'gone', durationS: 60 } } }),
      ),
    }
    backupRows = rows('C:/b/his.olpbak', 'C:/b/junk.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.projectCount).toBe(1)
    expect(saved.map((p) => p.name)).toEqual(['The Short (recovered)'])
  })

  // Some missing media is a different thing: the edit took him hours and the
  // files can be imported again.
  it('still brings back a project that is only PARTLY missing its media', async () => {
    backupFiles = {
      'C:/b/part.olpbak': backupOf(
        projectFixture({
          id: 'p-part',
          name: 'Half here',
          assets: {
            a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'blob-1', durationS: 5 },
            a2: { id: 'a2', name: 'gone.mp4', kind: 'video', blobKey: 'vanished', durationS: 5 },
          },
        }),
      ),
    }
    backupRows = rows('C:/b/part.olpbak')
    expect((await recoverFromWipe(emptyStore))?.projectCount).toBe(1)
  })

  // ⛔ It used to sort on clip count alone, which is exactly why a 122 clip
  // harness timeline opened over his own 44 clip edit.
  it('opens the one that most nearly WORKS, even when a deader project is longer', async () => {
    backupFiles = {
      'C:/b/his.olpbak': backupOf(projectFixture({ id: 'p-his', name: 'The Short' })),
      'C:/b/halfdead.olpbak': backupOf(
        bigFixture({
          id: 'p-halfdead',
          name: 'Mostly gone',
          assets: {
            a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'blob-1', durationS: 5 },
            a2: { id: 'a2', name: 'gone.mp4', kind: 'video', blobKey: 'vanished', durationS: 5 },
          },
        }),
      ),
    }
    backupRows = rows('C:/b/his.olpbak', 'C:/b/halfdead.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.projectCount).toBe(2)
    // Both have exactly one live file, so the longer one wins the tie as before.
    expect(got?.name).toBe('Mostly gone')
  })

  it('counts what will actually come back, never what was found', async () => {
    backupFiles = {
      'C:/b/his.olpbak': backupOf(projectFixture({ id: 'p-his', name: 'The Short' })),
      'C:/b/junk.olpbak': backupOf(
        projectFixture({ id: 'p-junk', name: 'harness', assets: { a1: { id: 'a1', name: 'x.wav', kind: 'audio', blobKey: 'gone', durationS: 1 } } }),
      ),
    }
    backupRows = rows('C:/b/his.olpbak', 'C:/b/junk.olpbak')
    await recoverFromWipe(emptyStore)
    expect(toasts[0].text).toContain('project was')
    expect(toasts[0].text).not.toContain('2 projects')
  })

  it('keeps only the NEWEST file of each project, never forty copies of one', async () => {
    backupFiles = {
      'C:/b/newer.olpbak': backupOf(projectFixture({ name: 'Pear now' })),
      'C:/b/older.olpbak': backupOf(projectFixture({ name: 'Pear then' })),
    }
    backupRows = rows('C:/b/newer.olpbak', 'C:/b/older.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.projectCount).toBe(1)
    expect(saved[0].name).toBe('Pear now (recovered)')
  })

  it('says WHY the work came back, before it comes back', async () => {
    backupFiles = { 'C:/b/new.olpbak': backupOf(projectFixture()) }
    backupRows = rows('C:/b/new.olpbak')
    await recoverFromWipe(emptyStore)
    expect(toasts[0].text).toContain('missing when the app opened')
  })

  it('stays out of the way when he already has work', async () => {
    backupFiles = { 'C:/b/new.olpbak': backupOf(projectFixture()) }
    backupRows = rows('C:/b/new.olpbak')
    expect(await recoverFromWipe([{ clipCount: 12, assetCount: 4 }])).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('treats media with no clips as work too, so an import in progress is not overwritten', async () => {
    backupFiles = { 'C:/b/new.olpbak': backupOf(projectFixture()) }
    backupRows = rows('C:/b/new.olpbak')
    expect(await recoverFromWipe([{ clipCount: 0, assetCount: 3 }])).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('does nothing on a genuinely new install, where there are no backups at all', async () => {
    backupRows = []
    expect(await recoverFromWipe(emptyStore)).toBeNull()
    expect(toasts).toHaveLength(0)
  })

  it('skips the blank backups a wiped app writes about itself', async () => {
    const blank = projectFixture({ assets: {}, sequences: { s: { id: 's', name: 'S', fps: 30, width: 1920, height: 1080, durationS: 0, markers: [], tracks: [] } }, activeSequenceId: 's' })
    backupFiles = {
      'C:/b/blank.olpbak': backupOf(blank),
      'C:/b/real.olpbak': backupOf(projectFixture({ name: 'Pear' })),
    }
    backupRows = rows('C:/b/blank.olpbak', 'C:/b/real.olpbak')
    const got = await recoverFromWipe(emptyStore)
    expect(got?.name).toBe('Pear')
    expect(saved).toHaveLength(1)
  })

  it('hands the same file back ONCE, so throwing away a recovery is respected', async () => {
    backupFiles = { 'C:/b/new.olpbak': backupOf(projectFixture()) }
    backupRows = rows('C:/b/new.olpbak')
    expect(await recoverFromWipe(emptyStore)).not.toBeNull()
    saved.length = 0
    expect(await recoverFromWipe(emptyStore)).toBeNull()
    expect(saved).toHaveLength(0)
  })
})

describe('work he threw away himself stays thrown away', () => {
  it('never hands back a project he deleted, however many backups it has', async () => {
    backupFiles = { 'C:/b/gone.olpbak': backupOf(projectFixture({ id: 'binned', name: 'Binned' })) }
    backupRows = [{ path: 'C:/b/gone.olpbak', name: 'gone', modifiedMs: 5, sizeBytes: 10 }]
    markDoNotAutoRecover(['binned'])
    expect(await recoverFromWipe([{ clipCount: 0, assetCount: 0 }])).toBeNull()
    expect(saved).toHaveLength(0)
  })
})

// ⛔ CLEANING UP AFTER AN EARLIER VERSION OF MYSELF. A restore before 2.23 handed
// back projects whose media had never existed in this store, and his shelf ended
// up with five he could not open and did not ask for. Leaving him to bin them by
// hand would be handing him my mistake as a chore, and until 2.23 binning one
// could also have taken the footage of the row beside it.
describe('the recovered projects that turned out to be nothing get cleared away', () => {
  const proj = (over: Partial<Project> & { id: string }): Project =>
    ({
      name: 'Untitled Project (recovered)',
      createdAt: 100,
      updatedAt: 100,
      assets: { a1: { id: 'a1', name: 'x.wav', kind: 'audio', blobKey: 'gone', durationS: 1 } },
      sequences: {},
      ...over,
    }) as unknown as Project

  beforeEach(() => {
    deleted.length = 0
    toasts.length = 0
    liveBlobKeys = new Set(['blob-1'])
  })

  it('clears a recovered project whose media are all missing', async () => {
    shelf = [proj({ id: 'junk' })]
    expect(await sweepEmptyRecoveries(null)).toBe(1)
    expect(deleted).toEqual(['junk'])
    expect(toasts[0].text).toContain('Cleared 1 recovered project')
  })

  it('never touches a project he named himself, however empty it looks', async () => {
    shelf = [proj({ id: 'his', name: 'MY EDIT' })]
    expect(await sweepEmptyRecoveries(null)).toBe(0)
    expect(deleted).toEqual([])
  })

  it('never touches one whose media are still there', async () => {
    shelf = [proj({ id: 'alive', assets: { a1: { id: 'a1', name: 'c.mp4', kind: 'video', blobKey: 'blob-1', durationS: 5 } } as unknown as Project['assets'] })]
    expect(await sweepEmptyRecoveries(null)).toBe(0)
    expect(deleted).toEqual([])
  })

  // ⛔ The guard that stops this ever eating a real edit whose media were also
  // lost: he has opened or changed it since it landed.
  it('never touches one he has touched since it landed', async () => {
    shelf = [proj({ id: 'edited', updatedAt: 999 })]
    expect(await sweepEmptyRecoveries(null)).toBe(0)
    expect(deleted).toEqual([])
  })

  it('never closes the project he is looking at', async () => {
    shelf = [proj({ id: 'open-one' })]
    expect(await sweepEmptyRecoveries('open-one')).toBe(0)
    expect(deleted).toEqual([])
  })

  it('leaves a recovered project that carries no media at all, because that is a title card edit', async () => {
    shelf = [proj({ id: 'titles', assets: {} as Project['assets'] })]
    expect(await sweepEmptyRecoveries(null)).toBe(0)
    expect(deleted).toEqual([])
  })

  it('says nothing when there was nothing to clear', async () => {
    shelf = []
    expect(await sweepEmptyRecoveries(null)).toBe(0)
    expect(toasts).toEqual([])
  })
})
