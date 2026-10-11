// The strobe's beats, end to end on the main thread: a click track decoded by the
// (stood-in) audio reader comes out as sequence seconds on `beatGridS`, mapped
// through the music clip's start, in point and speed. And a music file that was
// missing and is put back is detected again, not remembered as beatless.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type MediaAsset, type Sequence } from './types'

const h = vi.hoisted(() => ({ range: null as unknown, calls: 0 }))
vi.mock('./audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audio')>()),
  getAudioRange: () => {
    h.calls++
    return Promise.resolve(h.range)
  },
}))

const { sequenceWithBeats, clearBeatGridCache } = await import('./beatGrid')
const { forgetAssetSound } = await import('./assetSound')

const RATE = 8000

/** Six seconds of silence with a loud, short click at each of `at` (seconds). */
function clickTrack(at: number[], seconds = 6) {
  const data = new Float32Array(RATE * seconds)
  for (const t of at) {
    const s = Math.round(t * RATE)
    for (let i = 0; i < 160; i++) data[s + i] = (i % 2 ? 1 : -1) * (1 - i / 160)
  }
  return { numberOfChannels: 1, sampleRate: RATE, length: data.length, getChannelData: () => data }
}

const asset = { id: 'm1', name: 'beat.wav', kind: 'audio', blobKey: 'asset/m1', hasAudio: true, durationS: 6 } as MediaAsset
const assets = { m1: asset } as Record<string, MediaAsset>

function strobeSequence(music: Partial<Clip>): Sequence {
  const seq = activeSequence(newProject('t'))
  seq.tracks[0].clips = [
    { id: 'v1', assetId: 'v', startS: 0, inS: 0, outS: 20, speed: 1, enabled: true, effects: [{ id: 'e1', type: 'strobe', enabled: true, params: {} }] },
  ] as unknown as Clip[]
  seq.tracks.push({
    id: 'a-music',
    kind: 'audio',
    audioRole: 'music',
    muted: false,
    clips: [{ id: 'm', assetId: 'm1', enabled: true, ...music }],
  } as unknown as Sequence['tracks'][number])
  return seq
}

beforeEach(() => {
  clearBeatGridCache()
  h.calls = 0
  // Clicks 1 s apart, at 1.5, 2.5, 3.5, 4.5 s of the file.
  h.range = { buffer: clickTrack([1.5, 2.5, 3.5, 4.5]), startS: 0 }
})

describe('the music clip maps the beats onto the sequence', () => {
  it('lands on sequence.beatGridS through startS, inS and speed', async () => {
    // Source seconds 1..5 hold the clicks at 1.5, 2.5, 3.5, 4.5, i.e. 0.5, 1.5, 2.5, 3.5
    // into the clip. At double speed they come twice as often, from the clip's start at 10 s.
    const seq = strobeSequence({ startS: 10, inS: 1, outS: 5, speed: 2 })
    const out = await sequenceWithBeats(seq, assets)
    const grid = out.beatGridS!
    expect(grid).toHaveLength(4)
    const want = [10.25, 10.75, 11.25, 11.75]
    grid.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThan(0.06))
    // A copy: the project's own sequence is never written to.
    expect(seq.beatGridS).toBeUndefined()
  })
})

describe('music put back after a missing read', () => {
  it('forgetAssetSound lets the next export detect again', async () => {
    const seq = strobeSequence({ startS: 0, inS: 0, outS: 6, speed: 1 })
    h.range = null
    expect((await sequenceWithBeats(seq, assets)).beatGridS).toBeUndefined()
    // The file comes back; without a forget, the cached nothing still answers.
    h.range = { buffer: clickTrack([1.5, 2.5, 3.5]), startS: 0 }
    expect((await sequenceWithBeats(seq, assets)).beatGridS).toBeUndefined()
    forgetAssetSound('m1')
    const out = await sequenceWithBeats(seq, assets)
    expect(out.beatGridS?.length).toBe(3)
  })
})
