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
import { migrateProject, newId, type Project } from '../engine/types'
import { deleteBlob, getBlob, loadProjectById, putBlob, saveProject } from './persistence'
import { flushOutgoing, guardRoom } from './projectActions'
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

/**
 * ONE door to the file picker, shared by the toolbar button, the keyboard
 * shortcut and the command palette. The top bar owns the actual hidden input (it
 * is what the e2e drives), and registers it here so nothing has to grow a second
 * way in.
 */
let openPicker: (() => void) | null = null

export function registerProjectFilePicker(open: (() => void) | null): void {
  openPicker = open
}

export function openProjectFilePicker(): void {
  if (openPicker) {
    openPicker()
    return
  }
  // Fallback for anywhere the top bar is not mounted: a throwaway input.
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `.${PROJECT_FILE_EXT},.json,application/octet-stream`
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void importProjectFromFile(file)
  }
  input.click()
}

/**
 * True when a dropped file is a PROJECT rather than media.
 *
 * Dropping a project file onto the window used to hand it to the media importer,
 * which reported "couldn't import (unsupported?)" and left him believing his own
 * backup was broken. The file is the only bridge between the browser app and the
 * desktop app, so the most obvious gesture has to be the one that works.
 */
export function isProjectFileName(name: string): boolean {
  return /\.olstudio(\.json)?$/i.test(name.trim())
}

/**
 * Route a dropped set: a project file wins, and the rest are ignored rather than
 * imported alongside it. Importing media INTO the document that is about to be
 * replaced would either land in the wrong project or race the swap.
 */
export function routeDroppedFiles(files: File[]): { project: File | null; ignored: number; media: File[] } {
  const project = files.find((f) => isProjectFileName(f.name)) ?? null
  if (project) return { project, ignored: files.length - 1, media: [] }
  return { project: null, ignored: 0, media: files }
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
// Validation and copy planning (pure, unit-tested)

/**
 * True when the opening bytes look like a JSON document, which is what a legacy
 * v1 project file is. Used INSTEAD of a size limit: v1 inlined its media as
 * base64, so real v1 backups are large, and refusing them on size would lock him
 * out of the oldest files he owns. A 1.3 GB file that merely lost its magic bytes
 * does not begin with a brace, so it never reaches the whole-file read.
 */
export function looksLikeJson(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte === 0x7b) return true // '{'
    // Skip leading whitespace: space, tab, CR, LF, and a UTF-8 BOM.
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a && byte < 0x80) return false
  }
  return false
}

export interface BlobRange {
  key: string
  type: string
  start: number
  end: number
}

export type ImportPlan = { ok: true; ranges: BlobRange[] } | { ok: false; missing: number; total: number }

/**
 * Where every bundled blob's bytes live, checked against the file's REAL size.
 *
 * This is the guard that was missing. `Blob.slice` CLAMPS past the end of a file
 * instead of failing, so a copy that was truncated (a half-finished transfer, a
 * cancelled download, a full disk) used to import as a project whose media were
 * all zero bytes, and then report "Opened ..." as a success. Losing the media is
 * bad; being told it worked is worse, because that is what stops him keeping the
 * original.
 *
 * Trailing bytes AFTER the last blob are tolerated: extra data cannot cost him
 * anything, and refusing on it would reject files that are otherwise complete.
 */
export function planBlobRanges(blobs: BlobMeta[], bodyOffset: number, fileSize: number): ImportPlan {
  const ranges: BlobRange[] = []
  let offset = bodyOffset
  let missing = 0
  for (const meta of blobs) {
    const end = offset + meta.size
    // A size that is not a real byte count is treated as missing rather than
    // trusted. NaN comparisons are always false and a negative size walks the
    // offset BACKWARDS, so either one would sail past a plain `end > fileSize`
    // check and hand slice() an empty range: silent empty media, reported as a
    // success, which is the exact failure this function exists to stop.
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || end > fileSize) missing++
    else ranges.push({ key: meta.key, type: meta.type || 'application/octet-stream', start: offset, end })
    offset = end
  }
  return missing > 0 ? { ok: false, missing, total: blobs.length } : { ok: true, ranges }
}

export function incompleteFileMessage(missing: number, total: number): string {
  return `That project file is incomplete: ${missing} of ${total} media items are missing. Copy it again.`
}

/** "Gameplay cut" becomes "Gameplay cut (copy)", and stays that way if reimported. */
export function copyName(name: string): string {
  const trimmed = name.trim()
  return trimmed.endsWith('(copy)') ? trimmed : `${trimmed} (copy)`
}

export interface CopyPlan {
  project: Project
  /** Old blob key to new blob key, for the bytes this import is about to write. */
  keyMap: Record<string, string>
}

/**
 * Rebuild an incoming project under fresh ids, so opening an OLD file can never
 * overwrite a NEWER local project that happens to share its id.
 *
 * A project file keeps the id it was saved with, and the store is keyed by id, so
 * reopening last week's backup of a project he has edited since used to replace
 * the newer copy without a word. Both now survive: the file arrives beside it as
 * a copy, with its own media keys so neither one's bytes can be clobbered.
 */
export function planProjectCopy(project: Project, newProjectId: string, keySuffix: string): CopyPlan {
  const keyMap: Record<string, string> = {}
  const rename = (key: string): string => (keyMap[key] ??= `${key}-${keySuffix}`)
  const assets: Project['assets'] = {}
  for (const [id, asset] of Object.entries(project.assets)) {
    const next = { ...asset }
    if (asset.blobKey) next.blobKey = rename(asset.blobKey)
    if (asset.thumbnailKey) next.thumbnailKey = rename(asset.thumbnailKey)
    assets[id] = next
  }
  return { project: { ...project, id: newProjectId, name: copyName(project.name), assets }, keyMap }
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
    const wanted = blobKeysOf(project)
    const metas: BlobMeta[] = []
    const parts: Blob[] = []
    for (const key of wanted) {
      const blob = await getBlob(key)
      if (!blob) continue // a missing blob just isn't bundled; the rest still restores
      metas.push({ key, type: blob.type, size: blob.size })
      parts.push(blob)
    }
    const absent = wanted.length - metas.length
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
          types: [
            { description: 'OL Premiere project', accept: { 'application/octet-stream': [`.${PROJECT_FILE_EXT}`] } },
          ],
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
    // Say when the bundle is short. A backup that quietly left media behind is
    // the same lie as an import that quietly arrives without it.
    if (absent > 0) {
      show(`Saved, but ${absent} of ${wanted.length} media items were missing and are NOT in the file`, 'danger')
    } else {
      show(`Saved project file with ${metas.length} media item(s) bundled`, 'success')
    }
  } catch (err) {
    console.warn('OL Premiere: project export failed', err)
    show('Could not save the project file', 'danger')
  }
}

/**
 * Restore a project (+ its media) from a file, replacing the current one.
 *
 * Opening a file replaces the open document exactly the way switching projects
 * does, so it now takes the same care that path always took: leave a collab room
 * first, flush the outgoing project before it is dropped, refuse a file that
 * cannot deliver its media, and never overwrite a newer project of the same id.
 */
export async function importProjectFromFile(file: File): Promise<void> {
  const show = useToasts.getState().show
  if (!guardRoom()) return
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (isBinaryProjectFile(head)) {
      // v2 binary: header length, header, then a lazy File.slice per blob (a
      // slice is a view, not a read; IDB pulls each blob's bytes one at a time).
      const headerLen = new DataView(head.buffer, head.byteOffset).getUint32(8, true)
      // Clamp BEFORE slicing: a corrupt length would otherwise ask for the whole
      // file, and on a multi-GB project that read is the crash.
      if (headerLen === 0 || 12 + headerLen > file.size) {
        show('That project file is damaged', 'danger')
        return
      }
      const decoded = decodeHeader(new Uint8Array(await file.slice(0, 12 + headerLen).arrayBuffer()))
      if (!decoded) {
        show('That project file is damaged', 'danger')
        return
      }
      const plan = planBlobRanges(decoded.header.blobs, decoded.bodyOffset, file.size)
      if (!plan.ok) {
        show(incompleteFileMessage(plan.missing, plan.total), 'danger')
        return
      }
      await adoptImported(
        decoded.header.project,
        plan.ranges.map((r) => ({ key: r.key, blob: file.slice(r.start, r.end, r.type) })),
        show,
      )
      return
    }

    // Legacy v1: one JSON document with base64 media, read as a string.
    //
    // Decided on the OPENING BYTES, not on size. A v1 file inlines every blob as
    // base64, so a real one with any video in it is tens of megabytes: a size cap
    // here would refuse exactly the old backups this path exists to open, and tell
    // him his only copy was not a project file. A file that lost its magic bytes
    // does not start with a brace, which is the cheap check that actually
    // distinguishes them before the whole-file read.
    if (!looksLikeJson(head)) {
      show('That is not an OL Premiere project file', 'danger')
      return
    }
    const bundle = JSON.parse(await file.text()) as Partial<LegacyProjectFile>
    if (bundle.format !== PROJECT_FILE_FORMAT || !bundle.project) {
      show('That is not an OL Premiere project file', 'danger')
      return
    }
    await adoptImported(
      bundle.project,
      (bundle.blobs ?? []).map((b) => ({
        key: b.key,
        blob: new Blob([base64ToBytes(b.data)], { type: b.type || 'application/octet-stream' }),
      })),
      show,
    )
  } catch (err) {
    console.warn('OL Premiere: project import failed', err)
    show('Could not open that project file', 'danger')
  }
}

type Show = ReturnType<typeof useToasts.getState>['show']

/**
 * Write an imported project's media, then its document, then adopt it.
 *
 * Blobs go in first so the document never references bytes that are not there,
 * and if the document write fails they are DELETED again: media no project points
 * at is invisible to the user and reclaimed by nothing, which is how gigabytes go
 * missing without anything appearing to break.
 */
async function adoptImported(raw: Project, writes: { key: string; blob: Blob }[], show: Show): Promise<void> {
  // The open project is about to be replaced. If it cannot be saved, stop here
  // rather than trading his current edit for the one in the file.
  if (!(await flushOutgoing())) return

  let project = migrateProjectEffects(migrateProject(raw))
  let finalWrites = writes
  let kept: string | null = null

  // Only the INCOMING side can become the copy. Both documents reference the same
  // blob keys, and it is the file's bytes that are about to be written, so giving
  // the incoming project fresh keys is the only way to keep both projects' media
  // intact without duplicating gigabytes.
  const existing = await loadProjectById(project.id)
  if (existing && existing.updatedAt > project.updatedAt) {
    // A random suffix, not a clock one. Two imports whose timestamps agreed would
    // mint the SAME "private" keys, and deleting one copy would then empty the
    // other, because blobs are deleted by the keys in the document being removed
    // with no reference counting.
    const plan = planProjectCopy(project, newId(), newId())
    project = plan.project
    finalWrites = writes.map((w) => ({ key: plan.keyMap[w.key] ?? w.key, blob: w.blob }))
    kept = existing.name
  }

  // Only bytes this import CREATED may be rolled back. When the file restores in
  // place, it writes under the same keys the stored document already uses, and a
  // failed `saveProject` leaves that document live and still pointing at them:
  // deleting those keys would empty a project that survives the failure, while
  // telling him only that the import did not work. In the copy path every key is
  // freshly minted, so the rollback still reclaims everything it wrote.
  const preexisting = new Set<string>()
  for (const w of finalWrites) if (await getBlob(w.key)) preexisting.add(w.key)

  const written: string[] = []
  try {
    for (const w of finalWrites) {
      await putBlob(w.key, w.blob)
      written.push(w.key)
    }
    await saveProject(project)
  } catch (err) {
    for (const key of written) if (!preexisting.has(key)) await deleteBlob(key).catch(() => {})
    throw err
  }

  useStore.getState().setProject(project)
  useStore.getState().setUI({ selection: [] })
  // Say WHY the name changed, or a copy appearing out of nowhere reads as a bug.
  show(
    kept ? `Opened "${project.name}". Your newer "${kept}" was kept.` : `Opened "${project.name}"`,
    'success',
  )
}
