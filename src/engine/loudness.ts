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

export interface LoudnessResult {
  /** Integrated loudness in LUFS, or null when there was nothing above the silence gate. */
  lufs: number | null
  /** True peak-ish sample peak in the range, linear 0..1. Used only to refuse to clip. */
  peak: number
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
  if (channels.length === 0 || sampleRate <= 0) return { lufs: null, peak: 0, blocks: 0 }
  const total = channels[0].length
  const s0 = Math.max(0, Math.min(total, Math.floor(startS * sampleRate)))
  const s1 = Math.max(s0, Math.min(total, Math.ceil(endS * sampleRate)))
  const n = s1 - s0
  const blockLen = Math.floor(BLOCK_S * sampleRate)
  const hopLen = Math.floor(HOP_S * sampleRate)
  if (n < blockLen || blockLen <= 0) {
    // Too short for even one standard block. Measure the whole range as a single
    // block instead of reporting nothing: a 200 ms word is still a real clip.
    if (n <= 0) return { lufs: null, peak: 0, blocks: 0 }
  }

  const shelf = shelfFilter(sampleRate)
  const hp = highpassFilter(sampleRate)
  const filtered: Float32Array[] = []
  let peak = 0
  for (const ch of channels) {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = ch[s0 + i]
      a[i] = v
      const abs = Math.abs(v)
      if (abs > peak) peak = abs
    }
    const b = new Float32Array(n)
    applyBiquad(a, b, shelf)
    applyBiquad(b, a, hp) // a is free to reuse; the shelf output lives in b
    filtered.push(a)
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
  if (powers.length === 0) return { lufs: null, peak, blocks: 0 }

  const loudnessOf = (power: number): number => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity)

  // Absolute gate, then the relative gate computed from what survived it.
  const abs = powers.filter((p) => loudnessOf(p) > ABSOLUTE_GATE_LUFS)
  if (abs.length === 0) return { lufs: null, peak, blocks: 0 }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const relThreshold = loudnessOf(mean(abs)) - RELATIVE_GATE_LU
  const gated = abs.filter((p) => loudnessOf(p) > relThreshold)
  const use = gated.length > 0 ? gated : abs
  return { lufs: loudnessOf(mean(use)), peak, blocks: use.length }
}

/**
 * The gain, in dB, that moves `lufs` to `targetLufs`.
 *
 * Clamped for two reasons that are not the same. `maxBoostDb` stops a nearly
 * silent take being lifted until its room noise is as loud as speech. The peak
 * ceiling stops a loud take being lifted into clipping, which no amount of
 * correct loudness maths excuses.
 */
export function gainForTarget(
  result: LoudnessResult,
  targetLufs: number,
  opts: { maxBoostDb?: number; maxCutDb?: number; peakCeilingDb?: number } = {},
): number | null {
  if (result.lufs === null || !Number.isFinite(result.lufs)) return null
  const maxBoost = opts.maxBoostDb ?? 12
  const maxCut = opts.maxCutDb ?? 24
  const ceiling = opts.peakCeilingDb ?? -1
  let db = targetLufs - result.lufs
  db = Math.max(-maxCut, Math.min(maxBoost, db))
  if (result.peak > 0) {
    const headroom = ceiling - 20 * Math.log10(result.peak)
    if (db > headroom) db = headroom
  }
  return Math.round(db * 10) / 10
}

/**
 * Where a short-form voice track wants to sit. -16 LUFS is the level the social
 * platforms normalise to, so a mix delivered here is the one that comes back
 * unchanged rather than turned down on the way in.
 */
export const TARGET_LUFS = -16
