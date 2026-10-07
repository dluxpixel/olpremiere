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
import { channelKeyframes, withChannelKeyframes } from '../engine/effects/channels'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { setClipsAppearance } from './appearanceActions'
import { setChannelForClips } from './bulkEdits'
import {
  isAppearanceOwned,
  KEYFRAMES_ARE_YOURS,
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

})

// Review, 2026-10-07: owning all five channels whenever a clip had an animation
// wiped a slide he had keyed by hand the moment he typed an Opacity, and took
// the stopwatch and D off every caption that pops.
describe('a caption he has keyed by hand is his, channel by channel', () => {
  /** A Fade in caption with a Position X slide keyed by hand on top. */
  function fadeWithSlide(): string {
    const [a] = twoCaptions({ in: 'fadeIn', durS: 0.1 })
    updateActiveSequence('hand slide', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === a ? withChannelKeyframes(c, 'posX', [{ t: 0, value: -200, ease: 'linear' }, { t: 0.3, value: 0, ease: 'linear' }]) : c,
        ),
      })),
    }))
    return a
  }
  const slide = (id: string) => channelKeyframes(clipById(id), 'posX').map((k) => [k.t, k.value])

  it('typing Opacity leaves his slide alone and keys the opacity at the playhead', () => {
    const a = fadeWithSlide()
    const before = slide(a)
    useStore.getState().setUI({ playheadS: 0.2 })
    setChannel(a, 'opacity', 0.8)
    expect(slide(a)).toEqual(before)
    expect(channelKeyframes(clipById(a), 'opacity').some((k) => Math.abs(k.t - 0.2) < 1e-6 && k.value === 0.8)).toBe(true)
  })

  it('the multi Opacity field and Reset leave his slide alone too', () => {
    const a = fadeWithSlide()
    const before = slide(a)
    setChannelForClips([a], 'opacity', 0.8)
    expect(slide(a)).toEqual(before)
    resetChannel(a, 'opacity')
    expect(slide(a)).toEqual(before)
  })
})

describe('the stopwatch and D on a clip whose animation owns its keyframes', () => {
  it('the Scale stopwatch on a popping caption hands him the pop as it is', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    const pop = channelKeyframes(clipById(a), 'scale')
    toggleChannelAnimation(a, 'scale')
    const c = clipById(a)
    expect(c.appearance).toBeUndefined()
    expect(channelKeyframes(c, 'scale')).toEqual(pop)
    expect(toasts.shown).toEqual([KEYFRAMES_ARE_YOURS])
  })

  it('the Position stopwatch starts a move and keeps the pop', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    const pop = channelKeyframes(clipById(a), 'scale')
    useStore.getState().setUI({ playheadS: 0.2 })
    toggleChannelAnimation(a, 'posX')
    const c = clipById(a)
    expect(channelKeyframes(c, 'posX').map((k) => k.t)).toEqual([0.2])
    expect(channelKeyframes(c, 'scale')).toEqual(pop)
    expect(c.appearance).toBeUndefined()
  })

  it('D keys the framing at the playhead and keeps the pop', () => {
    const [a] = twoCaptions({ in: 'pop', durS: 0.1 })
    useStore.getState().setUI({ playheadS: 0.25 })
    toggleMotionAtPlayhead(a)
    const c = clipById(a)
    expect(channelKeyframes(c, 'posX').some((k) => Math.abs(k.t - 0.25) < 1e-6)).toBe(true)
    // The pop still plays: it starts small and settles on its size.
    expect(channelKeyframes(c, 'scale')[0]!.value).toBeLessThan(1)
    expect(c.appearance).toBeUndefined()
    expect(toasts.shown).toEqual([KEYFRAMES_ARE_YOURS])
  })

  it('owns the channels while the keyframes are the preset own, and not once he keys one', () => {
    const [a] = twoCaptions({ in: 'fadeIn', durS: 0.1 })
    expect(isAppearanceOwned(clipById(a), 'opacity', seq())).toBe(true)
    expect(isAppearanceOwned(clipById(a), 'posX', seq())).toBe(true)
    updateActiveSequence('hand key', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === a ? withChannelKeyframes(c, 'posX', [{ t: 0.2, value: 50, ease: 'linear' }]) : c)),
      })),
    }))
    expect(isAppearanceOwned(clipById(a), 'opacity', seq())).toBe(false)
    expect(isAppearanceOwned(clipById(a), 'posX', seq())).toBe(false)
  })
})
