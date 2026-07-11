// Save/load a project as a single self-contained file — a manual backup for when
// the IndexedDB autosave can't be trusted (private mode, quota, corruption, a
// wiped browser). The file bundles the project document AND every referenced
// media blob (base64), so a restore is complete even if IndexedDB was cleared.

import { migrateProjectEffects } from '../engine/effects/migrate'
import { migrateProject, type Project } from '../engine/types'
import { getBlob, putBlob, saveProject } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

export const PROJECT_FILE_FORMAT = 'olstudio-project'
export const PROJECT_FILE_VERSION = 1
export const PROJECT_FILE_EXT = 'olstudio.json'

interface BlobEntry {
  key: string
  type: string
  /** base64 of the blob bytes. */
  data: string
}

export interface ProjectFile {
  format: string
  version: number
  project: Project
  blobs: BlobEntry[]
}

// Chunked so a large media buffer can't blow the argument limit of fromCharCode.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Every blob key a project references (media + thumbnails), de-duped. */
export function blobKeysOf(project: Project): string[] {
  const keys = new Set<string>()
  for (const asset of Object.values(project.assets)) {
    if (asset.blobKey) keys.add(asset.blobKey)
    if (asset.thumbnailKey) keys.add(asset.thumbnailKey)
  }
  return [...keys]
}

/** A filesystem-safe base name from the project name. */
export function projectFileName(name: string): string {
  const safe = name.replace(/[^\w\- ]+/g, '').trim() || 'project'
  return `${safe}.${PROJECT_FILE_EXT}`
}

/** Serialize the current project + its media into one downloadable file. */
export async function exportProjectToFile(): Promise<void> {
  const show = useToasts.getState().show
  const project = useStore.getState().project
  try {
    const blobs: BlobEntry[] = []
    for (const key of blobKeysOf(project)) {
      const blob = await getBlob(key)
      if (!blob) continue // a missing blob just isn't bundled; the rest still restores
      const bytes = new Uint8Array(await blob.arrayBuffer())
      blobs.push({ key, type: blob.type, data: bytesToBase64(bytes) })
    }
    const bundle: ProjectFile = {
      format: PROJECT_FILE_FORMAT,
      version: PROJECT_FILE_VERSION,
      project,
      blobs,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = projectFileName(project.name)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    show(`Saved project file — ${blobs.length} media item(s) bundled`, 'success')
  } catch (err) {
    console.warn('OL Studio: project export failed', err)
    show('Could not save the project file', 'danger')
  }
}

/** Restore a project (+ its media) from a file, replacing the current one. */
export async function importProjectFromFile(file: File): Promise<void> {
  const show = useToasts.getState().show
  try {
    const bundle = JSON.parse(await file.text()) as Partial<ProjectFile>
    if (bundle.format !== PROJECT_FILE_FORMAT || !bundle.project) {
      show('That is not an OL Studio project file', 'danger')
      return
    }
    // Restore media first so the project's blob references resolve.
    for (const b of bundle.blobs ?? []) {
      await putBlob(b.key, new Blob([base64ToBytes(b.data)], { type: b.type || 'application/octet-stream' }))
    }
    const project = migrateProjectEffects(migrateProject(bundle.project as Project))
    await saveProject(project)
    useStore.getState().setProject(project)
    useStore.getState().setUI({ selection: [] })
    show(`Opened "${project.name}"`, 'success')
  } catch (err) {
    console.warn('OL Studio: project import failed', err)
    show('Could not open that project file', 'danger')
  }
}
