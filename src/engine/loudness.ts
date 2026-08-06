// How LOUD a piece of audio actually sounds, rather than how tall its tallest
// spike is.
//
// WHY PEAK NORMALISATION FAILED HIM
//
// The app already had "Normalize volume", and it matched PEAKS. His complaint,
// 2026-08-05: "some clips I'm screaming and some clips I'm speaking softly, and
// the volume just isn't balanced. The part when I scream is still very, very
// loud."
//
// That is peak matching working exactly as designed and still being wrong. A
// shout and a quiet sentence can hit the same peak, because a single consonant
// spike sets the peak for both, while the shout carries far more energy for far
// more of its length. Matching the spikes leaves the shout twice as loud to a
// listener. Loudness is about sustained energy, weighted for how the ear
// actually responds to frequency, which is what this file measures.
//
// The method is ITU-R BS.1770, the standard every broadcaster and every
// streaming platform levels to. Three parts:
//   1. K-weighting: a shelving filter plus a high-pass, which together
//      approximate the ear's sensitivity (it hears midrange far better than it
//      hears rumble).
//   2. Mean square over 400 ms blocks, overlapping by 75%.
//   3. Two gates: an absolute one at -70 LUFS that throws away digital silence,
//      and a relative one 10 LU below the ungated average that throws away
//      pauses. Without the gates, a clip with long gaps between sentences
//      measures quiet and then gets boosted until the speech is shouting, which
//      is the exact failure this is meant to remove.

/** One channel of a biquad, applied in place over a copy. */
interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * BS.1770 stage 1: a high-frequency shelf standing in for the acoustic effect of
 * a listener's head. Coefficients are the standard's, defined at 48 kHz and
 * re-derived here for whatever rate the buffer actually is, because using the
 * 48 kHz numbers on 44.1 kHz audio shifts the filter and biases every reading.
 */
function shelfFilter(sampleRate: number): Biquad {
  const f0 = 1681.974450955533
  const G = 3.999843853973347
  const Q = 0.7071752369554196
  const K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const den = 1 + K / Q + K * K
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / den,
    b1: (2 * (K * K - Vh)) / den,
    b2: (Vh - (Vb * K) / Q + K * K) / den,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  }
}

/** BS.1770 stage 2: a high-pass that removes rumble the ear barely registers. */
function highpassFilter(sampleRate: number): Biquad {
  const f0 = 38.13547087602444
  const Q = 0.5003270373238773
  const K = Math.tan((Math.PI * f0) / sampleRate)
  const den = 1 + K / Q + K * K
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  }
}

/** Direct-form-1 biquad over `src`, writing into `dst`. Separate arrays so a stage never reads its own output. */
function applyBiquad(src: Float32Array, dst: Float32Array, f: Biquad): void {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < src.length; i++) {
    const x0 = src[i]
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    dst[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
}

/** Per-channel weights (BS.1770). Stereo is unweighted; surround lifts the rears, which we never see here. */
const channelWeight = (index: number): number => (index < 2 ? 1 : 1.41)

/** Block length and hop, in seconds: 400 ms windows overlapping by 75%. */
const BLOCK_S = 0.4
const HOP_S = 0.1

/** Below this a block is digital silence and must never drag the average down. */
const ABSOLUTE_GATE_LUFS = -70
/** A block this far under the ungated average is a pause between words, not speech. */
const RELATIVE_GATE_LU = 10
/** Share of samples allowed to sit ABOVE the body peak: one in a thousand. */
const BODY_PEAK_TOP_FRACTION = 0.001

const EMPTY_RESULT: LoudnessResult = { lufs: null, peak: 0, bodyPeak: 0, noiseFloorLufs: null, blocks: 0 }

export interface LoudnessResult {
  /** Integrated loudness in LUFS, or null when there was nothing above the silence gate. */
  lufs: number | null
  /** Absolute sample peak in the range, linear 0..1. */
  peak: number
  /**
   * The level all but the loudest 0.1% of samples stay under, linear 0..1.
   *
   * THE PEAK IS THE WRONG NUMBER TO LEVEL AGAINST and this is why. His clip of
   * a distant mic measured -34.8 LUFS and needed +18.8 dB. It also contained
   * ONE desk bump: sixty samples out of four hundred thousand, at -2.5 dBFS.
   * Levelling against the absolute peak gave that bump the whole headroom
   * budget and allowed +1.5 dB, so the clip landed SEVENTEEN dB below every
   * other clip on the timeline. That is peak matching wearing a loudness
   * costume, and it is exactly the failure this whole file exists to escape.
   *
   * A percentile ignores the isolated transient and still respects sustained
   * loud material, which is the thing that actually clips audibly.
   */
  bodyPeak: number
  /** Roughly where the room tone sits, LUFS. Null when there is no quiet part to measure. */
  noiseFloorLufs: number | null
  /** How many gated blocks the answer rests on. Few blocks means a short or mostly-silent clip. */
  blocks: number
}

/**
 * Integrated loudness of `[startS, endS)` of a buffer.
 *
 * Pure and synchronous: it copies the range, filters it, and reduces it. No
 * AudioContext, so it runs in a test and in a worker as happily as on the main
 * thread. Returns `lufs: null` rather than a number when the range is silent,
 * because there is no honest gain that makes silence match a target.
 */
export function measureLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
  startS = 0,
  endS = Infinity,
): LoudnessResult {
  if (channels.length === 0 || sampleRate <= 0) return EMPTY_RESULT
  const total = channels[0].length
  const s0 = Math.max(0, Math.min(total, Math.floor(startS * sampleRate)))
  const s1 = Math.max(s0, Math.min(total, Math.ceil(endS * sampleRate)))
  const n = s1 - s0
  const blockLen = Math.floor(BLOCK_S * sampleRate)
  const hopLen = Math.floor(HOP_S * sampleRate)
  if (n < blockLen || blockLen <= 0) {
    // Too short for even one standard block. Measure the whole range as a single
    // block instead of reporting nothing: a 200 ms word is still a real clip.
    if (n <= 0) return EMPTY_RESULT
  }

  const shelf = shelfFilter(sampleRate)
  const hp = highpassFilter(sampleRate)
  const filtered: Float32Array[] = []
  let peak = 0
  // Magnitude histogram for the body peak, in 0.5 dB bins from -120 to 0 dBFS.
  // A histogram rather than a sort: a sorted copy of every sample of a long
  // clip is tens of megabytes and this runs over every clip on the timeline.
  const BINS = 241
  const hist = new Int32Array(BINS)
  let counted = 0
  for (const ch of channels) {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = ch[s0 + i]
      a[i] = v
      const abs = Math.abs(v)
      if (abs > peak) peak = abs
      if (abs > 0) {
        const db = 20 * Math.log10(abs)
        const bin = db <= -120 ? 0 : Math.min(BINS - 1, Math.round((db + 120) * 2))
        hist[bin]++
        counted++
      }
    }
    const b = new Float32Array(n)
    applyBiquad(a, b, shelf)
    applyBiquad(b, a, hp) // a is free to reuse; the shelf output lives in b
    filtered.push(a)
  }

  // Walk down from the top until 0.1% of the samples have been passed.
  let bodyPeak = peak
  if (counted > 0) {
    const allowance = Math.max(1, Math.floor(counted * BODY_PEAK_TOP_FRACTION))
    let seen = 0
    for (let bin = BINS - 1; bin >= 0; bin--) {
      seen += hist[bin]
      if (seen >= allowance) {
        bodyPeak = Math.min(peak, Math.pow(10, (bin / 2 - 120) / 20))
        break
      }
    }
  }

  const len = Math.min(blockLen, n)
  const hop = Math.max(1, Math.min(hopLen, len))
  const powers: number[] = []
  for (let start = 0; start + len <= n; start += hop) {
    let sum = 0
    for (let c = 0; c < filtered.length; c++) {
      const w = channelWeight(c)
      const data = filtered[c]
      let acc = 0
      for (let i = start; i < start + len; i++) acc += data[i] * data[i]
      sum += w * (acc / len)
    }
    powers.push(sum)
  }
  if (powers.length === 0) return { ...EMPTY_RESULT, peak, bodyPeak }

  const loudnessOf = (power: number): number => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity)

  // Absolute gate, then the relative gate computed from what survived it.
  const abs = powers.filter((p) => loudnessOf(p) > ABSOLUTE_GATE_LUFS)
  if (abs.length === 0) return { ...EMPTY_RESULT, peak, bodyPeak }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const relThreshold = loudnessOf(mean(abs)) - RELATIVE_GATE_LU
  const gated = abs.filter((p) => loudnessOf(p) > relThreshold)
  const use = gated.length > 0 ? gated : abs

  // What the room sounds like between the words. Taken from the blocks the gate
  // THREW AWAY, which is the honest place to look for it: the quietest tenth of
  // them, so one half-spoken syllable at the edge of the gate cannot pass for
  // silence. It never changes the loudness answer, it only tells us how far a
  // clip can be lifted before he starts hearing the room instead of himself.
  const rejected = powers.filter((p) => loudnessOf(p) <= relThreshold).sort((a, b) => a - b)
  const noiseFloorLufs =
    rejected.length > 0 ? loudnessOf(rejected[Math.floor(rejected.length * 0.1)] ?? rejected[0]) : null

  return {
    lufs: loudnessOf(mean(use)),
    peak,
    bodyPeak,
    noiseFloorLufs: noiseFloorLufs !== null && Number.isFinite(noiseFloorLufs) ? noiseFloorLufs : null,
    blocks: use.length,
  }
}

/**
 * The gain, in dB, that moves `lufs` to `targetLufs`.
 *
 * WHAT CHANGED, 2026-08-06, and why. Measured with _verify/loudness-truth.mjs
 * on four recordings of ONE voice, levelled and compared:
 *
 *   close mic                      landed at -16.0   correct
 *   close mic, lots of pauses      landed at -16.0   correct
 *   mic further away               landed at -23.0   SEVEN dB too quiet
 *   mic further away + a desk bump landed at -33.3   SEVENTEEN dB too quiet
 *
 * His words: "some clips on my mic are a little bit away... I have to manually
 * adjust it every single time, every single clip." Both misses were this
 * function, not the measurement:
 *
 *   1. maxBoostDb was 12. A mic across the room needs more than that, so the
 *      clip simply stopped short and stayed quiet.
 *   2. the ceiling was applied to the ABSOLUTE PEAK, so one desk bump lasting
 *      a millisecond took the entire headroom budget for an eight second clip.
 *
 * So the ceiling now rides `bodyPeak` (see LoudnessResult), and the boost limit
 * is 24 dB, the same size as the cut limit, because there is no reason a quiet
 * take may be turned down further than a loud one may be turned up.
 */
export function gainForTarget(
  result: LoudnessResult,
  targetLufs: number,
  opts: { maxBoostDb?: number; maxCutDb?: number; peakCeilingDb?: number } = {},
): number | null {
  if (result.lufs === null || !Number.isFinite(result.lufs)) return null
  const maxBoost = opts.maxBoostDb ?? MAX_GAIN_DB
  const maxCut = opts.maxCutDb ?? MAX_GAIN_DB
  const ceiling = opts.peakCeilingDb ?? PEAK_CEILING_DB
  let db = targetLufs - result.lufs
  db = Math.max(-maxCut, Math.min(maxBoost, db))
  const ref = result.bodyPeak > 0 ? result.bodyPeak : result.peak
  if (ref > 0) {
    const headroom = ceiling - 20 * Math.log10(ref)
    if (db > headroom) db = headroom
  }
  return Math.round(db * 10) / 10
}

/** As far as a clip may be moved in either direction. */
export const MAX_GAIN_DB = 24
/** Where the body of the loudest clip is allowed to sit, dBFS. */
export const PEAK_CEILING_DB = -1

export interface ClipLoudness {
  id: string
  measured: LoudnessResult
}

export interface BalancedGain {
  id: string
  db: number
}

/**
 * Gains that make every clip the same loudness AS EACH OTHER, without clipping.
 *
 * "The auto volume doesn't really make everything the same volume" is a
 * question about RELATIVE level, and levelling each clip on its own cannot
 * answer it: the moment one clip runs out of headroom it stops short, and the
 * clip beside it does not, so the two disagree by exactly the amount that was
 * clamped. That is what he has been fixing by hand.
 *
 * So the target is applied to all of them first, and only then is ONE shared
 * offset taken off every clip, just enough that the loudest body peak sits at
 * the ceiling. The clips keep matching each other exactly, which is what he
 * asked for, and the mix is as loud as it can honestly be. A single ugly
 * transient no longer drags anything down, because the offset rides bodyPeak.
 */
export function balanceGains(clips: readonly ClipLoudness[], targetLufs: number): BalancedGain[] {
  const raw: { id: string; db: number; peakDb: number }[] = []
  for (const c of clips) {
    const { lufs, bodyPeak, peak } = c.measured
    if (lufs === null || !Number.isFinite(lufs)) continue
    const db = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, targetLufs - lufs))
    const ref = bodyPeak > 0 ? bodyPeak : peak
    raw.push({ id: c.id, db, peakDb: ref > 0 ? 20 * Math.log10(ref) : -Infinity })
  }
  if (raw.length === 0) return []
  // The worst offender decides the offset for everyone, so nobody drifts apart.
  let overshoot = 0
  for (const r of raw) {
    if (!Number.isFinite(r.peakDb)) continue
    overshoot = Math.max(overshoot, r.peakDb + r.db - PEAK_CEILING_DB)
  }
  return raw.map((r) => ({ id: r.id, db: Math.round((r.db - overshoot) * 10) / 10 }))
}

/**
 * Where a short-form voice track wants to sit. -16 LUFS is the level the social
 * platforms normalise to, so a mix delivered here is the one that comes back
 * unchanged rather than turned down on the way in.
 */
export const TARGET_LUFS = -16
