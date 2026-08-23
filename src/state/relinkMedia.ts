// PUTTING HIS MEDIA BACK ON HIS EDIT.
//
// ⛔ HIS WORDS, 2026-08-23, five days after he stopped opening the app: *"The
// recovered file doesn't even fucking work. The audio is not there, and the
// video isn't."* A project whose asset records survived while their bytes did
// not draws as a timeline of named clips with no picture and no sound, and until
// now the only thing the app said was which files to import again. Importing
// them makes NEW assets with new ids, so every one of his forty four cuts would
// still point at nothing. The edit is the part that took him hours.
//
// So this re-attaches the bytes UNDER THE EXISTING KEY. Nothing in the document
// changes: same asset ids, same blobKeys, same clips, same keyframes. The only
// thing that moves is what `getBlob` answers with.

import type { MediaAsset, Project } from '../engine/types'
import { mirrorAsset } from './mediaMirror'
import { getBlob, putBlob } from './persistence'

/** An asset whose record is here and whose bytes are not. */
export interface MissingAsset {
  id: string
  name: string
  blobKey: string
}

/**
 * Which of a project's assets have lost their bytes.
 *
 * Assets with no `blobKey` at all (titles, adjustment layers) are not media and
 * are never counted, or every project would look broken.
 */
export async function missingMedia(project: Project): Promise<MissingAsset[]> {
  const out: MissingAsset[] = []
  for (const a of Object.values(project.assets ?? {}) as MediaAsset[]) {
    if (!a?.blobKey) continue
    if (await getBlob(a.blobKey)) continue
    out.push({ id: a.id, name: a.name ?? a.blobKey, blobKey: a.blobKey })
  }
  return out
}

const stemOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return (i > 0 ? name.slice(0, i) : name).toLowerCase().trim()
}

export interface Match {
  asset: MissingAsset
  file: File
}
export interface MatchResult {
  matched: Match[]
  /** Assets he did not hand over a file for. */
  stillMissing: MissingAsset[]
  /** Files that matched nothing, so he can be told rather than left guessing. */
  unused: File[]
}

/**
 * Pair the files he picked with the assets that lost their bytes, BY NAME.
 *
 * ⛔ EXACT NAME FIRST, then case-insensitive, then the name without its
 * extension. The last rung is what makes this survive a round trip through a
 * phone or a re-encode, where `Voice recording 12.webm` comes back as
 * `Voice recording 12.m4a` and is still the take he recorded.
 *
 * ⛔ AND ONE FILE IS USED ONCE. Two assets can carry the same name (he has
 * imported the same recording twice before), and without this the second one
 * would silently take the first one's file and both clips would play the same
 * audio, which is worse than staying broken because it looks fine.
 */
export function matchFilesToMissing(missing: readonly MissingAsset[], files: readonly File[]): MatchResult {
  const pool = [...files]
  const matched: Match[] = []
  const stillMissing: MissingAsset[] = []

  const take = (pred: (f: File) => boolean): File | null => {
    const i = pool.findIndex(pred)
    return i === -1 ? null : pool.splice(i, 1)[0]
  }

  for (const asset of missing) {
    const file =
      take((f) => f.name === asset.name) ??
      take((f) => f.name.toLowerCase() === asset.name.toLowerCase()) ??
      take((f) => stemOf(f.name) === stemOf(asset.name))
    if (file) matched.push({ asset, file })
    else stillMissing.push(asset)
  }
  return { matched, stillMissing, unused: pool }
}

/**
 * Write the matched files back under the keys the document already points at.
 *
 * ⛔ IT WRITES BYTES AND NOTHING ELSE. No asset is created, renamed, re-probed or
 * re-measured: a mismatch between the file's real duration and the one the clip
 * was cut against is HIS to see and judge, and silently retiming forty four cuts
 * to fit a file he picked would be the worst thing this could do.
 */
export async function relink(matches: readonly Match[]): Promise<{ done: number; failed: string[] }> {
  let done = 0
  const failed: string[] = []
  for (const m of matches) {
    try {
      await putBlob(m.asset.blobKey, m.file)
      // ⛔ AND ON TO THE DISK, IN THE SAME BREATH.
      //
      // HIS WORDS, 2026-08-23, after the fourth blank app of the day: *"it still
      // says [40] for the media error, which fuckin' sucks. We should fix that
      // somehow."* He was about to hand this function every file for a hundred
      // and seven cuts. Until now those bytes went into IndexedDB and NOWHERE
      // ELSE, so the next time the engine rebuilt its database his whole repair
      // went with it and he would be picking the same files again.
      //
      // `backfillMirror` was supposed to cover this, but it only runs at boot on
      // the project already open, and a boot is exactly when the rebuild happens.
      // The repair has to be durable at the moment he makes it, not one restart
      // later.
      //
      // Never awaited for correctness and never throws: a mirror that fails costs
      // him the safety net, and a mirror that failed the RELINK would cost him
      // the repair itself, which is the thing he just did the work for.
      void mirrorAsset(m.asset.id, m.file).catch(() => undefined)
      done += 1
    } catch {
      failed.push(m.asset.name)
    }
  }
  return { done, failed }
}

/** The sentence he reads. Kept here so the wording is tested with the matching. */
export function relinkSummary(r: MatchResult, done: number): string {
  if (done === 0) return `None of those matched. Still missing: ${r.stillMissing.map((m) => m.name).join(', ')}`
  const head = `Put ${done} ${done === 1 ? 'file' : 'files'} back on your edit`
  const left = r.stillMissing.length > 0 ? `. Still missing ${r.stillMissing.length}: ${r.stillMissing.map((m) => m.name).slice(0, 3).join(', ')}` : ''
  const spare = r.unused.length > 0 ? `. ${r.unused.length} did not match anything` : ''
  return `${head}${left}${spare}`
}
