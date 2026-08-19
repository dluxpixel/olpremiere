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

vi.mock('./persistence', () => ({
  saveProject: (p: Project) => {
    saved.push(p)
    return Promise.resolve()
  },
  getBlob: (key: string) => Promise.resolve(liveBlobKeys.has(key) ? new Blob(['x']) : null),
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

const { readBackup, restoreBackup } = await import('./backupRestore')

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
  ;(globalThis as { window?: unknown }).window = {
    api: { backupRead: () => Promise.resolve(backupText), backupList: () => Promise.resolve([]) },
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
