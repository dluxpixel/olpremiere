// The disk side of a save, and the way back when the browser store is gone.
//
// A project is a file in Documents (electron/projectFiles.ts). This module is
// the renderer's half: write the file on every save, and before any listing,
// put back into the browser store every file whose project is not there.
//
// ⛔ PUT BACK, NOT RECOVERED. The four wipes since July each ended in a
// "(recovered)" copy with a new id, a new name, and a heuristic deciding which
// of his projects deserved to come back. The last one decided his 112 clip
// project did not. Here nothing decides anything: a file whose id is missing
// from the store is written into the store as it is, with its own id and its
// own name. Media that is missing is healed separately when the project opens,
// the same as it always was.
//
// Pure where it can be. The store and the desktop api are passed in, so the
// decisions here run under test without IndexedDB or Electron.

import type { ProjectFileEntry } from '../../electron/ipc-types'
import type { Project } from '../engine/types'
import { parseStoredProject } from '../persistence/schema'
import { serialize } from './backupFormat'

export interface DiskApi {
  projectWrite(id: string, projectName: string, json: string): Promise<string>
  projectList(): Promise<ProjectFileEntry[]>
  projectRead(filePath: string): Promise<string>
  projectTrash(id: string): Promise<number>
}

/** The desktop api, or null in the browser build where there is no disk to write. */
export function diskApi(): DiskApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  if (!api?.isElectron || !api.projectWrite || !api.projectList || !api.projectRead) return null
  return api
}

/**
 * The file for one project, written after the browser store. REJECTS when the
 * write fails, so the caller's save fails with it: a save that landed in the
 * store the engine keeps rebuilding, and nowhere else, is not a save he can
 * trust, and the "Could not save" toast is the honest answer.
 */
export async function writeProjectToDisk(p: Project, api: DiskApi | null = diskApi()): Promise<void> {
  if (!api) return
  await api.projectWrite(p.id, p.name ?? 'Untitled Project', serialize(p, 'desktop'))
}

/** His delete, mirrored. The file goes to Trash; a failure here is logged, never thrown. */
export async function trashProjectOnDisk(id: string, api: DiskApi | null = diskApi()): Promise<void> {
  if (!api) return
  try {
    await api.projectTrash(id)
  } catch (err) {
    console.warn('OL Premiere: the project file could not be moved to Trash', err)
  }
}

/**
 * The rows the store is missing. Pure: given what is on disk and which ids the
 * store holds, say which files to read back. Never a file whose id is present,
 * whatever their times say, because the store copy is the one being edited.
 */
export function missingFromStore(
  onDisk: readonly ProjectFileEntry[],
  inStore: ReadonlySet<string>,
): ProjectFileEntry[] {
  return onDisk.filter((row) => !inStore.has(row.id))
}

/**
 * Turn one file back into a project, or null when it is not one. The id inside
 * must be the id the listing reported, so a file edited by hand into another
 * project's id cannot overwrite that project on the way in.
 */
export function parseProjectFile(raw: string, expectedId: string): Project | null {
  let parsed: { project?: Project }
  try {
    parsed = JSON.parse(raw) as { project?: Project }
  } catch {
    return null
  }
  const p = parsed?.project
  if (!p || typeof p !== 'object') return null
  if (p.id !== expectedId) return null
  // The same gate the store load uses: a half written or hand edited file must
  // not be put back into the store as if it were a project.
  return parseStoredProject(p)
}

export interface HealedProjects {
  /** Names of the projects put back, for the toast. */
  names: string[]
}

/**
 * Put back every project on disk that the store has lost. Returns what came
 * back so the caller can say so. Quiet when there is nothing to do, which is
 * every boot on a healthy machine: one folder listing, one key listing.
 */
export async function healStoreFromDisk(
  api: DiskApi | null,
  storeIds: () => Promise<ReadonlySet<string>>,
  put: (p: Project) => Promise<void>,
): Promise<HealedProjects> {
  const names: string[] = []
  if (!api) return { names }
  let rows: ProjectFileEntry[]
  try {
    rows = await api.projectList()
  } catch (err) {
    console.warn('OL Premiere: could not read the project files', err)
    return { names }
  }
  if (rows.length === 0) return { names }
  const missing = missingFromStore(rows, await storeIds())
  for (const row of missing) {
    try {
      const project = parseProjectFile(await api.projectRead(row.path), row.id)
      if (!project) continue
      await put(project)
      names.push(project.name ?? 'Untitled Project')
    } catch (err) {
      console.warn(`OL Premiere: could not put ${row.name} back from its file`, err)
    }
  }
  return { names }
}
