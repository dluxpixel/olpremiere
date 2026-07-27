// Save/load a project as a single self-contained file, a manual backup for when
// the IndexedDB autosave can't be trusted (private mode, quota, corruption, a
// wiped browser).
//
// Format v2 is BINARY: [magic "OLSTPROJ"][u32 header length][header JSON][raw
// blob bytes...]. The file Blob is COMPOSED from the header + the original
// media Blobs. Browsers assemble that by reference, so saving a multi-GB
// project allocates almost nothing and never builds a giant string. (v1
// base64-JSON built the whole bundle as one string on the main thread; a real
// gameplay capture froze the tab and then died on the string length limit:
// "couldn't save the project file".) Import reads the header, then slices the
// File lazily per blob. v1 files still open.

import { migrateProjectEffects } from '../engine/effects/migrate'
import { migrateProject, type Project } from '../engine/types'
import { getBlob, putBlob, saveProject } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

export const PROJECT_FILE_FORMAT = 'olstudio-project'
export const PROJECT_FILE_VERSION = 2
export const PROJECT_FILE_EXT = 'olstudio'
/** 8-byte magic at the start of a v2 binary project file. */
export const PROJECT_FILE_MAGIC = 'OLSTPROJ'

interface BlobMeta {
  key: string
  type: string
  /** Byte length of this blob's raw data in the file body. */
  size: number
}

export interface ProjectFileHeader {
  format: string
  version: number
  project: Project
  blobs: BlobMeta[]
}

/** v1 (legacy JSON) shapes, kept for back-compat import. */
interface LegacyBlobEntry {
  key: string
  type: string
  data: string
}
interface LegacyProjectFile {
  format: string
  version: number
  project: Project
  blobs: LegacyBlobEntry[]
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

// ---------------------------------------------------------------------------
// v2 binary layout helpers (pure, unit-tested)

/** [magic 8][u32le header length][header JSON utf-8] */
export function encodeHeader(header: ProjectFileHeader): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(8 + 4 + json.length)
  out.set(new TextEncoder().encode(PROJECT_FILE_MAGIC), 0)
  new DataView(out.buffer).setUint32(8, json.length, true)
  out.set(json, 12)
  return out
}

/** True when the first bytes carry the v2 magic. */
export function isBinaryProjectFile(first8: Uint8Array): boolean {
  return new TextDecoder().decode(first8.subarray(0, 8)) === PROJECT_FILE_MAGIC
}

/**
 * Parse the header from the file's opening bytes. Returns the header plus the
 * offset where blob data begins, or null when the prefix is malformed.
 */
export function decodeHeader(prefix: Uint8Array): { header: ProjectFileHeader; bodyOffset: number } | null {
  if (prefix.length < 12 || !isBinaryProjectFile(prefix)) return null
  const len = new DataView(prefix.buffer, prefix.byteOffset).getUint32(8, true)
  if (prefix.length < 12 + len) return null
  try {
    const header = JSON.parse(new TextDecoder().decode(prefix.subarray(12, 12 + len))) as ProjectFileHeader
    if (header.format !== PROJECT_FILE_FORMAT || !header.project || !Array.isArray(header.blobs)) return null
    return { header, bodyOffset: 12 + len }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------

/**
 * Serialize the current project + its media into one file. The Blob is composed
 * by REFERENCE (no copies); with the File System picker it streams to disk,
 * otherwise it downloads. Never builds the media into strings.
 */
export async function exportProjectToFile(): Promise<void> {
  const show = useToasts.getState().show
  const project = useStore.getState().project
  try {
    const metas: BlobMeta[] = []
    const parts: Blob[] = []
    for (const key of blobKeysOf(project)) {
      const blob = await getBlob(key)
      if (!blob) continue // a missing blob just isn't bundled; the rest still restores
      metas.push({ key, type: blob.type, size: blob.size })
      parts.push(blob)
    }
    const header = encodeHeader({
      format: PROJECT_FILE_FORMAT,
      version: PROJECT_FILE_VERSION,
      project,
      blobs: metas,
    })
    const file = new Blob([header, ...parts], { type: 'application/octet-stream' })
    const name = projectFileName(project.name)

    if (typeof globalThis.showSaveFilePicker === 'function') {
      let handle: FileSystemFileHandle
      try {
        handle = await globalThis.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'OL Studio project', accept: { 'application/octet-stream': [`.${PROJECT_FILE_EXT}`] } }],
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return // user cancelled
        throw err
      }
      const writable = await handle.createWritable()
      await file.stream().pipeTo(writable) // streams; bounded memory at any size
    } else {
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }
    show(`Saved project file with ${metas.length} media item(s) bundled`, 'success')
  } catch (err) {
    console.warn('OL Studio: project export failed', err)
    show('Could not save the project file', 'danger')
  }
}

/** Restore a project (+ its media) from a file, replacing the current one. */
export async function importProjectFromFile(file: File): Promise<void> {
  const show = useToasts.getState().show
  try {
    const first = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (isBinaryProjectFile(first)) {
      // v2 binary: header length → header → lazy File.slice per blob (a slice
      // is a view, not a read; IDB pulls each blob's bytes one at a time).
      const headerLen = new DataView(first.buffer).getUint32(8, true)
      const prefix = new Uint8Array(await file.slice(0, 12 + headerLen).arrayBuffer())
      const decoded = decodeHeader(prefix)
      if (!decoded) {
        show('That project file is damaged', 'danger')
        return
      }
      let offset = decoded.bodyOffset
      for (const meta of decoded.header.blobs) {
        const blob = file.slice(offset, offset + meta.size, meta.type || 'application/octet-stream')
        offset += meta.size
        await putBlob(meta.key, blob)
      }
      await adoptProject(decoded.header.project)
      show(`Opened "${decoded.header.project.name}"`, 'success')
      return
    }

    // Legacy v1: one JSON document with base64 media.
    const bundle = JSON.parse(await file.text()) as Partial<LegacyProjectFile>
    if (bundle.format !== PROJECT_FILE_FORMAT || !bundle.project) {
      show('That is not an OL Studio project file', 'danger')
      return
    }
    for (const b of bundle.blobs ?? []) {
      await putBlob(b.key, new Blob([base64ToBytes(b.data)], { type: b.type || 'application/octet-stream' }))
    }
    await adoptProject(bundle.project)
    show(`Opened "${bundle.project.name}"`, 'success')
  } catch (err) {
    console.warn('OL Studio: project import failed', err)
    show('Could not open that project file', 'danger')
  }
}

async function adoptProject(raw: Project): Promise<void> {
  const project = migrateProjectEffects(migrateProject(raw))
  await saveProject(project)
  useStore.getState().setProject(project)
  useStore.getState().setUI({ selection: [] })
}
