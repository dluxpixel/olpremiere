// Why the app can be completely silent with a perfectly normal picture.
//
// His words, 2026-08-24: *"the audio doesn't seem to be working for some reason
// in this version. Look if anything is wrong."*
//
// ⛔ NOTHING WAS WRONG IN THE CODE, AND THAT IS THE POINT. Two commits' worth of
// audio diff were read line by line and there is no regression that silences
// playback. What there is, is a class of state that turns the sound off
// completely and says nothing at all about it:
//
//   - ONE track left soloed. `scheduleAudio` filters to the soloed set, so every
//     other track goes quiet (engine/audio.ts, `anySolo`). Solo is persisted on
//     the track, so it survives a restart and a project reload, and the button
//     is a single small ember square in a track header.
//   - Soloing a VIDEO track is worse than useless on a linked edit: a linked
//     video clip emits no audio at all, because its sound lives on the audio
//     clip it is linked to (`clipEmitsAudioOn`). Solo V1 and the mixer schedules
//     literally nothing.
//   - Every track that has sound left muted.
//
// In all three the meter is flat, the picture is perfect, nothing is logged and
// nothing is shown. That is indistinguishable from "the audio is broken", which
// is exactly the report we got. So the app says it now.
//
// Pure on purpose: it takes tracks and returns a sentence, so the rule can be
// tested without an AudioContext and the wording can be argued with in a diff.

import { clipEmitsAudioOn } from './audio'
import type { Track } from './types'

/**
 * The track fader's own minimum, matching the slider in the track header
 * (`TrackHeaderControls.tsx`, `min={-60}`). About a thousandth of unity, which
 * is silence to anyone listening.
 */
export const FLOOR_DB = -60

/** The one-click way out, when there is one. */
export type SilenceFix = 'unsolo' | 'unmute'

export interface SilenceDiagnosis {
  /** Written for him: what is off, and what to press. No jargon. */
  message: string
  fix?: SilenceFix
  /** Stable key, so the same diagnosis is not said twice in a row. */
  key: string
}

/** Whether this track has any clip that would make a sound if it were audible. */
function carriesSound(track: Track): boolean {
  return track.clips.some((c) => c.enabled && clipEmitsAudioOn(track.kind, c))
}

const list = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * Why there is no sound, or null when the mixer is in a state that can make
 * some. Says nothing when the silence is simply "no audio clips at all": a
 * project with no sound in it is not a fault and does not need a toast.
 */
export function diagnoseSilence(tracks: readonly Track[]): SilenceDiagnosis | null {
  const withSound = tracks.filter(carriesSound)
  if (withSound.length === 0) return null

  const soloed = tracks.filter((t) => t.solo)
  if (soloed.length > 0) {
    // Solo is doing its job as long as at least one soloed track can be heard.
    if (soloed.some(carriesSound)) return null
    const names = soloed.map((t) => t.name)
    const onlyVideo = soloed.every((t) => t.kind === 'video')
    return {
      key: `solo:${names.join(',')}`,
      fix: 'unsolo',
      message: onlyVideo
        ? `${list(names)} is soloed, and its sound lives on the audio track it is linked to, so nothing can be heard. Turn solo off to get your sound back.`
        : `${list(names)} is soloed and has no sound on it, so nothing can be heard. Turn solo off to get your sound back.`,
    }
  }

  if (withSound.every((t) => t.muted)) {
    return {
      key: 'muted',
      fix: 'unmute',
      message:
        withSound.length === 1
          ? `${withSound[0].name} is muted, and it is the only track with sound on it.`
          : 'Every track that has sound on it is muted.',
    }
  }

  // Faders at the floor. -60 dB is the slider's own minimum and works out at
  // about a thousandth of unity, which is silence to anyone listening.
  const audible = withSound.filter((t) => !t.muted)
  if (audible.every((t) => t.volumeDb <= FLOOR_DB)) {
    return {
      key: 'floor',
      message:
        audible.length === 1
          ? `${audible[0].name} is turned all the way down.`
          : 'Every track with sound on it is turned all the way down.',
    }
  }

  return null
}
