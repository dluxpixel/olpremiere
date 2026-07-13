import { describe, expect, it } from 'vitest'
import { dbToGain } from './audio'
import {
  DUCK_ATTACK_S,
  DUCK_DB,
  DUCK_RELEASE_S,
  duckEnvelope,
  duckingActive,
  voiceWindows,
} from './ducking'
import { newTitleClip, defaultTitleDef, newTrack, newSequence, type Clip, type Track } from './types'

const DUCK = dbToGain(DUCK_DB)

/** An enabled clip occupying [startS, startS+durS) — content type is irrelevant here. */
function clipAt(startS: number, durS: number, patch: Partial<Clip> = {}): Clip {
  return { ...newTitleClip(defaultTitleDef('x'), startS, durS), ...patch }
}

function voiceTrack(clips: Clip[], patch: Partial<Track> = {}): Track {
  return { ...newTrack('audio', 'VO'), audioRole: 'voice', clips, ...patch }
}

/** Linear interpolation through the envelope, mirroring the consumers. */
function envAt(points: { offsetS: number; value: number }[], t: number): number {
  if (t <= points[0].offsetS) return points[0].value
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].offsetS) {
      const a = points[i - 1]
      const b = points[i]
      const f = (t - a.offsetS) / (b.offsetS - a.offsetS)
      return a.value + (b.value - a.value) * f
    }
  }
  return points[points.length - 1].value
}

describe('voiceWindows', () => {
  it('collects enabled clips on audible voice tracks only', () => {
    const tracks = [
      voiceTrack([clipAt(1, 2)]),
      voiceTrack([clipAt(10, 1)], { muted: true }),
      { ...newTrack('audio', 'A2'), clips: [clipAt(20, 1)] }, // no role
    ]
    expect(voiceWindows(tracks, false)).toEqual([{ startS: 1, endS: 3 }])
  })

  it('solo wins: an unsoloed voice track stops driving the duck', () => {
    const tracks = [voiceTrack([clipAt(1, 2)]), { ...newTrack('audio', 'A2'), solo: true, clips: [] }]
    expect(voiceWindows(tracks, true)).toEqual([])
  })

  it('merges windows whose ramps would touch (no pumping through breaths)', () => {
    const t = voiceTrack([clipAt(0, 2), clipAt(2.3, 1)]) // 0.3s breath < attack+release
    expect(voiceWindows([t], false)).toEqual([{ startS: 0, endS: 3.3 }])
  })

  it('keeps genuinely separate windows apart', () => {
    const t = voiceTrack([clipAt(0, 1), clipAt(5, 1)])
    expect(voiceWindows([t], false)).toHaveLength(2)
  })

  it('ignores disabled clips and respects speed', () => {
    const t = voiceTrack([clipAt(0, 2, { enabled: false }), clipAt(4, 2, { speed: 2 })])
    expect(voiceWindows([t], false)).toEqual([{ startS: 4, endS: 5 }])
  })
})

describe('duckEnvelope', () => {
  it('returns null when nothing speaks', () => {
    expect(duckEnvelope([voiceTrack([])], false, 0)).toBeNull()
    expect(duckEnvelope([{ ...newTrack('audio', 'M'), audioRole: 'music', clips: [clipAt(0, 5)] }], false, 0)).toBeNull()
  })

  it('rides down before the voice and back up after it', () => {
    const env = duckEnvelope([voiceTrack([clipAt(2, 3)])], false, 0)!
    expect(env[0]).toEqual({ offsetS: 0, value: 1 })
    expect(envAt(env, 2 - DUCK_ATTACK_S)).toBeCloseTo(1, 6)
    expect(envAt(env, 2)).toBeCloseTo(DUCK, 6)
    expect(envAt(env, 3.5)).toBeCloseTo(DUCK, 6)
    expect(envAt(env, 5)).toBeCloseTo(DUCK, 6)
    expect(envAt(env, 5 + DUCK_RELEASE_S)).toBeCloseTo(1, 6)
    expect(envAt(env, 7)).toBeCloseTo(1, 6)
  })

  it('starts mid-duck when the render range begins inside the voice', () => {
    const env = duckEnvelope([voiceTrack([clipAt(2, 3)])], false, 3)!
    expect(env[0].offsetS).toBe(0)
    expect(env[0].value).toBeCloseTo(DUCK, 6)
    // knots that fell before fromS are folded into the offset-0 point
    for (const p of env) expect(p.offsetS).toBeGreaterThanOrEqual(0)
    // points stay time-ordered for the WebAudio ramps
    for (let i = 1; i < env.length; i++) expect(env[i].offsetS).toBeGreaterThan(env[i - 1].offsetS)
  })

  it('is identical for every consumer offset convention (pure + deterministic)', () => {
    const tracks = [voiceTrack([clipAt(1, 2), clipAt(6, 1)])]
    expect(duckEnvelope(tracks, false, 0)).toEqual(duckEnvelope(tracks, false, 0))
  })
})

describe('duckingActive', () => {
  it('needs both an audible music track and a voice window', () => {
    const seq = newSequence()
    expect(duckingActive(seq)).toBe(false)
    const withRoles = {
      ...seq,
      tracks: seq.tracks.map((t, i) =>
        t.kind === 'audio'
          ? i % 2 === 0
            ? { ...t, audioRole: 'music' as const }
            : { ...t, audioRole: 'voice' as const, clips: [clipAt(0, 1)] }
          : t,
      ),
    }
    expect(duckingActive(withRoles)).toBe(true)
  })
})
