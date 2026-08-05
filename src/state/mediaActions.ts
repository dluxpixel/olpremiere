// Media actions: import files into the bin (probe + persist blobs + ONE
// dispatch so the whole batch is a single undo step) and insert an asset
// onto the timeline at the playhead.

import { create } from 'zustand'
import { evictAsset } from '../engine/frameCache'
import { disposePreviewAsset } from '../engine/preview'
import { ensureProxies, forgetProxy } from '../engine/proxyMedia'
import { probeFile } from '../engine/probe'
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
function isOutOfRoom(err: unknown): boolean {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  return err instanceof Error && /quota/i.test(err.message)
}

/** Live import progress. `total: 0` means nothing is importing. */
export const useImportProgress = create<{ total: number; done: number; name: string }>(() => ({
  total: 0,
  done: 0,
  name: '',
}))

export async function importFiles(files: File[]): Promise<void> {
  const show = useToasts.getState().show
  const imported: MediaAsset[] = []
  const failed: string[] = []
  const outOfRoom: string[] = []
  // Probing + copying every file's bytes into IndexedDB takes real time on
  // multi-GB captures, and until now the app showed NOTHING while it happened:
  // the drop overlay vanished on release and the panel sat on "Import media to
  // begin". Indistinguishable from a crash, so people drop the file again.
  useImportProgress.setState({ total: files.length, done: 0, name: files[0]?.name ?? '' })
  try {
    for (const [i, file] of files.entries()) {
      useImportProgress.setState({ total: files.length, done: i, name: file.name })
      try {
        const probe = await probeFile(file)
        const id = newId()
        const blobKey = 'asset/' + id
        await putBlob(blobKey, file)
        let thumbnailKey: string | undefined
        if (probe.thumbnailBlob) {
          thumbnailKey = 'thumb/' + id
          await putBlob(thumbnailKey, probe.thumbnailBlob)
        }
        imported.push({
          id,
          name: file.name,
          kind: probe.kind,
          blobKey,
          durationS: probe.durationS,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
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
    show(
      outOfRoom.length === 1
        ? `No room left for ${outOfRoom[0]}. Delete an old project to free space`
        : `No room left for ${outOfRoom.length} files. Delete an old project to free space`,
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
  show(`Imported ${imported.length} file(s)`, 'success')
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
