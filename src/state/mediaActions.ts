// Media actions: import files into the bin (probe + persist blobs + ONE
// dispatch so the whole batch is a single undo step) and insert an asset
// onto the timeline at the playhead.

import { probeFile } from '../engine/probe'
import { addClipFromAsset, addClipWithLinkedAudio } from '../engine/timeline'
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

export async function importFiles(files: File[]): Promise<void> {
  const show = useToasts.getState().show
  const imported: MediaAsset[] = []
  for (const file of files) {
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
      const unsupported = err instanceof Error && err.message === 'unsupported'
      show(
        unsupported ? `${file.name}: unsupported file type` : `${file.name}: import failed`,
        'danger',
      )
    }
  }
  if (imported.length === 0) return
  useStore.getState().dispatch(`Import ${imported.length} file(s)`, (p) => ({
    ...p,
    assets: {
      ...p.assets,
      ...Object.fromEntries(imported.map((a): [Id, MediaAsset] => [a.id, a])),
    },
  }))
  show(`Imported ${imported.length} file(s)`, 'success')
}

export function insertAssetAtPlayhead(assetId: Id): void {
  const { project, ui, dispatch } = useStore.getState()
  const asset = project.assets[assetId]
  if (!asset) return
  dispatch(`Add ${asset.name}`, (p) => {
    const seq = activeSequence(p)
    // Video with audio → linked pair (video on V1, audio split to A1); other
    // assets → a single clip on the matching track.
    if (asset.kind === 'video' && asset.hasAudio) {
      const vTrack = videoTracks(seq)[0]
      if (!vTrack) return p
      const aTrack = audioTracks(seq).find((t) => !t.locked) ?? null
      const { seq: next } = addClipWithLinkedAudio(seq, vTrack.id, aTrack?.id ?? null, asset, ui.playheadS)
      return { ...p, sequences: { ...p.sequences, [seq.id]: next } }
    }
    const track = asset.kind === 'audio' ? audioTracks(seq)[0] : videoTracks(seq)[0]
    if (!track) return p
    const { seq: next } = addClipFromAsset(seq, track.id, asset, ui.playheadS)
    return { ...p, sequences: { ...p.sequences, [seq.id]: next } }
  })
}
