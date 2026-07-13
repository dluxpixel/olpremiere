// One-click SFX: drop a bundled stinger onto an audio track at the playhead.
// The first use of a sound copies its bytes into the project (an ordinary
// audio asset — the project stays self-contained); later uses reuse that
// asset. Asset + clip land in ONE dispatch, so undo removes both together.

import { addClipFromAsset } from '../engine/timeline'
import { sfxAssetName, sfxById, sfxUrl, type SfxDef } from '../engine/sfx/sfx'
import { activeSequence, audioTracks, newId, type MediaAsset } from '../engine/types'
import { putBlob } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

/** The audio track an SFX lands on: topmost unlocked (closest to the voice). */
function sfxTargetTrackId(): string | null {
  const seq = activeSequence(useStore.getState().project)
  const track = audioTracks(seq).find((t) => !t.locked)
  return track?.id ?? null
}

function insertExisting(def: SfxDef, asset: MediaAsset, trackId: string): void {
  const s = useStore.getState()
  let clipId = ''
  s.dispatch(`Add ${def.name}`, (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const r = addClipFromAsset(seq, trackId, asset, s.ui.playheadS)
    if (!r.clipId) return p
    clipId = r.clipId
    return { ...p, sequences: { ...p.sequences, [seq.id]: r.seq } }
  })
  if (clipId) s.setUI({ selection: [clipId] })
}

/** Insert a bundled SFX at the playhead (fetching its bytes on first use). */
export async function insertSfxAtPlayhead(sfxId: string): Promise<void> {
  const def = sfxById(sfxId)
  if (!def) return
  const s = useStore.getState()
  const trackId = sfxTargetTrackId()
  if (!trackId) {
    useToasts.getState().show('No unlocked audio track for the sound', 'danger')
    return
  }

  const existing = Object.values(s.project.assets).find(
    (a) => a.kind === 'audio' && a.name === sfxAssetName(def),
  )
  if (existing) {
    insertExisting(def, existing, trackId)
    return
  }

  let blob: Blob
  try {
    const r = await fetch(sfxUrl(def))
    if (!r.ok) throw new Error(String(r.status))
    blob = await r.blob()
  } catch {
    useToasts.getState().show('Could not load the sound', 'danger')
    return
  }
  const id = newId()
  const asset: MediaAsset = {
    id,
    name: sfxAssetName(def),
    kind: 'audio',
    blobKey: 'asset/' + id,
    durationS: def.durationS,
    hasAudio: true,
    hasVideo: false,
  }
  await putBlob(asset.blobKey, blob)

  let clipId = ''
  useStore.getState().dispatch(`Add ${def.name}`, (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const r = addClipFromAsset(seq, trackId, asset, useStore.getState().ui.playheadS)
    if (!r.clipId) return p
    clipId = r.clipId
    return {
      ...p,
      assets: { ...p.assets, [asset.id]: asset },
      sequences: { ...p.sequences, [seq.id]: r.seq },
    }
  })
  if (clipId) useStore.getState().setUI({ selection: [clipId] })
}

// Click-to-preview shares one element so a re-click restarts instead of layering.
let previewEl: HTMLAudioElement | null = null

/** Audition a bundled SFX without touching the project. */
export function previewSfx(sfxId: string): void {
  const def = sfxById(sfxId)
  if (!def || typeof Audio === 'undefined') return
  if (!previewEl) previewEl = new Audio()
  previewEl.src = sfxUrl(def)
  previewEl.currentTime = 0
  void previewEl.play().catch(() => {})
}
