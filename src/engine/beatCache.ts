// The beats of a clip's own audio, worked out once and kept.
//
// `punchOnBeats` has decoded, mixed down and detected onsets since it shipped, and
// it can afford to: it is a menu item, it runs once, and he is waiting for it. A
// DRAGGED DIAMOND cannot afford any of that. It asks where the nearby moments are
// between two mouse moves, so the answer has to be sitting there already or it does
// not exist yet, and neither of those is allowed to decode audio.
//
// ⛔ THE KEY IS THE SOURCE SLICE, NOT THE CLIP. Onsets belong to a stretch of an
// asset's waveform, so two clips cut from the same take share one answer and only
// trimming invalidates it. A clip id in the key would mean re-detecting the same
// audio for every copy he makes.
//
// ⛔ AND SPEED IS NOT IN THE KEY, deliberately. A speed change does not move a beat
// in the source, it moves where that beat LANDS, and `punchOnBeats` already maps
// them with `t / speed`. So this holds SOURCE seconds and the caller does the
// mapping, which is what stops a re-detect every time he changes a clip's speed.
//
// Pure except for the decode: no store, no DOM, no React.

import { detectOnsets } from './beats'
import { getAudioBuffer } from './audio'
import type { MediaAsset } from './types'

/**
 * Two beats closer than this are one beat for snapping purposes.
 *
 * ⛔ IT IS NOT `BEAT_PUNCH_GAP_S`, and the difference is the point. That one is 0.8s
 * because two punches closer than that compound their envelopes into nonsense. A
 * SNAP has no envelope: it is a magnet, and a magnet every 0.8s is a coarse grid on
 * fast music. This is the detector's own default, which is what "a beat" means when
 * nothing is being drawn.
 */
const SNAP_MIN_GAP_S = 0.35

/** Plenty for a Short, and a ceiling on how many magnets one clip can have. */
const SNAP_MAX_ONSETS = 64

/**
 * One channel of the slice `[inS, outS)`, mixed down, at the buffer's own rate.
 *
 * Split out from `punchOnBeats`, which did this inline, so the two cannot drift into
 * detecting beats in slightly different audio and disagreeing about where they are.
 */
export function monoSlice(
  channels: readonly Float32Array[],
  sampleRate: number,
  inS: number,
  outS: number,
): Float32Array {
  const s0 = Math.max(0, Math.floor(inS * sampleRate))
  const end = channels[0]?.length ?? 0
  const s1 = Math.min(end, Math.ceil(outS * sampleRate))
  const mono = new Float32Array(Math.max(0, s1 - s0))
  if (mono.length === 0 || channels.length === 0) return mono
  for (const data of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += data[s0 + i] / channels.length
  }
  return mono
}

const key = (assetId: string, inS: number, outS: number): string =>
  `${assetId}|${inS.toFixed(4)}|${outS.toFixed(4)}`

/** Source-relative onset times, by slice. A slice that has been looked at and has none holds []. */
const cache = new Map<string, number[]>()
/** Slices currently being detected, so a second ask does not start a second decode. */
const inFlight = new Set<string>()

/**
 * The beats of this slice IF they are already known. Never decodes, never waits.
 *
 * Null means nobody has asked for them yet, which a caller should treat as "no beats
 * this time" rather than as an error: a drag that arrives before the audio has been
 * looked at simply snaps to the other moments, and the next drag has them.
 */
export function knownBeats(assetId: string, inS: number, outS: number): number[] | null {
  return cache.get(key(assetId, inS, outS)) ?? null
}

/**
 * Work them out if they are not known yet. Safe to call as often as you like: the
 * second call for a slice already in flight does nothing.
 *
 * ⛔ CALL IT OFF THE DRAG PATH. This is where the decode lives.
 */
export async function ensureBeats(asset: MediaAsset, inS: number, outS: number): Promise<void> {
  if (!asset.hasAudio) return
  const k = key(asset.id, inS, outS)
  if (cache.has(k) || inFlight.has(k)) return
  inFlight.add(k)
  try {
    const buffer = await getAudioBuffer(asset)
    if (!buffer) {
      // An asset that cannot be decoded is remembered as beatless rather than retried
      // on every drag: the answer will not change by asking again.
      cache.set(k, [])
      return
    }
    const channels: Float32Array[] = []
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))
    const mono = monoSlice(channels, buffer.sampleRate, inS, outS)
    cache.set(
      k,
      detectOnsets(mono, buffer.sampleRate, { minGapS: SNAP_MIN_GAP_S, maxOnsets: SNAP_MAX_ONSETS }),
    )
  } catch {
    cache.set(k, [])
  } finally {
    inFlight.delete(k)
  }
}

/** Forget everything. For tests, and for a project close. */
export function clearBeatCache(): void {
  cache.clear()
  inFlight.clear()
}
