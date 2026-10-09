// One road for media that has been PUT BACK: the boot repair, the Media panel's
// repair, Find my media, and a file arriving from a collab room.
//
// ⛔ FOUR PLACES DID THIS FOUR WAYS, 2026-10-06 (PB-3). The boot only bumped the
// preview, the panel and Find my media dropped the frame cache, the room sync
// also told the media pictures. None of them told the preview's <video> pool,
// so a clip whose element was made while its media was missing played black
// until a restart. Every put back now calls this, and anything else that keeps
// state per asset belongs in here too.

import type { Id, MediaAsset, Project } from '../engine/types'
import { forgetAssetSound } from '../engine/assetSound'
import { evictAsset } from '../engine/frameCache'
import { disposePreviewAsset, invalidatePreview } from '../engine/preview'
import { notifyBlobArrived } from './blobUrls'

/** Everything that cached "this asset has no media" lets go of it, and the picture redraws. */
export function mediaPutBack(assets: readonly Pick<MediaAsset, 'id' | 'blobKey'>[]): void {
  for (const a of assets) {
    notifyBlobArrived(a.blobKey)
    evictAsset(a.id)
    disposePreviewAsset(a.id)
    // And the sound, waveform, beats and noise pass, read as nothing while the bytes were missing (AU-10).
    forgetAssetSound(a.id)
  }
  invalidatePreview()
}

/**
 * The project's assets a repair reported as put back. The repair names them the
 * way it shows them to him (name, else id), so the match is on both.
 */
export function assetsPutBack(project: Project, healed: readonly string[]): MediaAsset[] {
  const said = new Set(healed)
  return (Object.values(project.assets ?? {}) as MediaAsset[]).filter(
    (a) => said.has(a.name ?? a.id) || said.has(a.id as Id),
  )
}

/**
 * After a repair: put back what it reported. If a reported name matches no
 * asset, every asset is refreshed rather than one being missed, which costs a
 * re-warm and nothing else.
 */
export function putBackHealed(project: Project, healed: readonly string[]): void {
  if (healed.length === 0) return
  const found = assetsPutBack(project, healed)
  // Every NAME reported has to have matched an asset: counting assets would let
  // two of one name make up for a name that matched none, or a name reported
  // twice count as a miss.
  const matched = new Set<string>()
  for (const a of found) {
    matched.add(a.name ?? a.id)
    matched.add(a.id)
  }
  mediaPutBack(healed.every((name) => matched.has(name)) ? found : (Object.values(project.assets ?? {}) as MediaAsset[]))
}
