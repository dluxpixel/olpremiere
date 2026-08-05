import { describe, expect, it } from 'vitest'

import {
  SCRUB_GRAIN_INTERVAL_S,
  SCRUB_GRAIN_S,
  scrubVoicesAt,
  shouldFireGrain,
} from './scrubAudio'
import type { Clip, Id, MediaAsset, Sequence, Track } from './types'

const asset = (id: string, durationS = 60): MediaAsset =>
  ({ id, name: `${id}.mp4`, kind: 'video', durationS, width: 1920, height: 1080, hasAudio: true }) as MediaAsset

const clip = (over: Partial<Clip> & { id: string; startS: number }): Clip =>
  ({
    assetId: 'a',
    inS: 0,
    outS: 10,
    speed: 1,
    enabled: true,
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    transform: { crop: {} },
    ...over,
  }) as Clip

const track = (over: Partial<Track> & { id: string; clips: Clip[] }): Track =>
  ({ kind: 'audio', name: 'A1', enabled: true, locked: false, muted: false, volumeDb: 0, ...over }) as Track

const seqOf = (tracks: Track[]): Sequence =>
  ({ id: 's', fps: 30, width: 1920, height: 1080, tracks }) as Sequence

const assets = (list: MediaAsset[]): Record<Id, MediaAsset> =>
  Object.fromEntries(list.map((a) => [a.id, a]))

describe('scrubVoicesAt picks what should sound under the playhead', () => {
  it('sounds the clip the playhead is inside, from the right point in the source', () => {
    const seq = seqOf([track({ id: 't', clips: [clip({ id: 'c', startS: 4, inS: 2, outS: 12 })] })])
    const voices = scrubVoicesAt(seq, assets([asset('a')]), 7)
    expect(voices).toHaveLength(1)
    // 3s into the clip, which started 2s into the source
    expect(voices[0].sourceOffsetS).toBeCloseTo(5, 6)
    expect(voices[0].playbackRate).toBe(1)
  })

  it('says nothing at all in a gap', () => {
    const seq = seqOf([track({ id: 't', clips: [clip({ id: 'c', startS: 10, outS: 5 })] })])
    expect(scrubVoicesAt(seq, assets([asset('a')]), 3)).toEqual([])
  })

  it('does not sound a clip that starts later than the playhead', () => {
    // computeClipSchedule happily returns a FUTURE clip with whenOffsetS > 0.
    // Playback wants that; a scrub grain must not, or dragging into a gap would
    // play whatever comes next.
    const seq = seqOf([track({ id: 't', clips: [clip({ id: 'c', startS: 20, outS: 5 })] })])
    expect(scrubVoicesAt(seq, assets([asset('a')]), 3)).toEqual([])
  })

  it('is silent on a muted track and obeys solo like the mixer does', () => {
    const muted = seqOf([track({ id: 't', muted: true, clips: [clip({ id: 'c', startS: 0 })] })])
    expect(scrubVoicesAt(muted, assets([asset('a')]), 1)).toEqual([])

    const soloed = seqOf([
      track({ id: 't1', clips: [clip({ id: 'c1', startS: 0 })] }),
      track({ id: 't2', solo: true, clips: [clip({ id: 'c2', startS: 0 })] }),
    ])
    const voices = scrubVoicesAt(soloed, assets([asset('a')]), 1)
    expect(voices.map((v) => v.clipId)).toEqual(['c2'])
  })

  it('counts a linked A/V pair once, from the audio side', () => {
    const seq = seqOf([
      track({ id: 'v', kind: 'video', clips: [clip({ id: 'V', startS: 0, linkId: 'lg' })] }),
      track({ id: 'a', kind: 'audio', clips: [clip({ id: 'A', startS: 0, linkId: 'lg' })] }),
    ])
    const voices = scrubVoicesAt(seq, assets([asset('a')]), 1)
    expect(voices.map((v) => v.clipId)).toEqual(['A'])
  })

  it('carries clip gain and track volume, so a quiet take scrubs quiet', () => {
    const seq = seqOf([
      track({ id: 't', volumeDb: -6, clips: [clip({ id: 'c', startS: 0, audioGainDb: -6 })] }),
    ])
    const [voice] = scrubVoicesAt(seq, assets([asset('a')]), 1)
    // -12 dB in total, so about a quarter of full scale
    expect(voice.gain).toBeCloseTo(0.251, 2)
  })

  it('reads a reversed clip forwards off its reversed buffer', () => {
    const seq = seqOf([
      track({ id: 't', clips: [clip({ id: 'c', startS: 0, inS: 0, outS: 10, speed: -1 })] }),
    ])
    const [voice] = scrubVoicesAt(seq, assets([asset('a', 60)]), 2)
    expect(voice.reversed).toBe(true)
    expect(voice.playbackRate).toBe(1) // forward equivalent, so normal pitch
    // in/out mirrored about the 60s source: the clip covers 50..60 reversed
    expect(voice.sourceOffsetS).toBeCloseTo(52, 6)
  })

  it('sounds two stacked tracks together, the way the mix would', () => {
    const seq = seqOf([
      track({ id: 't1', clips: [clip({ id: 'c1', startS: 0 })] }),
      track({ id: 't2', clips: [clip({ id: 'c2', startS: 0, assetId: 'b' })] }),
    ])
    const voices = scrubVoicesAt(seq, assets([asset('a'), asset('b')]), 1)
    expect(voices.map((v) => v.clipId)).toEqual(['c1', 'c2'])
  })

  it('ignores a disabled clip and a clip whose media is gone', () => {
    const seq = seqOf([
      track({ id: 't', clips: [clip({ id: 'off', startS: 0, enabled: false })] }),
      track({ id: 't2', clips: [clip({ id: 'gone', startS: 0, assetId: 'missing' })] }),
    ])
    expect(scrubVoicesAt(seq, assets([asset('a')]), 1)).toEqual([])
  })
})

describe('shouldFireGrain throttles the drag without making it feel dead', () => {
  it('always fires the first grain', () => {
    expect(shouldFireGrain(0, null, null, 5)).toBe(true)
  })

  it('refuses a second grain inside the interval', () => {
    expect(shouldFireGrain(0.02, 0, 5, 5.01)).toBe(false)
  })

  it('fires again once the interval has passed', () => {
    expect(shouldFireGrain(SCRUB_GRAIN_INTERVAL_S, 0, 5, 5.01)).toBe(true)
  })

  it('fires immediately on a JUMP, so a click somewhere else is heard at once', () => {
    // Same instant, throttle not expired, but the playhead moved further than a
    // grain is long. That is a click, not a drag.
    expect(shouldFireGrain(0.001, 0, 5, 5 + SCRUB_GRAIN_S + 0.01)).toBe(true)
    expect(shouldFireGrain(0.001, 0, 5, 5 - SCRUB_GRAIN_S - 0.01)).toBe(true)
  })

  it('grains are longer than the gap between them, so they overlap', () => {
    // This is what makes a scrub sound continuous instead of like a machine gun.
    expect(SCRUB_GRAIN_S).toBeGreaterThan(SCRUB_GRAIN_INTERVAL_S)
  })
})
