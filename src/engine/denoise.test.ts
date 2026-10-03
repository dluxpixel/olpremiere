import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  denoiseChannel,
  denoisedBufferFor,
  denoiseEvictionPlan,
  ensureRnnoise,
  MAX_REDUCTION_DB,
  mixDryWet,
  wetShareFor,
  type DenoiseEngine,
} from './denoise'
import type { MediaAsset } from './types'

// A deterministic stand-in for the wasm: halves every sample in place. Lets
// the chunking/scaling logic be pinned without loading RNNoise in node.
const halver = (frameSize: number): DenoiseEngine => ({
  frameSize,
  createDenoiseState: () => ({
    processFrame(frame: Float32Array) {
      for (let i = 0; i < frame.length; i++) frame[i] = frame[i]! / 2
      return 0
    },
    destroy() {},
  }),
})

describe('mixDryWet', () => {
  const raw = Float32Array.from([0.5, -0.25, 1, 0])
  const wet = Float32Array.from([0.1, 0.1, 0.1, 0.1])

  it('strength 0 is numerically identical to raw (the A/B guarantee)', () => {
    expect(Array.from(mixDryWet(raw, wet, 0))).toEqual(Array.from(raw))
  })

  it('strength 1 is the wet signal; 0.5 is the exact average', () => {
    expect(Array.from(mixDryWet(raw, wet, 1))).toEqual(Array.from(wet))
    const half = mixDryWet(raw, wet, 0.5)
    // float32 storage: compare to 6 places, not exact decimal literals
    for (const [i, v] of [0.3, -0.075, 0.55, 0.05].entries()) expect(half[i]).toBeCloseTo(v, 6)
  })

  it('clamps out-of-range strengths instead of extrapolating', () => {
    expect(Array.from(mixDryWet(raw, wet, 2))).toEqual(Array.from(wet))
    expect(Array.from(mixDryWet(raw, wet, -1))).toEqual(Array.from(raw))
  })

  it('returns a NEW array and never mutates the cached raw PCM', () => {
    const out = mixDryWet(raw, wet, 1)
    expect(out).not.toBe(wet)
    expect(raw[0]).toBe(0.5)
  })
})

// A stand-in with a real model's habit: it hands back what it was given
// `frames` frames later, like RNNoise does with its two.
const lateBy = (frameSize: number, frames: number): DenoiseEngine => ({
  frameSize,
  createDenoiseState: () => {
    const queue: Float32Array[] = Array.from({ length: frames }, () => new Float32Array(frameSize))
    return {
      processFrame(frame: Float32Array) {
        queue.push(Float32Array.from(frame))
        frame.set(queue.shift()!)
        return 0
      },
      destroy() {},
    }
  },
})

describe('denoiseChannel (chunking + 16-bit scaling)', () => {
  // The halver has no latency, so these pass 0: they pin the chunking alone.
  it('processes whole frames and preserves length', () => {
    const input = Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 10)
    const out = denoiseChannel(halver(4), input, 0)
    expect(out.length).toBe(8)
    for (let i = 0; i < 8; i++) expect(out[i]).toBeCloseTo(input[i]! / 2, 6)
  })

  it('zero-pads the tail frame and truncates back (no length drift)', () => {
    const input = Float32Array.from([0.2, 0.4, 0.6, 0.8, 1, 0.5]) // 6 samples, frame 4
    const out = denoiseChannel(halver(4), input, 0)
    expect(out.length).toBe(6)
    expect(out[5]).toBeCloseTo(0.25, 6)
  })

  it('does not mutate its input', () => {
    const input = Float32Array.from([0.5, 0.5, 0.5, 0.5])
    denoiseChannel(halver(4), input, 0)
    expect(Array.from(input)).toEqual([0.5, 0.5, 0.5, 0.5])
  })

  it('takes a late model back to sample zero, keeping every sample to the last', () => {
    // 11 samples through a model two 4-sample frames late: the tail must still
    // come out, which is why the model is fed silence past the end.
    const input = Float32Array.from({ length: 11 }, (_, i) => (i + 1) / 20)
    const out = denoiseChannel(lateBy(4, 2), input, 8)
    for (let i = 0; i < 11; i++) expect(out[i]).toBeCloseTo(input[i]!, 6)
  })

  it('assumes the real model is two frames late unless told otherwise', () => {
    const input = Float32Array.from({ length: 30 }, (_, i) => Math.sin(i))
    const out = denoiseChannel(lateBy(4, 2), input)
    for (let i = 0; i < 30; i++) expect(out[i]).toBeCloseTo(input[i]!, 6)
  })

  // Determinism and "actually reduces noise" against real RNNoise in the app
  // live in e2e/denoise.spec.ts. What the model does to the TIMING and the LEVEL
  // of a voice is pinned below, against the real wasm, in node.
})

// ---------------------------------------------------------------------------
// THE REAL MODEL, IN NODE.
//
// The emscripten glue refuses to start without a `window`, and that is the only
// thing it wants from a browser: the model is plain wasm with its binary inside
// the module. So a stub for the length of the load is enough, and the numbers
// below are the numbers the app gets.
let real: DenoiseEngine
beforeAll(async () => {
  vi.stubGlobal('window', globalThis)
  try {
    real = await ensureRnnoise()
  } finally {
    vi.unstubAllGlobals()
  }
}, 30_000)

/**
 * A voice-like take, deterministic: a glottal pulse train (a male voice, f0
 * gliding 85 to 150 Hz) through three formant resonances, in syllables of a
 * quarter second with a quarter second of pause between them, over a room floor
 * at about -56 dBFS, which is the median floor of his 65 real takes.
 */
function voiceTake(sampleRate: number, seconds: number): { x: Float32Array; voiced: number[]; pauses: number[] } {
  const n = Math.round(sampleRate * seconds)
  const x = new Float32Array(n)
  let seed = 20260930
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1
  const formants = [
    [600, 90],
    [1400, 120],
    [2500, 160],
  ].map(([f, bw]) => {
    const r = Math.exp((-Math.PI * bw!) / sampleRate)
    return { a1: -2 * r * Math.cos((2 * Math.PI * f!) / sampleRate), a2: r * r, y1: 0, y2: 0 }
  })
  const voice = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    phase += (117 + 33 * Math.sin(2 * Math.PI * 0.9 * t)) / sampleRate
    const pulse = phase >= 1 ? 1 : 0
    if (phase >= 1) phase -= 1
    let y = 0
    for (const f of formants) {
      const v = pulse - f.a1 * f.y1 - f.a2 * f.y2
      f.y2 = f.y1
      f.y1 = v
      y += v
    }
    // Syllables: on for the first half of every half second, raised-cosine edges.
    const s = (t * 2) % 1
    const env = s < 0.5 ? Math.sin((Math.PI * s) / 0.5) ** 0.25 : 0
    voice[i] = y * env
  }
  // Voice at about -20 dBFS RMS while it speaks, like his takes (median peak -5.8).
  let q = 0
  let m = 0
  for (let i = 0; i < n; i++) {
    if (((i / sampleRate) * 2) % 1 >= 0.5) continue
    q += voice[i]! ** 2
    m++
  }
  const g = 0.1 / Math.sqrt(q / m)
  for (let i = 0; i < n; i++) x[i] = voice[i]! * g + 0.0016 * rnd() * Math.sqrt(3)
  // 20 ms windows well inside a syllable, and well inside a pause. The first
  // second is skipped: the model is still learning the room.
  const w = Math.round(sampleRate * 0.02)
  const voiced: number[] = []
  const pauses: number[] = []
  for (let a = sampleRate; a + w <= n; a += w) {
    const s = ((a / sampleRate) * 2) % 1
    const e = (((a + w) / sampleRate) * 2) % 1
    if (s >= 0.1 && e <= 0.4 && e > s) voiced.push(a)
    if (s >= 0.6 && e <= 0.95 && e > s) pauses.push(a)
  }
  return { x, voiced, pauses }
}

/**
 * Lag (samples) at which `b` best matches `a`: b[i + lag] ~ a[i]. Summed over
 * one second of voice starting at `at`, every lag from `from` to `to`, which is
 * wide enough to see the 960 it used to be.
 */
function bestLag(a: Float32Array, b: Float32Array, at: number, span: number, from = -64, to = 1100): number {
  let best = -Infinity
  let lag = 0
  for (let d = from; d <= to; d++) {
    let s = 0
    for (let i = at; i < at + span; i += 2) s += a[i]! * b[i + d]!
    if (s > best) {
      best = s
      lag = d
    }
  }
  return lag
}

/** RMS in dBFS over a set of windows. */
function windowsDb(x: Float32Array, starts: number[], w: number): number {
  let q = 0
  for (const a of starts) for (let i = a; i < a + w; i++) q += x[i]! ** 2
  return 10 * Math.log10(q / (starts.length * w))
}

/** In-place radix 2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const cr = Math.cos(ang * k)
        const ci = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const br = re[b]! * cr - im[b]! * ci
        const bi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - br
        im[b] = im[a]! - bi
        re[a] = re[a]! + br
        im[a] = im[a]! + bi
      }
    }
  }
}

/**
 * How a mix changes the voice between 80 Hz and 1 kHz: the power ratio of mix to
 * dry at every FFT bin that carries the voice (within 20 dB of the loudest bin in
 * that range), averaged over the spoken syllables. A comb shows as deep dips.
 */
function voiceBandRatioDb(dry: Float32Array, mix: Float32Array, voiced: number[], sampleRate: number): { min: number; max: number } {
  const N = 4096
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
  const D = new Float64Array(N / 2)
  const M = new Float64Array(N / 2)
  // Syllable centres: one FFT per syllable, centred on its loudest part.
  const centres = new Set(voiced.map((a) => Math.floor((a / sampleRate) * 2)))
  for (const c of centres) {
    const at = Math.round(((c + 0.25) / 2) * sampleRate) - N / 2
    if (at < sampleRate || at + N > dry.length) continue
    for (const [sig, acc] of [
      [dry, D],
      [mix, M],
    ] as const) {
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      for (let k = 0; k < N; k++) re[k] = sig[at + k]! * hann[k]!
      fft(re, im)
      for (let k = 0; k < N / 2; k++) acc[k] = acc[k]! + re[k]! ** 2 + im[k]! ** 2
    }
  }
  const lo = Math.round((80 * N) / sampleRate)
  const hi = Math.round((1000 * N) / sampleRate)
  let peak = 0
  for (let k = lo; k <= hi; k++) peak = Math.max(peak, D[k]!)
  let min = Infinity
  let max = -Infinity
  for (let k = lo; k <= hi; k++) {
    if (D[k]! < peak / 100) continue
    const r = 10 * Math.log10(M[k]! / D[k]!)
    min = Math.min(min, r)
    max = Math.max(max, r)
  }
  return { min, max }
}

/** An AudioBuffer stand-in, enough for denoisedBufferFor. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    sampleRate,
    duration: channels[0]!.length / sampleRate,
    getChannelData: (ch: number) => channels[ch]!,
  } as unknown as AudioBuffer
}
const makeBuffer = (c: number, l: number, r: number): AudioBuffer =>
  fakeBuffer(
    Array.from({ length: c }, () => new Float32Array(l)),
    r,
  )
const asset = (id: string) => ({ id }) as unknown as MediaAsset

// The real model is slow in a busy suite (a second of work per second of audio
// on a loaded machine, against 85 ms in the app), so each fixture goes through
// it ONCE and every check below reads the same pass. The timeouts are for load,
// not for anything these measure.
const MODEL_TIMEOUT = 180_000

// ⛔ MIC-1, 2026-09-30. The model's output is 960 samples (20 ms) behind its
// input, and nothing compensated for it. The comment at the top of denoise.ts
// said the output "aligns 1:1 with its input frame", and the backtest measured
// the opposite on his own takes: wet at lag 959, r = 0.991. So every strength
// between 0 and 100% laid the voice over a copy of itself 20 ms late, notches
// every 50 Hz as deep as 14.5 dB, and at 100% the whole voice played 20 ms
// behind his picture.
describe('noise reduction lines up with the voice it was given', { timeout: MODEL_TIMEOUT }, () => {
  const { x, voiced } = voiceTake(48_000, 4)
  let wet: Float32Array
  beforeAll(() => {
    wet = denoiseChannel(real, x)
  }, MODEL_TIMEOUT)

  it('the full RNNoise output is not late by a single sample', () => {
    expect(Math.abs(bestLag(x, wet, 48_000, 48_000))).toBeLessThanOrEqual(1)
  })

  it('so a half and half blend is flat across the voice, not a comb', () => {
    const r = voiceBandRatioDb(x, mixDryWet(x, wet, 0.5), voiced, 48_000)
    expect(r.min).toBeGreaterThan(-1)
    expect(r.max).toBeLessThan(1)
  })
})

// ⛔ MIC-2, 2026-09-30. At 100% the model gated his room tone to digital
// silence between words: -56.5 dBFS dry, -118.4 dBFS wet on his 89 s take, the
// room vanishing in every pause and coming back under every word. The strongest
// setting now leaves a natural floor 18 dB under the room, and the voice itself
// is not touched.
describe('the strongest setting keeps a natural room floor', { timeout: MODEL_TIMEOUT }, () => {
  const { x, voiced, pauses } = voiceTake(48_000, 4)
  // One asset id for both strengths: the model runs once, the mix twice.
  const at = (s: number) => denoisedBufferFor(asset('take-48k'), fakeBuffer([x], 48_000), s, makeBuffer)

  it('100% sits about 18 dB under the dry room tone, with the voice at unity', async () => {
    const y = (await at(1))!.getChannelData(0)
    expect(windowsDb(y, pauses, 960) - windowsDb(x, pauses, 960)).toBeCloseTo(-18, 0)
    expect(Math.abs(windowsDb(y, voiced, 960) - windowsDb(x, voiced, 960))).toBeLessThan(0.5)
  })

  it('the Inspector % still means more or less: 50% takes 9 dB off, and stays comb free', async () => {
    const y = (await at(0.5))!.getChannelData(0)
    expect(windowsDb(y, pauses, 960) - windowsDb(x, pauses, 960)).toBeCloseTo(-9, 0)
    const r = voiceBandRatioDb(x, y, voiced, 48_000)
    expect(r.min).toBeGreaterThan(-1)
    expect(r.max).toBeLessThan(1)
  })
})

describe('wetShareFor: the strength as decibels off the room', () => {
  it('0 is no wet at all, so strength 0 stays byte identical to the take', () => {
    expect(wetShareFor(0)).toBe(0)
  })

  it('is even in decibels: 50% is 9 dB, 100% is 18 dB and no more', () => {
    const floorDb = (s: number) => 20 * Math.log10(1 - wetShareFor(s))
    expect(floorDb(0.5)).toBeCloseTo(-9, 6)
    expect(floorDb(1)).toBeCloseTo(-MAX_REDUCTION_DB, 6)
    expect(floorDb(2)).toBeCloseTo(-MAX_REDUCTION_DB, 6) // clamped, never past the cap
  })
})

// ⛔ MIC-6, 2026-09-30. A lossless take keeps the mic's OWN rate (the backtest's
// device ran at 44.1 kHz), and RNNoise is a 48 kHz model: fed 44.1 kHz it hears
// every voice 9% low and every frame 9% long. The take goes up to 48 kHz for the
// model and back, and has to come back lined up and floored the same.
describe('a 44.1 kHz take is cleaned at 48 kHz and comes back lined up', { timeout: MODEL_TIMEOUT }, () => {
  const { x, voiced, pauses } = voiceTake(44_100, 4)
  let y: Float32Array
  let rate = 0
  beforeAll(async () => {
    const out = (await denoisedBufferFor(asset('take-44k'), fakeBuffer([x], 44_100), 1, makeBuffer))!
    y = out.getChannelData(0)
    rate = out.sampleRate
  }, MODEL_TIMEOUT)

  it('comes back at its own rate and length, not a sample of drift', () => {
    expect(rate).toBe(44_100)
    expect(y.length).toBe(x.length)
  })

  it('is not late: the 100% mix is mostly model, so a late model would pull this to 882', () => {
    expect(Math.abs(bestLag(x, y, 44_100, 44_100))).toBeLessThanOrEqual(1)
  })

  it('keeps the same floor and the voice at unity', () => {
    expect(windowsDb(y, pauses, 882) - windowsDb(x, pauses, 882)).toBeCloseTo(-18, 0)
    expect(Math.abs(windowsDb(y, voiced, 882) - windowsDb(x, voiced, 882))).toBeLessThan(0.5)
  })

  it('and blends with the dry take without a comb', () => {
    // Undo the fixed dry share to get the model's own output back, then blend it
    // half and half like the 48 kHz check above.
    const k = 1 - wetShareFor(1)
    const wet = y.map((v, i) => (v - k * x[i]!) / (1 - k))
    const r = voiceBandRatioDb(x, mixDryWet(x, wet, 0.5), voiced, 44_100)
    expect(r.min).toBeGreaterThan(-1)
    expect(r.max).toBeLessThan(1)
  })
})

// ⛔ THE DENOISE CACHES HAVE A CEILING NOW.
//
// They held the full decoded audio of every clip he had ever denoised, twice
// over, and nothing ever dropped them but deleting the asset. Roughly 230 MB per
// ten minute stereo clip, beside a frame cache capped at 512 MB and an audio
// cache capped at 256 MB. His words, 2026-08-24: *"it also somehow takes 99% of
// my fucking RAM"*, then *"the lag sucks tho"*. The app was measured holding
// 3.9 GB with 4 GB free of 32 while he said it.
describe('the denoise caches cannot grow without end', () => {
  const MB = 1024 * 1024
  const sizes: Record<string, number> = { a: 100 * MB, b: 100 * MB, c: 100 * MB, d: 100 * MB }
  const bytesOf = (id: string): number => sizes[id] ?? 0

  it('drops nothing while it is inside the budget', () => {
    expect(denoiseEvictionPlan(['a', 'b'], bytesOf, 200 * MB, 400 * MB, 'b')).toEqual([])
  })

  it('drops the oldest first, and only as many as it takes', () => {
    // 400 MB held against a 250 MB budget: dropping 'a' and 'b' is enough.
    expect(denoiseEvictionPlan(['a', 'b', 'c', 'd'], bytesOf, 400 * MB, 250 * MB, 'd')).toEqual(['a', 'b'])
  })

  it('never evicts the clip it was just asked to keep', () => {
    // 'a' is both the oldest and the one just computed, so 'b' goes instead.
    const plan = denoiseEvictionPlan(['a', 'b', 'c'], bytesOf, 300 * MB, 150 * MB, 'a')
    expect(plan).not.toContain('a')
    expect(plan).toEqual(['b', 'c'])
  })

  it('would empty everything else rather than sit over the budget', () => {
    expect(denoiseEvictionPlan(['a', 'b', 'c'], bytesOf, 300 * MB, 0, 'c')).toEqual(['a', 'b'])
  })
})
