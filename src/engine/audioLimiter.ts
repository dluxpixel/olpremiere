// The one master limiter, shared by the export and the live preview.
//
// WHY IT MOVED HERE. There were three places a mix was summed: the live
// preview graph (engine/audio.ts), the OfflineAudioContext export render
// (export/audioRender.ts), and a pure worker mixer (export/audioMix.ts, later
// deleted as dead code once both real export paths turned out to use
// audioRender.ts instead). Only the third had a limiter. So the two paths he
// actually hears disagreed with the one that rendered, and the disagreement only
// showed up on loud material, which is precisely when it matters.
//
// WHY IT IS NO LONGER A WAVESHAPER, 2026-10-01. Until today this file held a
// tanh curve on a WaveShaperNode: identity below 0.8, bent toward the ceiling
// above it. That is a soft CLIPPER, not a limiter, and the backtest measured
// what a clipper does to a 1 kHz tone in the real export: 2.6% distortion at
// -0.5 dBFS, 4.7% at 0 dBFS, 19% at +3.5 and 25% at +5.5. On his own mixes it
// squashed 49 samples of GYM and 266 of "best cat". It also could not carry a
// loudness target: turning Green up to the platforms' level would have pushed
// every word through the curve. And its 2x oversampling delayed the whole mix by
// 128 samples, the 2.67 ms the iPhone sync check found on top of the AAC fix.
//
// What is here now is a real look-ahead limiter. It reads the TRUE peak (the
// waveform between the samples, four points per sample, the way BS.1770 meters
// it), sees 1.5 ms ahead, and turns the gain down smoothly BEFORE a peak arrives
// instead of bending the peak itself. Below the ceiling it does nothing at all:
// the gain is exactly 1 and every sample comes out bit for bit. One class does
// the work for both paths: the export runs it on the rendered PCM
// (export/audioRender.ts), the preview runs the same class inside an
// AudioWorklet (limiterWorklet.ts), so what he hears is what ships.

/**
 * The delivery ceiling, dBTP: true peak, not sample peak.
 *
 * -1 dBTP is the platform standard, and the backtest measured why aiming AT it
 * is not enough: the AAC encode rebuilds a waveform that overshoots its input,
 * so a mix that peaked at exactly -1.0 came back from the encoder at -0.9 (best
 * cat, GYM). The limiter therefore aims under the delivery number by
 * ENCODE_HEADROOM_DB, so the FILE meets -1 dBTP after the encode, which is the
 * number YouTube, TikTok and Instagram read. Measured on his five mixes levelled
 * to -14 LUFS: -1.5 dBTP into the encoder, -1.4 to -1.5 out of it at 384 kb/s.
 * The rest of the half decibel is for material brighter than his, where the
 * true peak between samples is hardest to see (white noise reads up to 0.35 dB
 * over the ceiling on a 4x meter).
 */
export const DELIVERY_CEILING_DBTP = -1
/** Room for the AAC encoder's own overshoot, measured on his mixes at 384 kb/s. */
export const ENCODE_HEADROOM_DB = 0.5
/** Where the limiter holds the true peak, dBTP. */
export const LIMIT_CEILING_DBTP = DELIVERY_CEILING_DBTP - ENCODE_HEADROOM_DB
/** The same ceiling as a linear amplitude. */
export const LIMIT_CEILING = 10 ** (LIMIT_CEILING_DBTP / 20)

/** How far ahead the limiter looks, so the gain is already down when a peak lands. */
export const LOOKAHEAD_S = 0.0015
/** How fast the gain comes back up after a peak. Slow enough not to pump on speech. */
export const RELEASE_S = 0.08

/**
 * Taps on each side of an interpolated point. Sixteen holds pure tones up to
 * 19.9 kHz exactly at the ceiling (tested); twelve let full-band noise read
 * 0.6 dB over it, twenty-four bought almost nothing more. It costs nothing in
 * quiet passages, which are skipped (see `loudFrom`).
 */
const TP_HALF = 16
/** Interpolated points per sample, besides the sample itself: 1/4, 2/4 and 3/4. */
const TP_PHASES = 3

/** Modified Bessel function of the first kind, order 0, for the Kaiser window. */
function bessel0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

/**
 * The interpolation filters for the points a quarter, a half and three quarters
 * of the way to the next sample. Row p, tap j multiplies x[n - TP_HALF + 1 + j]
 * to give the waveform at n + (p + 1) / 4. Kaiser-windowed sinc, each row
 * normalised to unity gain at DC so a constant reads as itself.
 */
function truePeakTaps(): Float64Array[] {
  const beta = 8
  const i0 = bessel0(beta)
  const rows: Float64Array[] = []
  for (let p = 0; p < TP_PHASES; p++) {
    const frac = (p + 1) / (TP_PHASES + 1)
    const row = new Float64Array(2 * TP_HALF)
    let sum = 0
    for (let j = 0; j < 2 * TP_HALF; j++) {
      const t = j - (TP_HALF - 1) - frac // distance from the interpolated point, in samples
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
      const r = t / TP_HALF
      const w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0
      row[j] = sinc * w
      sum += row[j]
    }
    for (let j = 0; j < row.length; j++) row[j] /= sum
    rows.push(row)
  }
  return rows
}

const TAPS = truePeakTaps()
/** The most any interpolated point can exceed the largest sample in its window. */
const TAP_GAIN = Math.max(...TAPS.map((row) => row.reduce((s, v) => s + Math.abs(v), 0)))

/** The AudioWorklet processor name the preview registers the limiter under. */
export const LIMITER_PROCESSOR = 'olp-true-peak-limiter'

export interface LimiterOptions {
  ceilingDb?: number
  lookaheadS?: number
  releaseS?: number
}

/** Frames of delay a limiter at this rate adds, which every caller removes. */
export function limiterLatencyFrames(sampleRate: number, lookaheadS = LOOKAHEAD_S): number {
  return TP_HALF + Math.max(1, Math.round(lookaheadS * sampleRate))
}

/**
 * A streaming true-peak look-ahead limiter.
 *
 * Feed it the mix in order, any block size; it hands back the same number of
 * frames, `latency` frames late. Whoever calls it removes that delay (the export
 * drops the head of its output, the preview starts the sources that much early),
 * so nothing anywhere is late.
 *
 * The gain path, per sample j:
 *   need[n]   = ceiling / truePeak(n) where the true peak is over it, else 1
 *   target[j] = the smallest need in [j - 1, j + look-ahead]
 *   r[j]      = target[j] when that is lower, else a slow release back up
 *   g[j]      = the average of r over the last look-ahead + 1 samples
 * Every r in that average is no higher than need[j - 1] and need[j], so the
 * smoothed gain still never lets a peak through, while the average turns each
 * gain change into a ramp instead of a step, which is what keeps the limiter from
 * adding distortion of its own. With nothing over the ceiling every value is
 * exactly 1 and the samples pass untouched.
 */
export class TruePeakLimiter {
  /** Frames of delay between what goes in and what comes out. */
  readonly latency: number
  private readonly ceiling: number
  private readonly look: number
  private readonly release: number
  private readonly loudAt: number
  private readonly mask: number
  private readonly rings: Float64Array[]
  /** Frames fed so far. */
  private m = 0
  /** Index of the last frame loud enough that its neighbourhood must be measured. */
  private loudFrom = -Infinity
  // Sliding minimum of `need` over [j - 1, j + look], as a monotonic deque.
  private readonly dqIdx: Float64Array
  private readonly dqVal: Float64Array
  private dqHead = 0
  private dqLen = 0
  private readonly dqCap: number
  // Release state and the moving average of it.
  private r = 1
  private readonly box: Float64Array
  private boxPos = 0
  private boxSum: number
  private boxBelow = 0

  readonly channels: number
  readonly sampleRate: number

  constructor(channels: number, sampleRate: number, opts: LimiterOptions = {}) {
    this.channels = channels
    this.sampleRate = sampleRate
    this.ceiling = 10 ** ((opts.ceilingDb ?? LIMIT_CEILING_DBTP) / 20)
    this.look = Math.max(1, Math.round((opts.lookaheadS ?? LOOKAHEAD_S) * sampleRate))
    this.release = Math.exp(-1 / ((opts.releaseS ?? RELEASE_S) * sampleRate))
    this.latency = TP_HALF + this.look
    this.loudAt = this.ceiling / TAP_GAIN
    let size = 1
    while (size < 2 * TP_HALF + this.look + 4) size <<= 1
    this.mask = size - 1
    this.rings = Array.from({ length: channels }, () => new Float64Array(size))
    this.dqCap = this.look + 4
    this.dqIdx = new Float64Array(this.dqCap)
    this.dqVal = new Float64Array(this.dqCap)
    this.box = new Float64Array(this.look + 1).fill(1)
    this.boxSum = this.look + 1
  }

  /**
   * Limit one block. `output[c]` receives `input[c]` delayed by `latency` frames
   * and limited. A channel missing from `input` is read as silence. The arrays
   * may be the same length or the output longer; `frames` frames are processed.
   */
  process(input: readonly (Float32Array | undefined)[], output: readonly Float32Array[], frames = output[0]?.length ?? 0): void {
    const { rings, mask, channels } = this
    for (let i = 0; i < frames; i++) {
      const m = this.m++
      // 1. Take the new frame in, and note whether it is loud enough to matter.
      let frameMax = 0
      for (let c = 0; c < channels; c++) {
        const v = input[c]?.[i] ?? 0
        rings[c][m & mask] = v
        const a = v < 0 ? -v : v
        if (a > frameMax) frameMax = a
      }
      if (frameMax >= this.loudAt) this.loudFrom = m

      // 2. Measure the true peak around frame n, now that TP_HALF frames after it are in.
      const n = m - TP_HALF
      let need = 1
      if (n >= 0 && this.loudFrom >= n - TP_HALF + 1) {
        let peak = 0
        for (let c = 0; c < channels; c++) {
          const ring = rings[c]
          const s = ring[n & mask]
          const sa = s < 0 ? -s : s
          if (sa > peak) peak = sa
          for (let p = 0; p < TP_PHASES; p++) {
            const row = TAPS[p]
            let acc = 0
            const base = n - TP_HALF + 1
            for (let j = 0; j < 2 * TP_HALF; j++) acc += ring[(base + j) & mask] * row[j]
            const aa = acc < 0 ? -acc : acc
            if (aa > peak) peak = aa
          }
        }
        if (peak > this.ceiling) need = this.ceiling / peak
      }
      if (n >= 0) this.pushNeed(n, need)

      // 3. The gain for frame j = n - look: the window's smallest need, the
      //    release, and the moving average that turns it into a ramp.
      const j = n - this.look
      let g = 1
      if (j >= 0) {
        this.dropBefore(j - 1)
        const target = this.dqLen > 0 ? this.dqVal[this.dqHead] : 1
        if (target < this.r) this.r = target
        else {
          this.r = target - (target - this.r) * this.release
          // Land exactly on 1 rather than creep toward it forever, so a mix that
          // was limited once is bit-identical again about a second later. The
          // last step is 0.0001 dB, far below anything audible.
          if (target === 1 && 1 - this.r < 1e-5) this.r = 1
        }
        const old = this.box[this.boxPos]
        this.box[this.boxPos] = this.r
        this.boxPos = this.boxPos === this.look ? 0 : this.boxPos + 1
        if (old < 1) this.boxBelow--
        if (this.r < 1) this.boxBelow++
        this.boxSum += this.r - old
        if (this.boxBelow === 0) {
          this.boxSum = this.look + 1 // clear any rounding drift
          g = 1
        } else g = this.boxSum / (this.look + 1)
      }

      // 4. Out goes frame j, `latency` frames behind the frame that came in.
      for (let c = 0; c < output.length; c++) {
        output[c][i] = j >= 0 && c < channels ? rings[c][j & mask] * g : 0
      }
    }
  }

  private pushNeed(n: number, need: number): void {
    // Keep the deque's values increasing from the front: anything at or above
    // the newcomer can never be a window minimum again.
    while (this.dqLen > 0) {
      const last = (this.dqHead + this.dqLen - 1) % this.dqCap
      if (this.dqVal[last] >= need) this.dqLen--
      else break
    }
    const at = (this.dqHead + this.dqLen) % this.dqCap
    this.dqIdx[at] = n
    this.dqVal[at] = need
    this.dqLen++
  }

  private dropBefore(first: number): void {
    while (this.dqLen > 0 && this.dqIdx[this.dqHead] < first) {
      this.dqHead = (this.dqHead + 1) % this.dqCap
      this.dqLen--
    }
  }
}
