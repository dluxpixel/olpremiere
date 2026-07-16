import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { channelKeyframes } from '../engine/effects/channels'
import {
  autoAppearanceDur,
  setClipsAppearance,
  setClipsAppearanceDur,
} from './appearanceActions'
import { toggleChannelAnimation } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips

function seedTitle(startS: number, durS: number): Clip {
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

describe('setClipsAppearance (bulk, merge)', () => {
  it('sets an entrance on all selected clips and MERGES (keeps the other side)', () => {
    const a = seedTitle(0, 5)
    const b = seedTitle(6, 5)
    setClipsAppearance([a.id, b.id], { in: 'pop' })
    setClipsAppearance([a.id, b.id], { out: 'fadeOut' }) // must not drop 'in'
    expect(clips().every((c) => c.appearance?.in === 'pop' && c.appearance?.out === 'fadeOut')).toBe(true)
    useStore.getState().undo() // reverts only the exit edit
    expect(clips().every((c) => c.appearance?.in === 'pop' && !c.appearance?.out)).toBe(true)
  })
})

describe('setClipsAppearanceDur', () => {
  it('sets a fixed speed on all selected clips', () => {
    const a = seedTitle(0, 5)
    const b = seedTitle(6, 5)
    setClipsAppearance([a.id, b.id], { in: 'pop' })
    setClipsAppearanceDur([a.id, b.id], 0.5)
    expect(clips().every((c) => c.appearance?.durS === 0.5)).toBe(true)
  })

  it('auto sizes each clip\'s animation to ITS OWN duration', () => {
    const short = seedTitle(0, 0.3)
    const long = seedTitle(1, 3)
    setClipsAppearance([short.id, long.id], { in: 'pop' })
    setClipsAppearanceDur([short.id, long.id], 'auto')
    const [cs, cl] = clips()
    expect(cs.appearance?.durS).toBeCloseTo(autoAppearanceDur(0.3), 5) // ~0.12
    expect(cl.appearance?.durS).toBeCloseTo(autoAppearanceDur(3), 5) // clamped to 0.6
    expect(cl.appearance!.durS!).toBeGreaterThan(cs.appearance!.durS!) // longer word → slower
  })
})

describe('bulk speed does NOT wipe manual keyframes on un-animated clips', () => {
  it('setClipsAppearanceDur leaves a clip with manual scale keyframes (no appearance) untouched', () => {
    const c = seedTitle(0, 5)
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'scale') // manual keyframe, NO appearance
    const before = useStore.getState().project
    setClipsAppearanceDur([c.id], 0.5) // must be a no-op (no appearance to speed up)
    expect(useStore.getState().project).toBe(before) // untouched
    expect(channelKeyframes(clips()[0], 'scale').length).toBeGreaterThan(0) // keyframes survive
  })

  it('setClipsAppearance None leaves an un-animated clip alone', () => {
    const c = seedTitle(0, 5)
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(c.id, 'scale')
    const before = useStore.getState().project
    setClipsAppearance([c.id], { in: undefined })
    expect(useStore.getState().project).toBe(before)
  })
})

describe('autoAppearanceDur', () => {
  it('clamps to [0.08, 0.6]', () => {
    expect(autoAppearanceDur(0.05)).toBe(0.08)
    expect(autoAppearanceDur(100)).toBe(0.6)
    expect(autoAppearanceDur(1)).toBeCloseTo(0.4, 5)
  })
})
