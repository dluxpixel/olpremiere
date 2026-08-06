// Pure, worker-runnable stereo audio mixdown. audioRender.ts does the same mix
// with an OfflineAudioContext on the MAIN thread (workers have no
// OfflineAudioContext); this module reproduces that topology in plain JS so the
// export worker can mix without a decoded-buffer round trip to the main thread.
//
// Determinism is the whole point: same inputs give byte-identical output. The
// per-clip chain mirrors audioRender.ts exactly (schedule window, per-sample
// gain envelope, |speed| resample), and the per-track chain applies track
// volume, optional auto-level MAKEUP gain, and an equal-power pan before every
// clip is summed and soft-limited into L/R.
//
// Known divergences from audioRender.ts (see the module's tests and the export
// integration notes):
//  1. auto-level: only the makeup GAIN is applied. The DynamicsCompressor curve
//     itself (threshold/knee/ratio/attack/release) is time-varying and stateful
//     and is out of scope for this pure mixer, so an auto-levelled track is
//     louder here by the makeup amount but is not actually compressed.
//  2. stereo sources are downmixed to mono before the equal-power pan, whereas
//     a Web Audio StereoPanner passes a stereo source through unchanged at
//     center. Mono sources match audioRender's panner exactly at every pan.
//  3. (CLOSED 2026-08-06) a soft limiter is applied at the master bus. This
//     used to say "audioRender has none (it relies on the downstream encoder
//     clamp)", which meant the path he HEARS and the path that RENDERS
//     disagreed on exactly the loud material where it matters. All three paths
//     now share engine/audioLimiter.ts. The limiter is transparent below the
//     knee, so normal-level mixes stay bit-identical to an unlimited sum.

import {
  clipEmitsAudio,
  clipGainEnvelope,
  compressorParamsFor,
  computeClipSchedule,
  dbToGain,
  type GainPoint,
} from '../audio'
import { softLimit } from '../audioLimiter'
import { duckEnvelope } from '../ducking'
import type { Clip, Track } from '../types'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/**
 * One audible clip resolved to decoded PCM. The CALLER decodes each clip's
 * source (decoding needs WebCodecs and is the worker's job) and, for a reverse
 * clip (speed < 0), passes the REVERSED PCM together with the forward-equivalent
 * clip from effectiveAudioClip (exactly what audioRender feeds its buffer
 * source). So `clip` here always has speed > 0 and `channelData` is already in
 * playback order.
 */
export interface MixSourcePcm {
  clip: Clip
  track: Track
  /** Decoded PCM, one Float32Array per channel, all the same length. */
  channelData: Float32Array[]
  /** Sample rate of `channelData` (the source rate, not the output rate). */
  sampleRate: number
}

export interface MixOptions {
  /** Schedule base: the work-area in point. Output frame 0 maps to this time. */
  startS: number
  endS: number
  /** Output sample rate (the resample target). */
  sampleRate: number
  /**
   * True when ANY track in the sequence is soloed. When set, only clips on
   * soloed tracks contribute; otherwise every non-muted track contributes.
   * Mirrors scheduleAudio / renderAudioMix.
   */
  soloActive: boolean
}

// Master soft limiter. Transparent (identity) below the knee so a normal mix is
// unchanged, then a tanh knee that asymptotes to +/-1 and never exceeds it. The
// knee is C1-continuous (slope 1 on both sides at LIMIT_KNEE), so there is no
// audible corner where the limiter engages.
// The limiter itself now lives in engine/audioLimiter.ts, because the preview
// and the OfflineAudioContext render need the SAME one: this mixer having a
// limiter the other two paths did not was a real divergence, and it only showed
// on loud material. Re-exported so this module's callers and tests are unmoved.
export { softLimit }

/**
 * Linear-interpolated read of `channel` at fractional sample position `pos`.
 * Positions outside the buffer read as silence (0), matching a Web Audio buffer
 * source that plays silence past its end.
 */
export function sampleLinear(channel: Float32Array, pos: number): number {
  // Before the buffer start is silence (a Web Audio source plays nothing there),
  // not a ramp-in from sample 0, so any pos < 0 reads 0, no interpolation.
  if (pos < 0) return 0
  const i0 = Math.floor(pos)
  const s0 = i0 >= 0 && i0 < channel.length ? channel[i0] : 0
  const i1 = i0 + 1
  const s1 = i1 >= 0 && i1 < channel.length ? channel[i1] : 0
  const frac = pos - i0
  return s0 * (1 - frac) + s1 * frac
}

/**
 * Resample `src` (at `srcRate`) to `dstFrames` samples at `dstRate` by linear
 * interpolation, reading from position 0. Equivalent to a Web Audio buffer
 * source at playbackRate 1 whose buffer is at `srcRate` rendered at `dstRate`.
 * A source rate above the destination rate consumes the buffer faster (fewer
 * output frames cover the same span); a lower rate interpolates between samples.
 */
export function linearResampleChannel(
  src: Float32Array,
  srcRate: number,
  dstRate: number,
  dstFrames: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, dstFrames))
  if (out.length === 0 || src.length === 0 || dstRate <= 0) return out
  const step = srcRate / dstRate
  for (let j = 0; j < out.length; j++) out[j] = sampleLinear(src, j * step)
  return out
}

/**
 * Downmix decoded PCM to a single mono channel: mono passes through (same
 * reference), stereo folds to 0.5 * (L + R) (the Web Audio stereo->mono rule),
 * and any higher channel count averages all channels (a rare path).
 */
export function downmixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array(0)
  if (channelData.length === 1) return channelData[0]
  const n = channelData[0].length
  const out = new Float32Array(n)
  if (channelData.length === 2) {
    const [l, r] = channelData
    for (let i = 0; i < n; i++) out[i] = 0.5 * (l[i] + r[i])
    return out
  }
  const c = channelData.length
  for (let ch = 0; ch < c; ch++) {
    const data = channelData[ch]
    for (let i = 0; i < n; i++) out[i] += data[i]
  }
  for (let i = 0; i < n; i++) out[i] /= c
  return out
}

/**
 * Multiply `buffer` by a piecewise-linear gain envelope. `points.offsetS` are
 * relative to buffer frame 0 (offset 0 is the first sample). The value holds at
 * the first point's level before it and the last point's level after it, and
 * ramps linearly between adjacent points, reproducing setValueAtTime on the
 * first automation event plus linearRampToValueAtTime on the rest. Returns a new
 * buffer; the input is not mutated.
 */
export function applyGainEnvelope(
  buffer: Float32Array,
  points: readonly GainPoint[],
  sampleRate: number,
): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) {
    out[i] = buffer[i] * envelopeGainAt(points, i / sampleRate)
  }
  return out
}

/** Piecewise-linear lookup into a sorted-by-offset gain envelope. */
function envelopeGainAt(points: readonly GainPoint[], t: number): number {
  if (points.length === 0) return 1
  if (t <= points[0].offsetS) return points[0].value
  const last = points[points.length - 1]
  if (t >= last.offsetS) return last.value
  for (let k = 1; k < points.length; k++) {
    const b = points[k]
    if (t <= b.offsetS) {
      const a = points[k - 1]
      const span = b.offsetS - a.offsetS
      if (span <= 0) return b.value
      const f = (t - a.offsetS) / span
      return a.value + (b.value - a.value) * f
    }
  }
  return last.value
}

/**
 * Equal-power constant-power pan of a mono sample to [left, right]. pan is
 * clamped to -1..1. At center (0) both channels get sample * cos(pi/4) (about
 * 0.707), hard left (-1) puts the full sample on L, hard right (1) on R. This
 * matches a Web Audio StereoPanner fed a mono input.
 */
export function equalPowerPan(sample: number, pan: number): [number, number] {
  const x = ((clamp(pan, -1, 1) + 1) / 2) * (Math.PI / 2)
  return [sample * Math.cos(x), sample * Math.sin(x)]
}

/**
 * Sum same-length buffers element-wise, then soft-limit each sample. Used once
 * per output channel at the master bus (SUM every clip, then limit). Two 0.8
 * buffers sum to 1.6 and limit to just under 1.0 without ever exceeding it.
 */
export function sumAndLimit(buffers: Float32Array[]): Float32Array {
  if (buffers.length === 0) return new Float32Array(0)
  const n = buffers[0].length
  const out = new Float32Array(n)
  for (const buf of buffers) {
    const m = Math.min(n, buf.length)
    for (let i = 0; i < m; i++) out[i] += buf[i]
  }
  for (let i = 0; i < n; i++) out[i] = softLimit(out[i])
  return out
}

/** Per-sample source read of one clip: offset + |speed| resample to output rate. */
function renderClipMono(
  mono: Float32Array,
  srcRate: number,
  sourceOffsetS: number,
  speed: number,
  dstRate: number,
  dstFrames: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, dstFrames))
  if (out.length === 0 || mono.length === 0 || dstRate <= 0) return out
  const startPos = sourceOffsetS * srcRate
  const step = (srcRate * speed) / dstRate
  for (let j = 0; j < out.length; j++) out[j] = sampleLinear(mono, startPos + j * step)
  return out
}

/**
 * Mix every source over [startS, endS) into stereo PCM at opts.sampleRate.
 * Returns [left, right], each of length ceil((endS - startS) * sampleRate).
 *
 * Per clip it reproduces audioRender.ts: computeClipSchedule gives the sample
 * window, clipGainEnvelope gives the per-sample gain (offsets relative to
 * startS), and the source is linearly resampled at |speed| to the output rate.
 * Per track it applies volumeDb, the optional auto-level makeup gain, and an
 * equal-power pan, then every clip is summed and soft-limited into L/R.
 *
 * Solo wins exactly as in scheduleAudio: when opts.soloActive only soloed
 * tracks contribute, otherwise every non-muted track does. A linked video clip
 * emits no audio (its sound lives on its linked audio partner).
 */
export function mixToStereo(sources: MixSourcePcm[], opts: MixOptions): Float32Array[] {
  const { startS, endS, sampleRate, soloActive } = opts
  const totalFrames = Math.max(0, Math.ceil((endS - startS) * sampleRate))
  const rawL = new Float32Array(totalFrames)
  const rawR = new Float32Array(totalFrames)
  if (totalFrames === 0) return [rawL, rawR]

  // The Track objects carried by the sources include their full clip lists, so
  // the duck automation derives from the same data the live graph uses.
  const uniqueTracks = [...new Map(sources.map((s) => [s.track.id, s.track])).values()]
  const duckEnv = duckEnvelope(uniqueTracks, soloActive, startS)

  for (const src of sources) {
    const { clip, track } = src
    // Solo wins over mute, matching renderAudioMix's audibleTracks filter.
    const audible = soloActive ? track.solo : !track.muted
    if (!audible) continue
    if (!clipEmitsAudio(track, clip)) continue

    const sched = computeClipSchedule(clip, startS)
    if (!sched) continue

    const speed = Math.abs(clip.speed) || 1
    const startFrame = Math.round(sched.whenOffsetS * sampleRate)
    if (startFrame >= totalFrames) continue
    // Audible timeline length (seconds) = source content seconds / speed.
    const audibleLenS = sched.durationS / speed
    let dstFrames = Math.round(audibleLenS * sampleRate)
    if (startFrame + dstFrames > totalFrames) dstFrames = totalFrames - startFrame
    if (dstFrames <= 0) continue

    const mono = downmixToMono(src.channelData)
    const clipMono = renderClipMono(mono, src.sampleRate, sched.sourceOffsetS, speed, sampleRate, dstFrames)

    // clipGainEnvelope offsets are relative to startS; the clip buffer's frame 0
    // sits at render time whenOffsetS, so shift the envelope to be buffer-local.
    const env: GainPoint[] = clipGainEnvelope(clip, startS) ?? [
      { offsetS: 0, value: dbToGain(clip.audioGainDb) },
    ]
    const localPoints = env.map((p) => ({ offsetS: p.offsetS - sched.whenOffsetS, value: p.value }))
    let gained = applyGainEnvelope(clipMono, localPoints, sampleRate)

    // Music ducks under the voiceover with the same shift-to-buffer-local trick,
    // reproducing the duck GainNode in scheduleAudio/renderAudioMix.
    if (track.audioRole === 'music' && duckEnv) {
      const localDuck = duckEnv.map((p) => ({ offsetS: p.offsetS - sched.whenOffsetS, value: p.value }))
      gained = applyGainEnvelope(gained, localDuck, sampleRate)
    }

    // Track bus: volume * auto-level makeup, then equal-power pan. These are all
    // linear, so panning each clip and summing equals summing then panning.
    const cp = compressorParamsFor(track.autoLevel)
    const trackGain = dbToGain(track.volumeDb ?? 0) * (cp ? dbToGain(cp.makeupDb) : 1)
    const pan = clamp(track.pan ?? 0, -1, 1)
    const px = ((pan + 1) / 2) * (Math.PI / 2)
    const gainL = Math.cos(px)
    const gainR = Math.sin(px)

    for (let j = 0; j < dstFrames; j++) {
      const s = gained[j] * trackGain
      const out = startFrame + j
      rawL[out] += s * gainL
      rawR[out] += s * gainR
    }
  }

  return [sumAndLimit([rawL]), sumAndLimit([rawR])]
}
