// The way back from a rebuilt store, and the one thing it must never do.
//
// Since July the browser engine has torn down its own database under the
// running app four times. Each time a recovery with a heuristic in it decided
// which of his projects came back, and the last time it left the 112 clip one
// behind. These pin the replacement: a file whose id the store has lost is put
// back AS IT IS, and a file whose id the store still has is never touched.

import { describe, expect, it } from 'vitest'
import type { ProjectFileEntry } from '../../electron/ipc-types'
import { newProject, type Project } from '../engine/types'
import { serialize } from './backupFormat'
import {
  healStoreFromDisk,
  missingFromStore,
  parseProjectFile,
  trashProjectOnDisk,
  writeProjectToDisk,
  type DiskApi,
} from './diskProjects'

const project = (id: string, name: string, updatedAt = 1): Project => ({ ...newProject(), id, name, updatedAt })

const row = (id: string, name: string, updatedAt = 1): ProjectFileEntry => ({
  id,
  name,
  path: `C:/Users/skyle/Documents/OL Premiere Projects/${name}_${id.slice(0, 8)}.olpbak`,
  updatedAt,
  sizeBytes: 100,
})

/** A disk that holds whatever it is given and remembers every call. */
function fakeDisk(files: Project[]): DiskApi & { wrote: string[]; trashed: string[]; reads: string[] } {
  const byPath = new Map<string, string>()
  const rows: ProjectFileEntry[] = []
  for (const p of files) {
    const r = row(p.id, p.name, p.updatedAt)
    rows.push(r)
    byPath.set(r.path, serialize(p, 'test'))
  }
  const api = {
    wrote: [] as string[],
    trashed: [] as string[],
    reads: [] as string[],
    projectWrite: (id: string, name: string) => {
      api.wrote.push(`${name}_${id}`)
      return Promise.resolve('')
    },
    projectList: () => Promise.resolve(rows),
    projectRead: (path: string) => {
      api.reads.push(path)
      const raw = byPath.get(path)
      return raw === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(raw)
    },
    projectTrash: (id: string) => {
      api.trashed.push(id)
      return Promise.resolve(1)
    },
  }
  return api
}

describe('which files to put back', () => {
  it('is every file the store has no record for, and nothing else', () => {
    const onDisk = [row('green', 'Green'), row('spirit', 'Spirit'), row('blank', 'Untitled Project')]
    expect(missingFromStore(onDisk, new Set(['spirit'])).map((r) => r.id)).toEqual(['green', 'blank'])
    expect(missingFromStore(onDisk, new Set(['green', 'spirit', 'blank']))).toEqual([])
  })

  it('⛔ never a file whose project is in the store, however old the store copy looks', () => {
    // The store copy is the one being edited right now. A file that says it is
    // newer is a file that was written by a save the store has since moved past,
    // or a clock that lied. Either way the store wins while it exists.
    const onDisk = [row('green', 'Green', 9_999_999_999)]
    expect(missingFromStore(onDisk, new Set(['green']))).toEqual([])
  })
})

describe('reading a file back', () => {
  it('returns the project inside, with its own id and its own name, nothing renamed', () => {
    const p = project('ab9fe413-4312', 'Green', 5)
    const back = parseProjectFile(serialize(p, 'desktop'), 'ab9fe413-4312')
    expect(back?.id).toBe('ab9fe413-4312')
    expect(back?.name).toBe('Green')
    expect(back?.updatedAt).toBe(5)
  })

  it('⛔ refuses a file whose id is not the one the listing promised', () => {
    // A file edited by hand into another project's id must not overwrite that
    // project on its way back in.
    const p = project('other', 'Impostor')
    expect(parseProjectFile(serialize(p, 'desktop'), 'ab9fe413-4312')).toBeNull()
  })

  it('refuses a half file and a file that is not a project', () => {
    expect(parseProjectFile('{"project":{"id":"a1","na', 'a1')).toBeNull()
    expect(parseProjectFile('{"hello":1}', 'a1')).toBeNull()
    expect(parseProjectFile('{"project":{"id":"a1","name":"x"}}', 'a1')).toBeNull()
  })
})

describe('healing the store', () => {
  it('⛔ puts back every project the store lost, as it was, with no judgement about its media', async () => {
    // The case that lost Green on 2026-09-12: the store is empty, the files are
    // there, one project has 66 media files none of which the store can see.
    // It comes back. Media is healed separately when it opens.
    const green = project('ab9fe413', 'Green', 3)
    green.assets = { m1: { id: 'm1', name: 'clip.mp4', blobKey: 'asset/m1' } as never }
    const spirit = project('73819893', 'Spirit', 2)
    const disk = fakeDisk([green, spirit])
    const store = new Map<string, Project>()
    const healed = await healStoreFromDisk(
      disk,
      async () => new Set(store.keys()),
      async (p) => {
        store.set(p.id, p)
      },
    )
    expect(healed.names).toEqual(['Green', 'Spirit'])
    expect(store.get('ab9fe413')?.name).toBe('Green')
    expect(store.get('ab9fe413')?.assets.m1?.blobKey).toBe('asset/m1')
    expect(store.get('73819893')?.name).toBe('Spirit')
  })

  it('reads nothing and writes nothing when the store already has every file', async () => {
    const disk = fakeDisk([project('a1', 'Green'), project('b2', 'Spirit')])
    const store = new Map<string, Project>([
      ['a1', project('a1', 'Green')],
      ['b2', project('b2', 'Spirit')],
    ])
    const healed = await healStoreFromDisk(
      disk,
      async () => new Set(store.keys()),
      async () => {
        throw new Error('must not write')
      },
    )
    expect(healed.names).toEqual([])
    expect(disk.reads).toEqual([])
  })

  it('is quiet in the browser build, where there is no disk', async () => {
    const healed = await healStoreFromDisk(null, async () => new Set(), async () => {})
    expect(healed.names).toEqual([])
  })

  it('one unreadable file does not stop the others coming back', async () => {
    const disk = fakeDisk([project('a1', 'Green'), project('b2', 'Spirit')])
    const broken = (await disk.projectList())[1]
    disk.projectRead = (path: string) =>
      path === broken.path ? Promise.reject(new Error('EBUSY')) : Promise.resolve(serialize(project('a1', 'Green'), 't'))
    const store = new Map<string, Project>()
    const healed = await healStoreFromDisk(
      disk,
      async () => new Set(store.keys()),
      async (p) => {
        store.set(p.id, p)
      },
    )
    expect(healed.names).toEqual(['Green'])
  })
})

describe('the disk side of a save and a delete', () => {
  it('writes the file under the project name and id', async () => {
    const disk = fakeDisk([])
    await writeProjectToDisk(project('a1', 'Green'), disk)
    expect(disk.wrote).toEqual(['Green_a1'])
  })

  it('⛔ a failed file write fails the save, so Saved is never shown over a copy that is only in the store', async () => {
    const disk = fakeDisk([])
    disk.projectWrite = () => Promise.reject(new Error('EACCES'))
    await expect(writeProjectToDisk(project('a1', 'Green'), disk)).rejects.toThrow('EACCES')
  })

  it('a delete moves the file to Trash, and a failure there is not a failed delete', async () => {
    const disk = fakeDisk([])
    await trashProjectOnDisk('a1', disk)
    expect(disk.trashed).toEqual(['a1'])
    disk.projectTrash = () => Promise.reject(new Error('EBUSY'))
    await expect(trashProjectOnDisk('a1', disk)).resolves.toBeUndefined()
  })

  it('does nothing without a disk', async () => {
    await expect(writeProjectToDisk(project('a1', 'Green'), null)).resolves.toBeUndefined()
    await expect(trashProjectOnDisk('a1', null)).resolves.toBeUndefined()
  })
})
