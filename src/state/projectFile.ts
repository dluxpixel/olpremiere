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
import { migrateProjectAppearance } from '../engine/anim/appearance'
import { migrateProject, newId, type Project } from '../engine/types'
import { nextFreeName } from '../engine/uniqueName'
import { parseStoredProject } from '../persistence/schema'
import { backfillMirror } from './mediaMirror'
import { deleteBlob, getBlob, listProjects, loadProjectById, putBlob, saveProject, saveSettled } from './persistence'
import { flushOutgoing, guardRoom, switchTo } from './editTabs'
import { copyOfProject } from './projectActions'
import { forgetDoNotAutoRecover } from './recoveryMemory'
import { useStore } from './store'
import { useToasts } from './toasts'
import { plural } from '../engine/plural'

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
  /**
   * The document, carried VERBATIM. Nothing on this path picks fields off a
   * clip or a keyframe, so anything the engine adds rides through save and load
   * for free. `Keyframe.curve`, the hand-shaped bezier, is the current one, and
   * it needs no version bump for exactly that reason.
   *
   * If a strict validator or a field whitelist is ever added here it MUST carry
   * `curve`, or every curve he shaped by hand silently flattens back to its
   * named ease the next time he opens a project he already shipped from. That
   * failure is invisible until he reopens the file, which is why
   * projectFile.test.ts round-trips a curved keyframe: the test passes today and
   * exists to fail on that day.
   */
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
 * ONE door to the file picker, shared by the toolbar button and the keyboard
 * shortcut. The command palette was the third caller until it was cut on
 * 2026-08-17. The top bar owns the actual hidden input (it
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
  input.accept = `.${PROJECT_FILE_EXT},.olpbak,.json,application/octet-stream`
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
 *
 * `.olpbak` too: the file each project keeps in his Projects folder, in its
 * Trash and in the backups. Dropped on the window it used to read
 * "Green_ab9fe413.olpbak: couldn't import (unsupported?)".
 */
export function isProjectFileName(name: string): boolean {
  return /\.(olstudio(\.json)?|olpbak)$/i.test(name.trim())
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
  return `That project file is incomplete: ${missing} of ${total} media ${total === 1 ? 'item is' : 'items are'} missing. Copy it again.`
}

/** "Gameplay cut" becomes "Gameplay cut (copy)", and stays that way if reimported. */
export function copyName(name: string): string {
  const trimmed = name.trim()
  return trimmed.endsWith('(copy)') ? trimmed : `${trimmed} (copy)`
}

/**
 * True when the copy HERE has changed since the incoming edit last shared a save
 * with it, so the incoming one must not replace it, however new it is.
 *
 * ⛔ NEWER IS NOT ENOUGH. He sends GYM to his phone at 18:00, keeps editing it on
 * the PC until 19:00, edits on the phone until 20:00 and sends it back. The phone
 * copy is newer, and opening it used to write over the PC's 19:00 work without a
 * word. It may replace the copy here only when that copy is still exactly the save
 * the phone started from (`fileBaseUpdatedAt`, kept on the edit when it was
 * opened, and on the sender's own copy when it was sent: rememberSent). A file
 * that does not say where it started from cannot prove that, so it lands beside,
 * never over.
 */
export function editedHereSince(here: Project, incoming: Project): boolean {
  if (here.updatedAt === incoming.updatedAt) return false
  return incoming.fileBaseUpdatedAt !== here.updatedAt
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

/** The open project packed as one file, footage included, ready to hand over. */
export interface BuiltProjectFile {
  file: File
  /** Media items that went into it. */
  bundled: number
  /** Media items the project uses that could not be read, so are NOT in it. */
  absent: number
  /** The save it carries, so the copy here can remember it was sent (rememberSent). */
  sent: { id: string; updatedAt: number }
}

/**
 * Pack the current project + its media into one file. The Blob is composed by
 * REFERENCE (no copies), so a multi-GB project costs almost nothing to build.
 * Never builds the media into strings.
 */
export async function buildProjectFile(): Promise<BuiltProjectFile> {
  const project = useStore.getState().project
  const wanted = blobKeysOf(project)
  const metas: BlobMeta[] = []
  const parts: Blob[] = []
  for (const key of wanted) {
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
  const file = new File([header, ...parts], projectFileName(project.name), { type: 'application/octet-stream' })
  return {
    file,
    bundled: metas.length,
    absent: wanted.length - metas.length,
    sent: { id: project.id, updatedAt: project.updatedAt },
  }
}

/**
 * The copy here remembers which save just went out, so the NEXT copy sent from
 * here says where it starts from.
 *
 * ⛔ WITHOUT THIS EVERY RESEND LANDED AS A COPY. He sends GYM from the PC and the
 * phone opens it, so the phone knows it holds that save. He edits more on the PC
 * and sends again, but the PC copy had never been opened from a file, so the new
 * one could not say it started from the save the phone has, and the phone kept
 * landing "GYM (copy)" beside an untouched GYM. Now the PC copy carries the save
 * it sent (`fileBaseUpdatedAt`), its next send carries that, and an untouched
 * phone copy is replaced in place.
 *
 * Not an edit: `updatedAt` is untouched and no undo step is made, the same way a
 * project is filed under Later (persistence.ts stampOpenProject). A stamp that
 * does not land costs one copy beside it later, never a loss.
 */
export async function rememberSent(sent: BuiltProjectFile['sent']): Promise<void> {
  try {
    const live = useStore.getState().project
    if (live.id === sent.id) {
      if (live.fileBaseUpdatedAt === sent.updatedAt) return
      useStore.setState({ project: { ...live, fileBaseUpdatedAt: sent.updatedAt } })
      // Through the one save path, so it can never land under a newer autosave.
      await saveSettled(true)
      return
    }
    // He moved to another edit while it was being written: stamp the stored copy.
    const stored = await loadProjectById(sent.id)
    if (stored && stored.fileBaseUpdatedAt !== sent.updatedAt) {
      await saveProject({ ...stored, fileBaseUpdatedAt: sent.updatedAt })
    }
  } catch (err) {
    console.warn('OL Premiere: could not note which save of the project was sent', err)
  }
}

/** Say when the bundle is short. A copy that quietly left media behind is a lie. */
function reportBuilt(built: BuiltProjectFile, verb: string): void {
  const show = useToasts.getState().show
  const total = built.bundled + built.absent
  if (built.absent > 0) {
    show(`${verb}, but ${built.absent} of ${total} media ${total === 1 ? 'item' : 'items'} ${built.absent === 1 ? 'was' : 'were'} missing and ${built.absent === 1 ? 'is' : 'are'} NOT in the file`, 'danger')
  } else {
    show(`${verb} with ${plural(built.bundled, 'media item')} bundled`, 'success')
  }
}

/** True where the system share sheet can take a whole project file. */
export function canShareProjectFile(built: BuiltProjectFile): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [built.file] })
}

/**
 * COPY A PROJECT TO ANOTHER DEVICE (2026-09-25). His words: "make it so I can
 * copy projects from one to another". The project file already carried every
 * clip and all its footage, and opening one anywhere adds the project, so the
 * copy was always possible on the desktop; the phone could neither send nor
 * open one. On a phone the file goes to the SHARE SHEET (Telegram, Save to
 * Files, anything he has), because a phone has no save dialog.
 *
 * ⛔ CALLED FROM ITS OWN TAP, with the file already built. A share must come
 * from a gesture, and building a big project reads every clip first, long
 * enough for Safari to decide the tap is over. So the caller builds, shows a
 * Send button, and this runs from that second tap.
 */
export async function shareProjectFile(built: BuiltProjectFile): Promise<boolean> {
  try {
    await navigator.share({ files: [built.file], title: built.file.name })
    reportBuilt(built, 'Sent the project')
    await rememberSent(built.sent)
    return true
  } catch (err) {
    // Closing the sheet is not a failure: the copy is still ready to send.
    if (err instanceof DOMException && err.name === 'AbortError') return false
    console.warn('OL Premiere: project share failed', err)
    useToasts.getState().show('Could not open the share sheet for the project. Try again', 'danger')
    return false
  }
}

/** One slice of a project file per trip to main: the same 8 MB the spare copies use. */
const WRITE_SLICE = 8 * 1024 * 1024

/** "2.8 GB", "640 MB": a size in the words the drive's own dialogs use. */
function sizeWords(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** True for a failure that is the drive being full, however it was spelled on the way. */
export function isDiskFull(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /ENOSPC|no space|not enough space|disk is full/i.test(text)
}

/**
 * Serialize the current project + its media into one file. With the File
 * System picker it streams to disk, otherwise it downloads.
 *
 * `onProgress` hears the share written, 0 to 1, on the desktop, where the copy
 * carries all his footage and takes a while (mc night is about 2.8 GB).
 */
export async function exportProjectToFile(onProgress?: (frac: number) => void): Promise<void> {
  const show = useToasts.getState().show
  let need = 0
  try {
    const built = await buildProjectFile()
    const file = built.file
    const name = file.name

    // ⛔ ON THE DESKTOP, A NUMBERED NAME IN HIS LAST FOLDER, NEVER A REPLACE
    // PROMPT, 2026-09-28 (electron/saveFiles.ts). The browser's own picker cannot
    // look in the folder first, so the desktop app asks main, which can.
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (api?.isElectron && api.pickSavePath && api.fileOpenWrite && api.fileWriteChunk && api.fileClose) {
      const target = await api.pickSavePath('project', name.replace(/\.[^.]+$/, ''), PROJECT_FILE_EXT, 'OL Premiere project')
      if (!target) return // he cancelled
      need = file.size
      // Main checks the drive has room for all of it before a byte is written.
      const id = await api.fileOpenWrite(target, file.size)
      let ok = false
      try {
        // ⛔ 8 MB SLICES, NOT THE STREAM'S OWN CHUNKS. A stream hands over small
        // pieces, one awaited trip to main each, thousands of them for one
        // project with footage in it.
        for (let off = 0; off < file.size; off += WRITE_SLICE) {
          await api.fileWriteChunk(id, await file.slice(off, off + WRITE_SLICE).arrayBuffer())
          onProgress?.(Math.min(1, (off + WRITE_SLICE) / file.size))
        }
        ok = true
      } finally {
        await api.fileClose(id, ok)
      }
      reportBuilt(built, 'Saved project file')
      await rememberSent(built.sent)
      return
    }

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
    reportBuilt(built, 'Saved project file')
    await rememberSent(built.sent)
  } catch (err) {
    console.warn('OL Premiere: project export failed', err)
    // Say WHY when it is the drive: on his 97% full drive that is the likely one.
    if (isDiskFull(err)) {
      show(`Not enough space on the drive for this copy${need > 0 ? ` (needs ${sizeWords(need)})` : ''}`, 'danger')
    } else show('Could not save the project file', 'danger')
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
    const bundle = JSON.parse(await file.text()) as Partial<LegacyProjectFile> & { kind?: unknown }
    if (bundle.kind === 'ol-premiere-backup' && bundle.project) {
      await adoptProjectRecord(bundle.project, show)
      return
    }
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
 * The copy an earlier open of this same save already landed, untouched since:
 * the same project stamps (`createdAt`, `updatedAt`) under another id, starting
 * from this save. Null when there is none.
 *
 * ⛔ ONE COPY PER SAVE, NOT ONE PER OPEN. A file that cannot say where it started
 * from (every file from before this update) lands beside the project rather than
 * over it, and opening it again landed another copy each time, with another set
 * of its footage in the store, on a drive that is 97% full.
 */
async function copyAlreadyLanded(incoming: Project): Promise<Project | null> {
  let rows: Awaited<ReturnType<typeof listProjects>>
  try {
    rows = await listProjects()
  } catch {
    return null
  }
  for (const row of rows) {
    if (row.id === incoming.id || row.updatedAt !== incoming.updatedAt || row.createdAt !== incoming.createdAt) continue
    const p = await loadProjectById(row.id)
    if (p && p.fileBaseUpdatedAt === incoming.updatedAt) return p
  }
  return null
}

/**
 * Put back, from the file in his hand, every byte of `copy` the store has lost
 * since the copy landed. The copy holds the file's media under keys of its own
 * (planProjectCopy), so each one is matched by asset id. Returns how many it put.
 *
 * ⛔ THE FILE IN HIS HAND CARRIES THEM. Opening the same file again only switched
 * to the copy it landed before, and dropped the file's bytes: a copy whose bytes
 * the store had lost since (a wipe, a sweep) opened with its media missing while
 * the footage sat in the file he had just opened.
 */
async function refillLandedCopy(
  incoming: Project,
  copy: Project,
  writes: readonly { key: string; blob: Blob }[],
): Promise<number> {
  const inFile = new Map(writes.map((w) => [w.key, w.blob]))
  let put = 0
  for (const [id, asset] of Object.entries(incoming.assets)) {
    const mine = copy.assets[id]
    if (!mine) continue
    const pairs: [string | undefined, string | undefined][] = [
      [asset.blobKey, mine.blobKey],
      [asset.thumbnailKey, mine.thumbnailKey],
    ]
    for (const [from, to] of pairs) {
      const blob = from ? inFile.get(from) : undefined
      if (!blob || !to) continue
      try {
        if (await getBlob(to)) continue
        await putBlob(to, blob)
        put += 1
      } catch (err) {
        // The copy still opens, as it did before; the file is still in his hand.
        console.warn('OL Premiere: could not put media back into the copy from its file', err)
      }
    }
  }
  // And on to the disk, the same as any import (adoptImported).
  if (put > 0) void backfillMirror(copy).catch(() => undefined)
  return put
}

/** Every project name in the store, so a copy gets one of its own. Empty when it cannot be read. */
async function takenNames(): Promise<Set<string>> {
  try {
    return new Set((await listProjects()).map((s) => s.name))
  } catch {
    return new Set()
  }
}

/**
 * Open one of his own `.olpbak` files: the document only, no footage inside. Its
 * media are found when it opens, in the store or in the spare copies on disk.
 *
 * - Its id is not here (a project he deleted, a file from Trash): it is put back
 *   as it is, same id and name, the way the Projects folder refills a lost store.
 * - The same save is already here: that project simply opens.
 * - A different save of a project he has: it lands beside it as a copy, so
 *   neither one is written over.
 */
async function adoptProjectRecord(raw: unknown, show: Show): Promise<void> {
  const parsed = parseStoredProject(raw)
  if (!parsed) {
    show('That project file is damaged', 'danger')
    return
  }
  if (!(await flushOutgoing())) return
  const project = migrateProjectAppearance(migrateProjectEffects(migrateProject(parsed)))
  const existing = await loadProjectById(project.id)
  if (existing && existing.updatedAt === project.updatedAt) {
    await switchTo(project.id, { announce: true })
    return
  }
  let landed = project
  // Unknown names only cost the plain name.
  if (existing) landed = copyOfProject(project, nextFreeName(project.name, await takenNames()))
  await saveProject(landed)
  // Brought back on purpose, so a later wipe may bring it back too.
  if (!existing) forgetDoNotAutoRecover([landed.id])
  if ((await switchTo(landed)) !== 'ok') return
  show(existing ? `Opened "${landed.name}". Your "${existing.name}" was kept.` : `Opened "${landed.name}"`, 'success')
}

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

  let project = migrateProjectAppearance(migrateProjectEffects(migrateProject(raw)))
  let finalWrites = writes
  let kept: string | null = null

  // Only the INCOMING side can become the copy. Both documents reference the same
  // blob keys, and it is the file's bytes that are about to be written, so giving
  // the incoming project fresh keys is the only way to keep both projects' media
  // intact without duplicating gigabytes.
  const existing = await loadProjectById(project.id)
  const newerHere = existing !== null && existing.updatedAt > project.updatedAt
  if (existing && (newerHere || editedHereSince(existing, project))) {
    const before = await copyAlreadyLanded(project)
    if (before) {
      // Its footage is in the store under the copy's own keys, and any the store
      // has lost since comes back from this file.
      await refillLandedCopy(project, before, writes)
      if ((await switchTo(before.id)) !== 'ok') return
      show(`Opened "${before.name}", the copy this file made before. Your "${existing.name}" was kept.`, 'success')
      return
    }
    // A random suffix, not a clock one. Two imports whose timestamps agreed would
    // mint the SAME "private" keys, and deleting one copy would then empty the
    // other, because blobs are deleted by the keys in the document being removed
    // with no reference counting.
    const plan = planProjectCopy(project, newId(), newId())
    // A name of its own: a second copy is "GYM (copy)_1", never a second "GYM (copy)".
    project = { ...plan.project, name: nextFreeName(plan.project.name, await takenNames()) }
    finalWrites = writes.map((w) => ({ key: plan.keyMap[w.key] ?? w.key, blob: w.blob }))
    kept = existing.name
  }
  // Where this edit now starts from, so sending it back later can be judged.
  project = { ...project, fileBaseUpdatedAt: project.updatedAt }

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

  // ⛔ AND ON TO THE DISK. Opening a project file is the path he reaches for
  // AFTER losing a store, so bytes that arrive this way having only one copy
  // would leave him one rebuild from doing it all again. `backfillMirror` reads
  // them straight back out of IndexedDB, where they were written a moment ago,
  // and skips anything already on disk, so it needs no key map of its own and
  // handles the copy path's suffixed keys by reading the final document.
  // Fire and forget: a mirror must never fail an import.
  void backfillMirror(project).catch(() => undefined)

  if (project.id === useStore.getState().project.id) {
    // The open edit, restored over itself from its own file.
    useStore.getState().setProject(project)
    useStore.getState().setUI({ selection: [] })
  } else if ((await switchTo(project)) !== 'ok') {
    // It is saved and in Projects; the switch has already said why it stayed put.
    return
  }
  // Say WHY the name changed, or a copy appearing out of nowhere reads as a bug.
  show(
    kept
      ? newerHere
        ? `Opened "${project.name}". Your newer "${kept}" was kept.`
        : `Opened "${project.name}". Your "${kept}" changed on this device too, so both were kept.`
      : `Opened "${project.name}"`,
    'success',
  )
}
