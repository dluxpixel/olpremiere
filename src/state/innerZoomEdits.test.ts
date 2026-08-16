// The one number he sets, and the four crop channels it writes underneath.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cropForZoom } from '../engine/innerZoom'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import {
  addInnerZoomKeyframeAtPlayhead,
  innerZoomAt,
  innerZoomKeyframes,
  innerZoomOwnsCrop,
  isInnerZoomAnimated,
  removeInnerZoomKeyframeAtPlayhead,
  setChannel,
  setInnerZoomAtPlayhead,
  toggleInnerZoomAnimation,
} from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

function seedClip(): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), 0, 6)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

const crops = (id: string) => {
  const c = clipById(id).transform.crop
  return [c.t, c.r, c.b, c.l]
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('setInnerZoomAtPlayhead', () => {
  it('writes all four crops evenly, in ONE undo step', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 2)

    expect(crops(clip.id)).toEqual([0.25, 0.25, 0.25, 0.25])
    // One press puts it all back: four separate edits would need four.
    useStore.getState().undo()
    expect(crops(clip.id)).toEqual([0, 0, 0, 0])
  })

  it('reads back the zoom he set', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 1.6)
    expect(innerZoomAt(clipById(clip.id), 0)).toBeCloseTo(1.6, 6)
  })

  it('resets to untouched at 1', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 2.5)
    setInnerZoomAtPlayhead(clip.id, 1)
    expect(crops(clip.id)).toEqual([0, 0, 0, 0])
  })

  it('leaves scale alone, which is the whole difference from a zoom', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 2)
    expect(clipById(clip.id).transform.scale).toBe(1)
  })
})

describe('keyframing the zoom', () => {
  it('animates all four together and reports it once', () => {
    const clip = seedClip()
    expect(isInnerZoomAnimated(clipById(clip.id))).toBe(false)

    toggleInnerZoomAnimation(clip.id)

    expect(isInnerZoomAnimated(clipById(clip.id))).toBe(true)
    expect(innerZoomKeyframes(clipById(clip.id))).toHaveLength(1)
    const kfs = clipById(clip.id).keyframes ?? {}
    for (const ch of ['cropT', 'cropR', 'cropB', 'cropL'] as const) {
      expect(kfs[ch] ?? []).toHaveLength(1)
    }
  })

  it('holds the zoom that is on screen when the animation is switched off', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 2)
    toggleInnerZoomAnimation(clip.id)
    useStore.getState().setUI({ playheadS: 3 })
    setInnerZoomAtPlayhead(clip.id, 3)

    // Off at the 3x moment: the picture must not jump back to 2x.
    toggleInnerZoomAnimation(clip.id)
    expect(isInnerZoomAnimated(clipById(clip.id))).toBe(false)
    expect(innerZoomAt(clipById(clip.id), 3)).toBeCloseTo(3, 4)
  })

  it('adds and removes a moment across all four at once', () => {
    const clip = seedClip()
    toggleInnerZoomAnimation(clip.id)
    useStore.getState().setUI({ playheadS: 2 })

    addInnerZoomKeyframeAtPlayhead(clip.id)
    expect(innerZoomKeyframes(clipById(clip.id))).toHaveLength(2)
    expect((clipById(clip.id).keyframes ?? {})['cropL'] ?? []).toHaveLength(2)

    removeInnerZoomKeyframeAtPlayhead(clip.id)
    expect(innerZoomKeyframes(clipById(clip.id))).toHaveLength(1)
    expect((clipById(clip.id).keyframes ?? {})['cropL'] ?? []).toHaveLength(1)
  })

  it('rides the ramp between two moments', () => {
    const clip = seedClip()
    setInnerZoomAtPlayhead(clip.id, 1)
    toggleInnerZoomAnimation(clip.id)
    useStore.getState().setUI({ playheadS: 4 })
    setInnerZoomAtPlayhead(clip.id, 2)

    const mid = innerZoomAt(clipById(clip.id), 2)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(2)
  })
})

describe('a crop he set one edge at a time', () => {
  it('is not claimed by the zoom row', () => {
    const clip = seedClip()
    setChannel(clip.id, 'cropT', 0.3)
    expect(innerZoomOwnsCrop(clipById(clip.id), 0)).toBe(false)
  })

  it('is evened up again the moment he uses the zoom', () => {
    const clip = seedClip()
    setChannel(clip.id, 'cropT', 0.3)
    setInnerZoomAtPlayhead(clip.id, 1.5)
    expect(innerZoomOwnsCrop(clipById(clip.id), 0)).toBe(true)
    expect(crops(clip.id)).toEqual(Array(4).fill(cropForZoom(1.5)))
  })
})
