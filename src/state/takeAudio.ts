// What the recorder learns from a finished take before he reviews it: how hot
// it really got (MIC-3), and whether its two channels are one voice twice
// (MIC-7). Reads the take the same way the app will read it once kept
// (engine/audioDemux, at the file's own rate), so what is measured here is what
// plays.

/**
 * Where the clip light comes on: -1 dBFS. The capture is raw, auto gain OFF on
 * purpose, so his input gain is the only thing standing between the voice and
 * full scale, and 5 of his 65 takes crossed it with nothing on screen saying so.
 */
export const CLIP_DBFS = -1
export const CLIP_AMP = Math.pow(10, CLIP_DBFS / 20)

/** Absolute sample peak across every channel. */
export function peakOf(planes: readonly Float32Array[]): number {
  let peak = 0
  for (const p of planes) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i]! < 0 ? -p[i]! : p[i]!
      if (a > peak) peak = a
    }
  }
  return peak
}

/** Keep the take as it came, or store ONE of its channels as a mono take. */
export type ChannelPlan = { keep: 'as-is' } | { keep: 'mono'; channel: number; why: 'dual-mono' | 'one-side' }

/** L minus R this far under the voice: one voice recorded twice. His 65 takes measured -60 to -69 dB. */
export const DUAL_MONO_DB = -40
/** One side this far under the other: a mic on input 1 of an interface, the other input empty. */
export const ONE_SIDE_DB = -30

/**
 * ⛔ MIC-7, 2026-09-30. Every take he has ever recorded is stereo with the same
 * voice on both sides (L minus R -60 to -69 dB): the browser ignores the mono
 * request and hands over the device's two channels. Harmless while takes were
 * Opus, but a lossless take pays for the copy in full, twice the size for
 * nothing. And an interface with the mic on input 1 only would have played his
 * voice out of the left speaker alone.
 */
export function channelPlan(planes: readonly Float32Array[]): ChannelPlan {
  if (planes.length !== 2) return { keep: 'as-is' }
  const [l, r] = planes as [Float32Array, Float32Array]
  let el = 0
  let er = 0
  let ed = 0
  for (let i = 0; i < l.length; i++) {
    const a = l[i]!
    const b = r[i] ?? 0
    el += a * a
    er += b * b
    ed += (a - b) * (a - b)
  }
  const loud = Math.max(el, er)
  // Silence on both sides is one channel's worth of nothing.
  if (loud === 0) return { keep: 'mono', channel: 0, why: 'dual-mono' }
  if (10 * Math.log10(ed / ((el + er) / 2) + 1e-30) < DUAL_MONO_DB) return { keep: 'mono', channel: 0, why: 'dual-mono' }
  if (10 * Math.log10(Math.min(el, er) / loud + 1e-30) < ONE_SIDE_DB) {
    return { keep: 'mono', channel: el >= er ? 0 : 1, why: 'one-side' }
  }
  return { keep: 'as-is' }
}

/**
 * One channel as a 32-bit float WAV: the samples exactly as captured, no
 * quantising, no gain. A mono take is left at the same sample values as each
 * side of the stereo one, so it plays exactly as loud once the mixers play a
 * mono source on both sides at unity.
 */
export function monoWavF32(samples: Float32Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44)
  const dv = new DataView(header)
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  const dataBytes = samples.length * 4
  tag(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 3, true) // IEEE float
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 4, true)
  dv.setUint16(32, 4, true)
  dv.setUint16(34, 32, true)
  tag(36, 'data')
  dv.setUint32(40, dataBytes, true)
  // WAV is little endian, and so is every machine this app runs on, so the
  // float array's own bytes are the data chunk.
  const body = new Float32Array(samples)
  return new Blob([header, body.buffer], { type: 'audio/wav' })
}

export interface TakeReport {
  /** Sample peak of the take as stored, linear. */
  peak: number
  /** The mono take to keep instead, or null to keep the take as recorded. */
  mono: Blob | null
}

/**
 * Read a finished take and say what it holds. `lossless` is whether it can be
 * stored mono without changing a sample: an Opus take would only grow as a WAV,
 * so only a PCM take is ever rewritten. Null when the take cannot be read here
 * (no decoder in this environment), in which case it is kept exactly as it came.
 */
export async function readTake(blob: Blob, lossless: boolean): Promise<TakeReport | null> {
  try {
    const { demuxAudio } = await import('../engine/audioDemux')
    const got = await demuxAudio(blob, { durationS: 0 })
    if (got.kind !== 'pcm') return null
    const peak = peakOf(got.planes)
    const plan = lossless ? channelPlan(got.planes) : { keep: 'as-is' as const }
    const mono = plan.keep === 'mono' ? monoWavF32(got.planes[plan.channel]!, got.sampleRate) : null
    return { peak, mono }
  } catch {
    return null
  }
}
