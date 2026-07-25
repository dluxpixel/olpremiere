// One-click SFX: drop a bundled stinger onto an audio track at the playhead.
// The first use of a sound copies its bytes into the project (an ordinary
// audio asset — the project stays self-contained); later uses reuse that
// asset. Asset + clip land in ONE dispatch, so undo removes both together.

import { addClipFromAsset, canPlace } from '../engine/timeline'
import { formatTimecode } from '../engine/timecode'
import { sfxAssetName, sfxById, sfxUrl, type SfxDef } from '../engine/sfx/sfx'
import { activeSequence, audioTracks, newId, type MediaAsset } from '../engine/types'
import { putBlob } from './persistence'
import { useStore } from './store'
import { useToasts } from './toasts'

/**
 * The audio track an SFX lands on: the topmost unlocked one that is actually
 * FREE for the sound's length at that moment, else the topmost unlocked track.
 *
 * A1 is where the gameplay audio and the voiceover already live, so always
 * targeting it meant addClipFromAsset's resolveStart quietly slid the stinger to
 * the nearest gap — sometimes seconds away, past the end of the voiceover.
 */
function sfxTargetTrackId(atS: number, durationS: number): string | null {
  const seq = activeSequence(useStore.getState().project)
  const unlocked = audioTracks(seq).filter((t) => !t.locked)
  return (unlocked.find((t) => canPlace(t, atS, durationS)) ?? unlocked[0])?.id ?? null
}

/**
 * Say so when the sound could not land where it was asked to. The drag path
 * paints a drop-ghost at the exact snapped time, so silent drift makes that
 * ghost a lie; the double-click path gives no visual at all.
 */
function reportDrift(clipId: string, wantedS: number, fps: number): void {
  if (!clipId) return
  const seq = activeSequence(useStore.getState().project)
  const placed = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!placed) return
  if (Math.abs(placed.startS - wantedS) <= 1 / Math.max(1, fps)) return
  useToasts
    .getState()
    .show(`No room at the playhead — landed at ${formatTimecode(placed.startS, fps)}`, 'info')
}

/** Where a dropped/inserted SFX lands. Defaults to playhead + topmost track. */
export interface SfxPlacement {
  atS?: number
  trackId?: string
}

function insertExisting(def: SfxDef, asset: MediaAsset, trackId: string, atS: number): void {
  const s = useStore.getState()
  let clipId = ''
  const fps = activeSequence(s.project).fps
  s.dispatch(`Add ${def.name}`, (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const r = addClipFromAsset(seq, trackId, asset, atS)
    if (!r.clipId) return p
    clipId = r.clipId
    return { ...p, sequences: { ...p.sequences, [seq.id]: r.seq } }
  })
  if (clipId) s.setUI({ selection: [clipId] })
  reportDrift(clipId, atS, fps)
}

/** Insert a bundled SFX (fetching its bytes on first use). Playhead + top
 * unlocked audio track by default; a drop passes an explicit time/track. */
export async function insertSfxAtPlayhead(sfxId: string, place: SfxPlacement = {}): Promise<void> {
  const def = sfxById(sfxId)
  if (!def) return
  const s = useStore.getState()
  const atS = place.atS ?? s.ui.playheadS
  const trackId = place.trackId ?? sfxTargetTrackId(atS, def.durationS)
  if (!trackId) {
    useToasts.getState().show('No unlocked audio track for the sound', 'danger')
    return
  }

  const existing = Object.values(s.project.assets).find(
    (a) => a.kind === 'audio' && a.name === sfxAssetName(def),
  )
  if (existing) {
    insertExisting(def, existing, trackId, atS)
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
    const r = addClipFromAsset(seq, trackId, asset, atS)
    if (!r.clipId) return p
    clipId = r.clipId
    return {
      ...p,
      assets: { ...p.assets, [asset.id]: asset },
      sequences: { ...p.sequences, [seq.id]: r.seq },
    }
  })
  if (clipId) useStore.getState().setUI({ selection: [clipId] })
  reportDrift(clipId, atS, activeSequence(useStore.getState().project).fps)
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
