// A caption's pop (or fade) OWNS its scale and opacity keyframes: they are
// compiled from the spec and the base. Every number door writes the BASE and
// lets the animation follow.
//
// MEASURED 2026-10-06: two 0.4 s captions with Pop, the playhead between them,
// Scale 1.2 for both. The one before the playhead grew AFTER its pop, the one
// after it shrank in from 1.2, and the base stayed 1.0, so neither got bigger.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ shown: [] as string[] }))
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => toasts.shown.push(m) }) },
}))

import { buildAppearanceKeyframes, retimeAppearance } from '../engine/anim/appearance'
import { channelKeyframes } from '../engine/effects/channels'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { setClipsAppearance } from './appearanceActions'
import { setChannelForClips } from './bulkEdits'
import {
  OWNED_BY_ANIMATION,
  resetChannel,
  setChannel,
  toggleChannelAnimation,
  toggleMotionAtPlayhead,
} from './clipEdits'
import { updateActiveSequence, useStore } from './store'

const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** Two 0.4 s captions on V1, at 0 and 1 s, the playhead parked between them. */
function twoCaptions(spec: { in: string; durS: number }): [string, string] {
  useStore.getState().setProject(newProject())
  const a = newTitleClip(defaultTitleDef('a'), 0, 0.4)
  const b = newTitleClip(defaultTitleDef('b'), 1, 0.4)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [a, b] } : t)) }),
  )
  setClipsAppearance([a.id, b.id], spec)
  useStore.getState().setUI({ playheadS: 0.7, selection: [] })
  toasts.shown.length = 0
  return [a.id, b.id]
}

/** What the spec compiles to on this clip at its current base: the clip still matches its animation. */
function compiled(c: Clip, channel: 'scale' | 'opacity') {
  const s = seq()
  return buildAppearanceKeyframes(c.appearance!, 0.4, s.width, s.height, {
    opacity: c.opacity,
    scale: c.transform.scale,
    posX: c.transform.x,
    posY: c.transform.y,
    rotation: c.transform.rotationDeg,
  })[channel]
}

beforeEach(() => {
  toasts.shown.length = 0
})

describe('a number typed on a caption whose animation owns the channel', () => {
  it('multi Scale makes every popping caption bigger and keeps the pop', () => {
    const ids = twoCaptions({ in: 'pop', durS: 0.1 })
    setChannelForClips(ids, 'scale', 1.2)
    for (const id of ids) {
      const c = clipById(id)
      expect(c.transform.scale).toBe(1.2)
      expect(c.appearance?.in).toBe('pop')
      expect(channelKeyframes(c, 'scale')).toEqual(compiled(c, 'scale'))
      // Rests at the new size: the last keyframe is the base.
      expect(channelKeyframes(c, 'scale').at(-1)!.value).toBeCloseTo(1.2, 9)
    }
  })

  it('a later trim still moves the animation with the clip', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    setChannelForClips([a], 'scale', 1.2)
    const c = clipById(a)
    const s = seq()
    const trimmed = { ...c, outS: c.outS + 1 }
    expect(retimeAppearance(c, trimmed, s.width, s.height)).not.toBe(trimmed)
  })

  it('the single clip Opacity field on a Fade in sets where it rests', () => {
    const [a] = twoCaptions({ in: 'fadeIn', durS: 0.1 })
    setChannel(a, 'opacity', 0.5)
    const c = clipById(a)
    expect(c.opacity).toBe(0.5)
    expect(c.appearance?.in).toBe('fadeIn')
    expect(channelKeyframes(c, 'opacity')).toEqual(compiled(c, 'opacity'))
  })

  it('Reset puts the base back and keeps the pop', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    setChannel(a, 'scale', 1.5)
    resetChannel(a, 'scale')
    const c = clipById(a)
    expect(c.transform.scale).toBe(1)
    expect(channelKeyframes(c, 'scale')).toEqual(compiled(c, 'scale'))
  })

  it('the stopwatch and the D key refuse out loud instead of breaking the pop', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    const before = clipById(a)
    toggleChannelAnimation(a, 'scale')
    useStore.getState().setUI({ playheadS: 0.2 })
    toggleMotionAtPlayhead(a)
    expect(clipById(a)).toBe(before)
    expect(toasts.shown).toEqual([OWNED_BY_ANIMATION, OWNED_BY_ANIMATION])
  })
})
