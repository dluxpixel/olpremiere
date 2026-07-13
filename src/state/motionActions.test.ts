import { beforeEach, describe, expect, it, vi } from 'vitest'
import { evalChannel } from '../engine/keyframes'
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
  impactAtPlayhead,
  punchInAtPlayhead,
  rampWorkArea,
  whipToNext,
} from './motionActions'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const v1 = () => seq().tracks[0]

function seedClip(startS: number, durS: number): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, durS)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('punchInAtPlayhead / impactAtPlayhead', () => {
  it('writes the zoom at the playhead in one undo step', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 5 })
    punchInAtPlayhead(clip.id)
    const c = v1().clips[0]
    expect(evalChannel(c.keyframes?.scale, 3 + 5 / 30, 1)).toBeCloseTo(1.2, 5)
    useStore.getState().undo()
    expect(v1().clips[0].keyframes?.scale).toBeUndefined()
  })

  it('refuses when the playhead is outside the clip', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 0.5 })
    punchInAtPlayhead(clip.id)
    impactAtPlayhead(clip.id)
    expect(v1().clips[0].keyframes).toBeUndefined()
  })

  it('impact writes the desat/blur/scale pulse', () => {
    const clip = seedClip(2, 10)
    useStore.getState().setUI({ playheadS: 6 })
    impactAtPlayhead(clip.id)
    const c = v1().clips[0]
    expect(evalChannel(c.keyframes?.saturation, 4, 0)).toBeCloseTo(-0.9, 5)
    expect(evalChannel(c.keyframes?.blur, 4, 0)).toBeCloseTo(6, 5)
  })
})

describe('whipToNext', () => {
  it('adds the directional-blur pair across a touching cut', () => {
    const a = seedClip(0, 4)
    seedClip(4, 4)
    whipToNext(a.id)
    const [ca, cb] = v1().clips
    expect(ca.effects.some((e) => e.type === 'directionalBlur')).toBe(true)
    expect(cb.effects.some((e) => e.type === 'directionalBlur')).toBe(true)
    useStore.getState().undo()
    expect(v1().clips.every((c) => c.effects.length === 0)).toBe(true)
  })

  it('refuses when the next clip does not touch', () => {
    const a = seedClip(0, 4)
    seedClip(6, 4)
    whipToNext(a.id)
    expect(v1().clips.every((c) => c.effects.length === 0)).toBe(true)
  })
})

describe('rampWorkArea', () => {
  it('ramps the in/out range of the clip and selects the sped piece', () => {
    const clip = seedClip(0, 10)
    updateActiveSequence('io', (sq) => ({ ...sq, inPointS: 4, outPointS: 7 }))
    rampWorkArea(clip.id, 2)
    const clips = v1().clips
    expect(clips).toHaveLength(3)
    expect(clips[1].speed).toBe(2)
    expect(clips[1].effects.some((e) => e.type === 'gaussianBlur')).toBe(true)
    expect(useStore.getState().ui.selection).toEqual([clips[1].id])
  })

  it('does nothing without a work area', () => {
    const clip = seedClip(0, 10)
    rampWorkArea(clip.id, 2)
    expect(v1().clips).toHaveLength(1)
    expect(v1().clips[0].speed).toBe(1)
  })
})
