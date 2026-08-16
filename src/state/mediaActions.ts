// Media actions: import files into the bin (probe + persist blobs + ONE
// dispatch so the whole batch is a single undo step) and insert an asset
// onto the timeline at the playhead.

import { create } from 'zustand'
import { evictAsset } from '../engine/frameCache'
import { disposePreviewAsset } from '../engine/preview'
import { ensureProxies, forgetProxy } from '../engine/proxyMedia'
import { probeFile } from '../engine/probe'
import { canImport, remuxIfNeeded } from '../engine/remuxSource'
import { addClipFromAsset, addClipWithLinkedAudio, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  audioTracks,
  newId,
  videoTracks,
  type Id,
  type MediaAsset,
} from '../engine/types'
import { putBlob } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

/**
 * A storage-quota rejection, however the browser spells it. Chrome throws a
 * DOMException named QuotaExceededError; Firefox has historically used
 * NS_ERROR_DOM_QUOTA_REACHED, and idb can surface it wrapped in a plain Error.
 */
/**
 * Is this failure about SPACE rather than about the file?
 *
 * Getting this wrong is expensive in a specific way: the other branch says
 * "couldn't import (unsupported?)", which sends him off re-encoding footage
 * that was perfectly fine. That is exactly what happened on 2026-08-06, when
 * his drive hit ZERO bytes free and a normal mp4 was reported as unsupported.
 *
 * QuotaExceededError is only the tidy case. When the DISK itself is full,
 * rather than the origin's quota being reached, Chromium's IndexedDB surfaces
 * an UnknownError or an AbortError from the transaction, and the message often
 * says "disk", "space" or "full" instead of "quota". A file that decoded well
 * enough to be probed is never an unsupported file, so those all belong here.
 */
function isOutOfRoom(err: unknown): boolean {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  // The disk-full shapes: the transaction dies without a quota name on it.
  if (name === 'UnknownError' || name === 'AbortError' || name === 'InvalidStateError') return true
  return err instanceof Error && /quota|disk|space|full|storage/i.test(err.message)
}

/** Live import progress. `total: 0` means nothing is importing. */
export const useImportProgress = create<{ total: number; done: number; name: string }>(() => ({
  total: 0,
  done: 0,
  name: '',
}))

/** Optional tuning for one import batch. */
export interface ImportOptions {
  /**
   * Replaces "Imported 1 file(s)" on success. A still he just took is not a
   * file he went and found, and the toast should say the thing that happened.
   */
  successMessage?: string
}

export async function importFiles(files: File[], opts?: ImportOptions): Promise<void> {
  const show = useToasts.getState().show
  const imported: MediaAsset[] = []
  const failed: string[] = []
  const outOfRoom: string[] = []
  // A recording whose conversion failed, and one this build cannot convert at
  // all. Both are kept apart from the "unsupported" bucket, because that word
  // would send him off re-encoding footage that is perfectly fine, which is the
  // same mistake the out-of-room branch below already exists to avoid.
  const convertFailed: string[] = []
  const needsDesktop: string[] = []
  // Probing + copying every file's bytes into IndexedDB takes real time on
  // multi-GB captures, and until now the app showed NOTHING while it happened:
  // the drop overlay vanished on release and the panel sat on "Import media to
  // begin". Indistinguishable from a crash, so people drop the file again.
  useImportProgress.setState({ total: files.length, done: 0, name: files[0]?.name ?? '' })
  try {
    for (const [i, file] of files.entries()) {
      useImportProgress.setState({ total: files.length, done: i, name: file.name })
      try {
        // ⛔ HIS OWN OBS CAPTURES LAND HERE. A .mkv cannot be opened by Chromium
        // at all, so `probeFile` fails on it and the import used to end as
        // "unsupported" on footage that was perfectly fine. The desktop shell
        // changes the container first, copying the video rather than re-encoding
        // it, and everything below is then the same code an .mp4 has always run.
        // An .mp4 never enters this: `remuxIfNeeded` returns it untouched.
        if (!canImport(file.name)) {
          needsDesktop.push(file.name)
          continue
        }
        let source: File
        try {
          source = (await remuxIfNeeded(file)).file
        } catch (err) {
          // NOT "unsupported". The format is supported, the conversion of THIS
          // file failed, and those want opposite things from him. Same lesson as
          // the out-of-room branch below.
          console.warn('OL Premiere: could not convert', file.name, err)
          convertFailed.push(file.name)
          continue
        }
        const probe = await probeFile(source)
        const id = newId()
        const blobKey = 'asset/' + id
        await putBlob(blobKey, source)
        let thumbnailKey: string | undefined
        if (probe.thumbnailBlob) {
          thumbnailKey = 'thumb/' + id
          await putBlob(thumbnailKey, probe.thumbnailBlob)
        }
        imported.push({
          id,
          // What the asset actually IS now. The stem is his, so a capture is still
          // obviously his capture, and nothing claims to be a container the
          // stored bytes are not.
          name: source.name,
          kind: probe.kind,
          blobKey,
          durationS: probe.durationS,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
          fps: probe.fps,
          thumbnailKey,
          codec: undefined,
        })
      } catch (err) {
        // Running out of room is NOT a bad file, and saying "unsupported" sends
        // the user off re-encoding footage that was fine. Every import writes a
        // full second copy of the file into IndexedDB, so filling the origin quota
        // on gameplay captures is ordinary, not exotic.
        if (isOutOfRoom(err)) outOfRoom.push(file.name)
        else failed.push(file.name)
      }
    }
  } finally {
    useImportProgress.setState({ total: 0, done: 0, name: '' })
  }
  // ONE summary toast per failure KIND, never one per file (folder-drop flood).
  if (outOfRoom.length > 0) {
    // Say WHERE the room ran out. "Delete an old project" is the right advice
    // when the app's own storage is full and useless advice when the DRIVE is
    // full, and he cannot tell those apart from the message alone.
    show(
      outOfRoom.length === 1
        ? `No room left for ${outOfRoom[0]}. Free up space on your drive, or delete an old project`
        : `No room left for ${outOfRoom.length} files. Free up space on your drive, or delete an old project`,
      'danger',
    )
  }
  // Says what actually went wrong and what would fix it. A recording that needs
  // converting is not an unsupported file, and telling him it is would send him
  // re-encoding a capture that was always fine.
  if (convertFailed.length > 0) {
    show(
      convertFailed.length === 1
        ? `${convertFailed[0]}: this recording could not be converted. It may still be being written, or the end of it is damaged`
        : `${convertFailed.length} recordings could not be converted`,
      'danger',
    )
  }
  if (needsDesktop.length > 0) {
    show(
      needsDesktop.length === 1
        ? `${needsDesktop[0]}: recordings like this need the desktop app, the browser cannot open them`
        : `${needsDesktop.length} recordings need the desktop app`,
      'danger',
    )
  }
  if (failed.length === 1) show(`${failed[0]}: couldn’t import (unsupported?)`, 'danger')
  else if (failed.length > 1) show(`${failed.length} files skipped (unsupported)`, 'danger')

  if (imported.length === 0) return
  useStore.getState().dispatch(`Import ${imported.length} file(s)`, (p) => ({
    ...p,
    assets: {
      ...p.assets,
      ...Object.fromEntries(imported.map((a): [Id, MediaAsset] => [a.id, a])),
    },
  }))
  show(opts?.successMessage ?? `Imported ${imported.length} file(s)`, 'success')
  // Start the small preview copies in the background. Nothing waits on this: he
  // can cut immediately, and each clip's preview gets faster as its copy lands.
  ensureProxies(imported)
}

/** Remove an asset from the bin and every clip that references it (all sequences). */
export function deleteAsset(assetId: Id): void {
  const { project, dispatch, ui, setUI } = useStore.getState()
  const asset = project.assets[assetId]
  if (!asset) return
  dispatch(`Delete ${asset.name}`, (p) => {
    const sequences = { ...p.sequences }
    for (const sid of Object.keys(sequences)) {
      const seq = sequences[sid]
      // A linked audio clip references the same (video) asset, so filtering by
      // assetId drops both halves of a linked pair.
      const tracks = seq.tracks.map((t) => {
        const clips = t.clips.filter((c) => c.assetId !== assetId)
        return clips.length === t.clips.length ? t : { ...t, clips }
      })
      sequences[sid] = recomputeDuration({ ...seq, tracks })
    }
    const assets = { ...p.assets }
    delete assets[assetId]
    return { ...p, assets, sequences }
  })
  // Release the decode resources keyed by this asset: the frameCache demuxer +
  // WebCodecs decoder and the pooled preview <video>/<img>. Without this they
  // stay open for the whole session (a hardware-decoder + memory leak across
  // repeated import→scrub→delete). Undo-safe: they lazily rebuild on next use.
  // (The IndexedDB blob is deliberately KEPT so Undo can restore the bin item.)
  evictAsset(assetId)
  disposePreviewAsset(assetId)
  forgetProxy(assetId)
  // Drop any selection that pointed at now-removed clips.
  if (ui.selection.length > 0) setUI({ selection: [] })
  // Bin delete also nukes every clip referencing the asset across ALL sequences,
  // which the user may not expect, so the toast carries a one-click Undo.
  useToasts.getState().show(`Removed ${asset.name}`, 'info', {
    label: 'Undo',
    // Routed: in a room a plain snapshot undo would wipe every edit peers made
    // since the delete; the routed step rebases only this command. (Dynamic
    // import keeps this module out of the collab graph for solo code paths.)
    onClick: () => void import('../collab/collabControl').then((m) => m.performHistoryStep('undo')),
  })
}

export function insertAssetAtPlayhead(assetId: Id): void {
  const { project, ui, dispatch, setUI } = useStore.getState()
  const asset = project.assets[assetId]
  if (!asset) return
  // A fresh insert lands UNSELECTED. Selecting the video half made the very next
  // edit read as "I singled this one out". Trimming the head of a clip you
  // just dropped in shortened the picture and left the audio at full length. The
  // link is meant to hold until you deliberately pick one half. Dropping an asset
  // from the bin onto the timeline already worked this way; this matches it.
  let newClipId: Id | null = null
  dispatch(`Add ${asset.name}`, (p) => {
    const seq = activeSequence(p)
    // Video with audio → linked pair (video on V1, audio split to A1); other
    // assets → a single clip on the matching track.
    if (asset.kind === 'video' && asset.hasAudio) {
      const vTrack = videoTracks(seq)[0]
      if (!vTrack) return p
      const aTrack = audioTracks(seq).find((t) => !t.locked) ?? null
      const { seq: next, videoClipId } = addClipWithLinkedAudio(seq, vTrack.id, aTrack?.id ?? null, asset, ui.playheadS)
      newClipId = videoClipId || null
      return { ...p, sequences: { ...p.sequences, [seq.id]: next } }
    }
    const track = asset.kind === 'audio' ? audioTracks(seq)[0] : videoTracks(seq)[0]
    if (!track) return p
    const { seq: next, clipId } = addClipFromAsset(seq, track.id, asset, ui.playheadS)
    newClipId = clipId || null
    return { ...p, sequences: { ...p.sequences, [seq.id]: next } }
  })
  if (newClipId && ui.selection.length > 0) setUI({ selection: [] })
}
