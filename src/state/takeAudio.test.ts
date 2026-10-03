import { describe, expect, it } from 'vitest'

import { CLIP_AMP, CLIP_DBFS, channelPlan, monoWavF32, peakOf } from './takeAudio'

// What a finished take is checked for before he reviews it: did it clip
// (MIC-3), and is it one voice on both sides (MIC-7).

const voice = (n: number, seed = 1) => {
  let s = seed
  return Float32Array.from({ length: n }, (_, i) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return 0.3 * Math.sin(i * 0.05) + 0.01 * ((s / 4294967296) * 2 - 1)
  })
}

describe('the clip line', () => {
  it('sits at -1 dBFS', () => {
    expect(CLIP_DBFS).toBe(-1)
    expect(20 * Math.log10(CLIP_AMP)).toBeCloseTo(-1, 9)
  })

  it('the peak is the loudest sample on either side, either sign', () => {
    expect(peakOf([Float32Array.from([0.1, -0.95]), Float32Array.from([0.5])])).toBeCloseTo(0.95, 6)
  })
})

describe('channelPlan: one voice twice is stored once', () => {
  it('his takes, the same voice both sides to -60 dB: mono, channel 0', () => {
    const l = voice(48_000)
    // The two sides differ by -65 dB, like his real takes (-60 to -69).
    const r = l.map((v, i) => v + 0.3 * 10 ** (-65 / 20) * Math.sin(i * 1.7))
    expect(channelPlan([l, r])).toEqual({ keep: 'mono', channel: 0, why: 'dual-mono' })
  })

  it('a mic on input 2 of an interface, input 1 empty: keeps the side with the voice', () => {
    const r = voice(48_000)
    const l = voice(48_000, 7).map((v) => v * 10 ** (-45 / 20))
    expect(channelPlan([l, r])).toEqual({ keep: 'mono', channel: 1, why: 'one-side' })
  })

  it('real stereo is kept as it came', () => {
    const l = voice(48_000, 3)
    const r = voice(48_000, 9).map((v, i) => v * Math.cos(i * 0.001))
    expect(channelPlan([l, r])).toEqual({ keep: 'as-is' })
  })

  it('a mono take, or anything that is not two channels, is left alone', () => {
    expect(channelPlan([voice(100)])).toEqual({ keep: 'as-is' })
  })
})

describe('monoWavF32: the samples exactly as captured', () => {
  it('writes a 32-bit float mono WAV whose data is the channel, bit for bit', async () => {
    const x = Float32Array.from([0, 0.5, -0.25, 1.5, -1e-7])
    const wav = monoWavF32(x, 44_100)
    expect(wav.type).toBe('audio/wav')
    const buf = await wav.arrayBuffer()
    const dv = new DataView(buf)
    const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4))
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(dv.getUint16(20, true)).toBe(3) // IEEE float
    expect(dv.getUint16(22, true)).toBe(1) // one channel
    expect(dv.getUint32(24, true)).toBe(44_100)
    expect(dv.getUint16(34, true)).toBe(32)
    expect(dv.getUint32(40, true)).toBe(x.length * 4)
    expect(Array.from(new Float32Array(buf, 44))).toEqual(Array.from(x))
  })
})
