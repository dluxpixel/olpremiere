import { describe, expect, it } from 'vitest'
import { dbToGain } from '../audio'
import { DUCK_DB } from '../ducking'
import { defaultTransform, newTrack, type Clip, type Track } from '../types'
import { mixToStereo, type MixSourcePcm } from './audioMix'

const SR = 8000
const DUCK = dbToGain(DUCK_DB)

function clip(patch: Partial<Clip>): Clip {
  return {
    id: 'c' + Math.abs(JSON.stringify(patch).length),
    assetId: 'a',
    startS: 0,
    inS: 0,
    outS: 1,
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    ...patch,
  }
}

const constMono = (frames: number, value: number): Float32Array[] => [
  new Float32Array(frames).fill(value),
]

function musicSource(track: Track): MixSourcePcm {
  return {
    clip: clip({ id: 'music', startS: 0, inS: 0, outS: 10 }),
    track,
    channelData: constMono(SR * 10, 0.1),
    sampleRate: SR,
  }
}

function voiceSource(track: Track): MixSourcePcm {
  return {
    clip: clip({ id: 'vo', startS: 2, inS: 0, outS: 3 }),
    track,
    channelData: constMono(SR * 3, 0),
    sampleRate: SR,
  }
}

const at = (buf: Float32Array, tS: number): number => Math.abs(buf[Math.round(tS * SR)])

describe('mixToStereo ducking', () => {
  const opts = { startS: 0, endS: 10, sampleRate: SR, soloActive: false }

  it('drops music by DUCK_DB under the voice window and recovers after', () => {
    const music = { ...newTrack('audio', 'M'), audioRole: 'music' as const }
    const voice = { ...newTrack('audio', 'V'), audioRole: 'voice' as const }
    music.clips = [clip({ id: 'music', startS: 0, inS: 0, outS: 10 })]
    voice.clips = [clip({ id: 'vo', startS: 2, inS: 0, outS: 3 })]

    const [L] = mixToStereo([musicSource(music), voiceSource(voice)], opts)
    const plain = at(L, 1) // before the attack starts (2 - 0.15)
    const ducked = at(L, 3.5) // mid-voice
    const recovered = at(L, 8) // well after release (5 + 0.35)

    expect(plain).toBeGreaterThan(0)
    expect(ducked / plain).toBeCloseTo(DUCK, 3)
    expect(recovered / plain).toBeCloseTo(1, 3)
  })

  it('leaves role-less tracks untouched by the same voice', () => {
    const plainTrack = newTrack('audio', 'M')
    const voice = { ...newTrack('audio', 'V'), audioRole: 'voice' as const }
    plainTrack.clips = [clip({ id: 'music', startS: 0, inS: 0, outS: 10 })]
    voice.clips = [clip({ id: 'vo', startS: 2, inS: 0, outS: 3 })]

    const [L] = mixToStereo([musicSource(plainTrack), voiceSource(voice)], opts)
    expect(at(L, 3.5) / at(L, 1)).toBeCloseTo(1, 4)
  })

  it('a muted voice track does not duck anyone', () => {
    const music = { ...newTrack('audio', 'M'), audioRole: 'music' as const }
    const voice = { ...newTrack('audio', 'V'), audioRole: 'voice' as const, muted: true }
    music.clips = [clip({ id: 'music', startS: 0, inS: 0, outS: 10 })]
    voice.clips = [clip({ id: 'vo', startS: 2, inS: 0, outS: 3 })]

    const [L] = mixToStereo([musicSource(music)], opts)
    expect(at(L, 3.5) / at(L, 1)).toBeCloseTo(1, 4)
  })

  it('stays byte-deterministic with ducking active', () => {
    const build = () => {
      const music = { ...newTrack('audio', 'M'), audioRole: 'music' as const }
      const voice = { ...newTrack('audio', 'V'), audioRole: 'voice' as const }
      music.clips = [clip({ id: 'music', startS: 0, inS: 0, outS: 10 })]
      voice.clips = [clip({ id: 'vo', startS: 2, inS: 0, outS: 3 })]
      return mixToStereo([musicSource(music), voiceSource(voice)], opts)
    }
    const a = build()
    const b = build()
    expect(a[0]).toEqual(b[0])
    expect(a[1]).toEqual(b[1])
  })
})
