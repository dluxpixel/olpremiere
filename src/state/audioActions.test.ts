// Levelling reads the clip's own seconds, never the whole file.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gainForTarget, measureLoudness, TARGET_LUFS } from '../engine/loudness'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newProject, type Clip, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

const { getAudioRange, show } = vi.hoisted(() => ({ getAudioRange: vi.fn(), show: vi.fn() }))
vi.mock('../engine/audio', () => ({ getAudioRange }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const RATE = 8000
/** 20 s: a quiet room, with him talking loud from 12 s to 18 s. */
const whole = Float32Array.from({ length: 20 * RATE }, (_, i) =>
  i >= 12 * RATE && i < 18 * RATE ? 0.5 * Math.sin(i / 4) : 0.01 * Math.sin(i / 3),
)
const buffer = (data: Float32Array) =>
  ({ numberOfChannels: 1, sampleRate: RATE, length: data.length, getChannelData: () => data }) as unknown as AudioBuffer

const ASSET = { id: 'a1', name: 'take.wav', kind: 'audio', hasAudio: true, durationS: 20 } as MediaAsset

function seed(clips: Partial<Clip>[]): void {
  useStore.getState().setProject({ ...newProject(), assets: { a1: ASSET } })
  const base: Clip = {
    id: 'c1',
    assetId: 'a1',
    startS: 0,
    inS: 12,
    outS: 18,
    speed: 1,
    enabled: true,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, crop: { t: 0, r: 0, b: 0, l: 0 } },
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
  }
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t) => (t.kind === 'audio' && t.name === 'A1' ? { ...t, clips: clips.map((c) => ({ ...base, ...c })) } : t)),
    }),
  )
}

const gainOf = (id: string) =>
  activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!.audioGainDb

beforeEach(() => {
  show.mockClear()
  getAudioRange.mockReset()
  // What the ranged read hands back: 10 s to 20 s of the file.
  getAudioRange.mockResolvedValue({ buffer: buffer(whole.subarray(10 * RATE)), startS: 10 })
})

describe('normalizeClipGain', () => {
  // ⛔ AU-5. It decoded the whole file, bigger than the whole audio budget for
  // one of his 30 minute recordings, to measure six seconds of it.
  it('measures exactly the clip seconds out of a ranged read', async () => {
    const { normalizeClipGain } = await import('./audioActions')
    seed([{}])
    await normalizeClipGain('c1')
    expect(getAudioRange).toHaveBeenCalledWith(ASSET, 12, 18)
    const want = gainForTarget(measureLoudness([whole], RATE, 12, 18), TARGET_LUFS)!
    expect(gainOf('c1')).toBeCloseTo(want, 6)
  })
})
