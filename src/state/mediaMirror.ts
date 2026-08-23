// THE SECOND HOME FOR HIS FOOTAGE, AND THE REPAIR THAT READS IT BACK.
//
// ⛔ WHAT THIS IS FOR, IN HIS WORDS, 2026-08-23: *"This is the reason I haven't
// opened the app in five days."* The browser engine threw its own IndexedDB away
// and started again. His project records came back from the automatic backups;
// his MEDIA could not, because the only copy the app had was inside that same
// database. The bytes were still on his disk the whole time, in Chromium's blob
// folder, with nothing left able to name them.
//
// ⛔ AND HIS INSTRUCTION: *"make sure this shit never happens again, no matter
// what fucking change you make."* A test cannot promise that, because the thing
// that broke is not in this codebase. What CAN promise it is not keeping his
// footage in one place. So every import writes a second copy as a plain file
// named by the asset id, and a project whose media the database has lost repairs
// itself from those files on the next launch, before he sees a black timeline.
//
// ⛔ IT IS A MIRROR, NOT A MOVE. IndexedDB stays the fast path everything reads.
// Nothing else in the app learns this folder exists, and a machine with no
// desktop shell (the web build) simply has no mirror and behaves as before.

import { getBlob, putBlob } from './persistence'
import type { MediaAsset, Project } from '../engine/types'

/** 8 MB, the same step every other big-file path here uses. */
const CHUNK = 8 * 1024 * 1024

interface MediaApi {
  mediaList(): Promise<{ dir: string; error?: string; files: { id: string; size: number }[] }>
  mediaBegin(id: string): Promise<boolean>
  mediaChunk(id: string, bytes: ArrayBuffer): Promise<void>
  mediaFinish(id: string): Promise<number>
  mediaCancel(id: string): Promise<void>
  mediaRead(id: string, offset: number, length: number): Promise<ArrayBuffer | null>
  mediaDelete(id: string): Promise<void>
}

/**
 * The desktop shell, or null on the web build, which has no disk to mirror to.
 *
 * ⛔ IT ASKS FOR THE METHODS, NOT FOR `isElectron`. The methods ARE the
 * capability: a shell that cannot answer `mediaBegin` cannot mirror whatever it
 * calls itself. It also used to demand the flag, which meant nothing could stand
 * in for the shell without ALSO claiming to be Electron, and claiming that makes
 * the boot sequence reach for a dozen other calls that are not there. That is
 * not a testing detail: it is the difference between this path being provable
 * and being taken on trust, and it has already gone wrong on his machine twice.
 */
export function mirrorApi(): MediaApi | null {
  const api = (globalThis as { api?: Partial<MediaApi> }).api
  if (!api) return null
  const has = (k: keyof MediaApi): boolean => typeof api[k] === 'function'
  return has('mediaBegin') && has('mediaList') && has('mediaRead') ? (api as MediaApi) : null
}

/**
 * Write one asset's bytes to the folder outside the database.
 *
 * Never throws and never blocks an import: a mirror that fails costs him the
 * safety net, and a mirror that THROWS would cost him the import itself, which
 * is far worse. Returns whether the copy landed.
 */
export async function mirrorAsset(assetId: string, bytes: Blob): Promise<boolean> {
  const api = mirrorApi()
  if (!api || bytes.size === 0) return false
  try {
    if (!(await api.mediaBegin(assetId))) return false
    for (let off = 0; off < bytes.size; off += CHUNK) {
      await api.mediaChunk(assetId, await bytes.slice(off, off + CHUNK).arrayBuffer())
    }
    await api.mediaFinish(assetId)
    return true
  } catch (err) {
    console.warn('OL Premiere: could not keep a spare copy of this media', err)
    await api.mediaCancel(assetId).catch(() => undefined)
    return false
  }
}

/** Read one asset's copy back off the disk, or null when there is not one. */
export async function readMirrored(assetId: string, size: number): Promise<Blob | null> {
  const api = mirrorApi()
  if (!api || size <= 0) return null
  try {
    // ⛔ EACH CHUNK BECOMES A Blob IMMEDIATELY, so a 1.37 GB source never sits on
    // the JS heap. The browser's blob store is disk backed; an array of
    // ArrayBuffers is not.
    const parts: Blob[] = []
    for (let off = 0; off < size; off += CHUNK) {
      const buf = await api.mediaRead(assetId, off, Math.min(CHUNK, size - off))
      if (!buf) return null
      parts.push(new Blob([buf]))
    }
    return new Blob(parts)
  } catch (err) {
    console.warn('OL Premiere: could not read the spare copy of this media', err)
    return null
  }
}

export interface HealResult {
  /** Assets the database had lost and the disk had. */
  healed: string[]
  /** Assets the database had lost and the disk did not have either. */
  lost: string[]
  /**
   * Why the repair could not even look, in words.
   *
   * ⛔ A SILENT FAILURE IS THE ONE THING THIS MUST NEVER DO. He opened v2.27 to a
   * banner saying his media was gone and nothing anywhere saying what had been
   * tried, which cost another round of his patience.
   */
  failure?: string
}

/**
 * Put back every asset in this project whose bytes the database has lost.
 *
 * ⛔ THIS IS THE WHOLE POINT OF THE MIRROR AND IT RUNS BEFORE HE SEES ANYTHING.
 * It writes under the key the document ALREADY points at, so nothing in the edit
 * moves: same asset ids, same blobKeys, same clips, same keyframes.
 *
 * A project with nothing missing costs one storage read per asset and writes
 * nothing, so this is safe to run on every launch.
 */
export async function healProjectMedia(
  project: Project,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<HealResult> {
  const api = mirrorApi()
  const healed: string[] = []
  const lost: string[] = []
  if (!api) return { healed, lost }

  const assets = Object.values(project.assets ?? {}) as MediaAsset[]
  const missing = assets.filter((a) => a?.blobKey)
  if (missing.length === 0) return { healed, lost }

  // One listing, not one existence check per asset.
  //
  // ⛔ AND IF THE LISTING ITSELF FAILS, SAY SO. It used to swallow the error and
  // return an empty map, which reads downstream as "nothing on disk" and puts
  // every asset in `lost` with no reason attached anywhere. He opened v2.27 to a
  // banner and no explanation, which is the worst possible way to find out.
  const onDisk = new Map<string, number>()
  let listing: { dir: string; error?: string; files: { id: string; size: number }[] }
  try {
    listing = await api.mediaList()
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    console.warn('OL Premiere: could not read the spare media folder', err)
    return { healed, lost: missing.map((a) => a.name ?? a.id), failure: `could not read the spare copies: ${why}` }
  }
  for (const m of listing.files) onDisk.set(m.id, m.size)
  if (onDisk.size === 0) {
    // ⛔ NAME THE FOLDER IT LOOKED IN. On 2026-08-23 this said "there are no spare
    // copies" while 23 files and 7.1 GB sat in the folder I had filled by hand,
    // and there was no way to tell a wrong path from an unreadable one from an
    // empty one. A repair that cannot say WHERE it looked cannot be diagnosed
    // from his side of the screen, and he has lost days to exactly that.
    const why = listing.error ? `${listing.error} in ${listing.dir}` : `nothing in ${listing.dir}`
    return { healed, lost: missing.map((a) => a.name ?? a.id), failure: why }
  }

  // ⛔ COUNT WHAT IS ACTUALLY GOING TO BE MOVED BEFORE MOVING ANY OF IT. His own
  // repair is 1.38 GB across twenty files, which is the better part of a minute,
  // and the boot card showing a silent row for that long after five days without
  // his editor would read as "still broken".
  const toHeal: MediaAsset[] = []
  for (const a of missing) {
    // ⛔ ASKED PER ASSET, INSIDE A TRY. A store that has been rebuilt underneath
    // the app can REJECT a read rather than answer null, and one throw here used
    // to abandon the whole repair: he opened v2.27 and got the banner instead of
    // his edit, with nothing on screen saying why.
    let has = false
    try {
      has = (await getBlob(a.blobKey)) !== null
    } catch {
      has = false
    }
    if (!has) toHeal.push(a)
  }
  let done = 0

  for (const a of toHeal) {
    onProgress?.(done, toHeal.length, a.name ?? a.id)
    done += 1
    const size = onDisk.get(a.id)
    if (!size) {
      lost.push(a.name ?? a.id)
      continue
    }
    const blob = await readMirrored(a.id, size)
    if (!blob || blob.size === 0) {
      lost.push(a.name ?? a.id)
      continue
    }
    try {
      await putBlob(a.blobKey, blob)
      healed.push(a.name ?? a.id)
    } catch (err) {
      console.warn(`OL Premiere: could not put ${a.name} back`, err)
      lost.push(a.name ?? a.id)
    }
  }
  return { healed, lost }
}

/**
 * Copy the media of a project that predates the mirror into it.
 *
 * ⛔ WITHOUT THIS THE GUARANTEE ONLY COVERS FOOTAGE HE IMPORTS FROM NOW ON, and
 * the edit he has been working on for a month would still have exactly one copy.
 * It skips anything already mirrored, so it costs one listing after the first
 * launch and never copies the same bytes twice.
 */
export async function backfillMirror(project: Project): Promise<number> {
  const api = mirrorApi()
  if (!api) return 0
  const listed = await api.mediaList().catch(() => ({ dir: '', files: [] as { id: string; size: number }[] }))
  const onDisk = new Set(listed.files.map((m) => m.id))
  let done = 0
  for (const a of Object.values(project.assets ?? {}) as MediaAsset[]) {
    if (!a?.blobKey || onDisk.has(a.id)) continue
    const blob = await getBlob(a.blobKey)
    if (!blob || blob.size === 0) continue
    if (await mirrorAsset(a.id, blob)) done += 1
  }
  return done
}
