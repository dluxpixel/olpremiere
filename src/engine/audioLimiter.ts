// The one master limiter, shared by all three audio paths.
//
// WHY IT MOVED HERE. There are three places a mix is summed: the live preview
// graph (engine/audio.ts), the OfflineAudioContext export render
// (export/audioRender.ts), and the pure worker mixer (export/audioMix.ts).
// Only the third had a limiter. audioMix's own header said so out loud:
//
//   "a soft limiter is applied at the master bus. audioRender has none (it
//    relies on the downstream encoder clamp)."
//
// So the two paths he actually hears disagreed with the one that renders, and
// the disagreement only showed up on loud material, which is precisely when it
// matters. Everything below the knee is IDENTITY, so a normal mix is unchanged
// to the bit and no existing export moves.
//
// It became load-bearing on 2026-08-06. Levelling every clip to the same
// loudness (see loudness.ts) is what he asked for, and a correct loudness match
// puts the peaks of a lively take near full scale. Without a limiter the only
// way to guarantee no clipping is to refuse the gain, which is exactly the
// behaviour that had him adjusting every clip by hand.

/** Above this the limiter starts working; below it, nothing happens at all. */
export const LIMIT_KNEE = 0.8
/**
 * Where the limiter asymptotes: -1 dBFS, not full scale.
 *
 * It used to be 1.0, and tanh reaches 1.0 in float64 once the input is about
 * 8 dB over the knee, so a levelled clip with a desk bump in it came out at
 * EXACTLY full scale. That is the one sample value a 16-bit encoder has to
 * round, and it leaves nothing for the inter-sample peaks that appear after
 * lossy encoding.
 *
 * -0.3 dBFS (0.9661) fixed the "exactly full scale" half of that and left the
 * headroom half short. The delivery standard is -1 dBTP at the codec input, and
 * it exists because a lossy re-encode reconstructs a waveform that overshoots
 * its own samples: a file that peaks at -0.3 goes over 0 dBTP once YouTube
 * re-encodes it, and the listener's converter clips something we never wrote.
 * A decibel of headroom is inaudible, and it is the only part of this the app
 * can control, because the overshoot happens on a machine we do not own.
 *
 * ONE constant, THREE paths. This is the ceiling for the live preview
 * (engine/audio.ts), the OfflineAudioContext export render
 * (export/audioRender.ts) and the pure worker mixer (export/audioMix.ts) alike,
 * which is the point of this module: a delivery ceiling that moved without the
 * preview moving with it would reopen exactly the divergence closed on
 * 2026-08-06. What he hears is what ships.
 *
 * Honest about what it measures: this pins the SAMPLE peak at -1 dBFS. True
 * peak is only ever estimated, and a tanh asymptote that is approached and never
 * reached is about as gentle as a waveform gets, so the true peak sits under the
 * sample peak's decibel of room rather than needing its own oversampled search.
 */
export const LIMIT_CEILING = 0.8913
const LIMIT_RANGE = LIMIT_CEILING - LIMIT_KNEE

/**
 * Soft-limit one sample; identity for |x| <= LIMIT_KNEE.
 *
 * A tanh knee that asymptotes to +/-LIMIT_CEILING and never reaches it.
 * C1-continuous (slope 1 on both sides at the knee, because the range cancels
 * in the derivative), so there is no audible corner where the limiter engages.
 */
export function softLimit(x: number): number {
  const a = x < 0 ? -x : x
  if (a <= LIMIT_KNEE) return x
  const sign = x < 0 ? -1 : 1
  const over = a - LIMIT_KNEE
  return sign * (LIMIT_KNEE + LIMIT_RANGE * Math.tanh(over / LIMIT_RANGE))
}

/**
 * How far past full scale the shaper still limits correctly.
 *
 * A WaveShaperNode clamps its INPUT to [-1, 1] before reading the curve, so a
 * sample at +6 dBFS would be read as if it were exactly 1.0 and the limiter
 * would flatten everything above full scale to one value. Feeding it x/RANGE
 * and baking the same factor into the curve moves the whole usable window out
 * to +/-4, which is +12 dBFS: past anything a levelled mix can reach.
 */
const SHAPER_RANGE = 4
/** Curve resolution. softLimit is smooth, so linear interpolation between these is exact to ~1e-7. */
const CURVE_POINTS = 8193

export function softLimitCurve(): Float32Array {
  const curve = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = (i / (CURVE_POINTS - 1)) * 2 - 1 // -1..1
    curve[i] = softLimit(t * SHAPER_RANGE)
  }
  return curve
}

/**
 * A limiter for a Web Audio graph, as a connected {input, output} pair.
 *
 * The pre-gain is what makes the shaper's clamped input window usable (see
 * SHAPER_RANGE). There is no post-gain: the curve already holds the final
 * value, so the output is `softLimit(x)` for any |x| <= SHAPER_RANGE.
 */
export function createSoftLimiter(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode } {
  const pre = ctx.createGain()
  pre.gain.value = 1 / SHAPER_RANGE
  const shaper = ctx.createWaveShaper()
  shaper.curve = softLimitCurve()
  shaper.oversample = '2x'
  pre.connect(shaper)
  return { input: pre, output: shaper }
}
