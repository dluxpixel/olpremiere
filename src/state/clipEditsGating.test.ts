import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { applyEffect } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = () => activeSequence(useStore.getState().project)

/** newProject() seeds tracks [V1, V2, A1, A2] — indices 0,1 are video, 2,3 audio. */
function seedClipOnTrack(trackIndex: number, asset: MediaAsset): Clip {
  const clip = newClipFromAsset(asset, 0)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

const videoAsset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const audioAsset: MediaAsset = { id: 'a', name: 'a', kind: 'audio', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: false }

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('applyEffect — clip-kind gating', () => {
  it('applies an effect to a clip on a video track', () => {
    const clip = seedClipOnTrack(0, videoAsset) // V1
    applyEffect(clip.id, 'gaussianBlur')
    expect(seq().tracks[0].clips[0].effects.map((e) => e.type)).toContain('gaussianBlur')
  })

  it('refuses an effect on a clip on an audio track (would render nothing)', () => {
    const clip = seedClipOnTrack(2, audioAsset) // A1
    applyEffect(clip.id, 'gaussianBlur')
    expect(seq().tracks[2].clips[0].effects).toEqual([])
  })
})

describe('one-click green screen (chroma key)', () => {
  it('applying the chroma-key effect keys GREEN at a working strength', () => {
    const clip = seedClipOnTrack(0, videoAsset) // V1
    applyEffect(clip.id, 'chromaKey')
    const fx = seq().tracks[0].clips[0].effects.find((e) => e.type === 'chromaKey')
    expect(fx).toBeTruthy()
    const p = fx!.params as Record<string, number>
    expect(p.keyG).toBe(1) // green keyed by default
    expect(p.keyR).toBe(0)
    expect(p.keyB).toBe(0)
    expect(p.similarity).toBeGreaterThan(0) // active on drop, not identity
  })
})
