// Everything decoded from one asset's sound, forgotten at once.
//
// ⛔ MEDIA PUT BACK MID-SESSION CAME BACK WITH NO SOUND AND A FLAT WAVEFORM.
// Opening an edit whose files are missing reads every clip's sound, and each
// read that finds no bytes is remembered as nothing: the decoded sound, the
// waveform, the beats. Putting the files back (the spare copies, Find my media,
// a file arriving from the room) dropped the picture's caches and none of these,
// so the picture came back and the sound did not until a restart, while the
// export, reading through its own path, could have sound the preview did not:
// the "audio doesn't work" shape he has reported before.

import { forgetAssetAudio } from './audio'
import { forgetBeats } from './beatCache'
import { forgetStrobeBeats } from './beatGrid'
import { invalidateDenoise } from './denoise'
import { forgetAssetPeaks } from './waveform'
import type { Id } from './types'

/** Drop the sound, waveform, beats and noise pass read from an asset's old bytes. */
export function forgetAssetSound(assetId: Id): void {
  forgetAssetAudio(assetId)
  forgetAssetPeaks(assetId)
  forgetBeats(assetId)
  forgetStrobeBeats(assetId)
  invalidateDenoise(assetId)
}
