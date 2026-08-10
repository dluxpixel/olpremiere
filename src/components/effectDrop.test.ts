// What an effect DROPPED on the Inspector does to the clip underneath it.
//
// effectDrop.ts reads the payload and calls applyEffectToClips, and calls
// nothing else, so this file drives that action with the arguments the drop
// hands it - one clip, no clip, an audio clip - and pins the three things a
// drop must never get wrong:
//
//   1. KEYFRAMES SURVIVE INTACT. His constraint, named explicitly. A clip
//      carrying keyframed scale, position and an already-keyframed effect param
//      must come back with every keyframe byte-identical: times, values, eases
//      and hand-shaped curves, not just counts.
//   2. HIS STACK ORDER IS HIS. The new instance is inserted; nothing already
//      there moves, including a stack he has reordered by hand away from the
//      canonical math order.
//   3. A REFUSAL IS SPOKEN. Dropping with nothing selected, or onto an audio
//      clip, says why. Silence is the bug this whole target exists to fix.
//
// The toast mock RECORDS rather than swallows, because here the message is the
// feature.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ shown: [] as { message: string; kind?: string }[] }))
vi.mock('../state/toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string, kind?: string) => {
        toasts.shown.push({ message, kind })
      },
    }),
  },
}))

import { channelKeyframes, withChannelKeyframes } from '../engine/effects/channels'
import { paramKeyframes } from '../engine/effects/ops'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Keyframe,
  type Sequence,
} from '../engine/types'
import { applyEffectToClips } from '../state/bulkEdits'
import { moveEffectInStack } from '../state/clipEdits'
import { updateActiveSequence, useStore } from '../state/store'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip =>
  seq()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!

/** Put a clip on a track by index (0 = V1, 2 = A1), already shaped by `build`. */
function seed(build: (c: Clip) => Clip, trackIndex = 0): Clip {
  const clip = build(newTitleClip(defaultTitleDef('x'), 0, 5))
  updateActiveSequence('seed', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips: [...t.clips, clip] } : t)),
  }))
  return clip
}

/**
 * Keyframes with deliberately awkward times, off-integer values, a mix of eases
 * and one hand-shaped curve: anything that rounds, re-times, re-eases or drops
 * the curve shows up as a difference rather than an equal count.
 */
const SCALE_KFS: Keyframe[] = [
  { t: 0.25, value: 1, ease: 'easeOut' },
  // Curve is a tuple in CSS order, not a named object. Written the wrong way once,
  // which typechecked nowhere and would have silently dropped the hand-shaped curve
  // this fixture exists to protect.
  { t: 1.7333, value: 1.42, ease: 'easeInOut', curve: [0.2, 0, 0.35, 1] },
  { t: 4.1, value: 0.98, ease: 'linear' },
]
const POS_X_KFS: Keyframe[] = [
  { t: 0, value: -140, ease: 'linear' },
  { t: 2.5, value: 37.5, ease: 'hold' },
]
const POS_Y_KFS: Keyframe[] = [
  { t: 0.5, value: 12, ease: 'easeIn' },
  { t: 3.25, value: -8.75, ease: 'easeOut' },
]
/** An effect param that is ALREADY animated, reached the way the app reaches it. */
const BLUR_KFS: Keyframe[] = [
  { t: 0.1, value: 0, ease: 'linear' },
  { t: 1.9, value: 14.5, ease: 'easeInOut' },
]

const withEveryKeyframe = (c: Clip): Clip =>
  withChannelKeyframes(
    withChannelKeyframes(
      withChannelKeyframes(withChannelKeyframes(c, 'scale', SCALE_KFS), 'posX', POS_X_KFS),
      'posY',
      POS_Y_KFS,
    ),
    'blur',
    BLUR_KFS,
  )

beforeEach(() => {
  toasts.shown = []
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('an effect dropped on the Inspector', () => {
  it('lands on the clip the panel is showing', () => {
    const clip = seed((c) => c)
    applyEffectToClips([clip.id], 'vignette')
    expect(clipById(clip.id).effects.map((e) => e.type)).toEqual(['vignette'])
  })

  it('is ONE undo step, however it arrived', () => {
    const clip = seed((c) => c)
    applyEffectToClips([clip.id], 'vignette')
    useStore.getState().undo()
    expect(clipById(clip.id).effects).toEqual([])
  })

  it('leaves every keyframe on the clip byte-identical', () => {
    const clip = seed(withEveryKeyframe)
    const before = structuredClone(clipById(clip.id))

    applyEffectToClips([clip.id], 'vignette')

    const after = clipById(clip.id)
    // Times AND values AND eases AND the hand-shaped curve, per channel.
    expect(channelKeyframes(after, 'scale')).toEqual(SCALE_KFS)
    expect(channelKeyframes(after, 'posX')).toEqual(POS_X_KFS)
    expect(channelKeyframes(after, 'posY')).toEqual(POS_Y_KFS)
    expect(channelKeyframes(after, 'blur')).toEqual(BLUR_KFS)
    // Spelled out once, so a change to the fixture cannot quietly weaken this:
    // the moments and the numbers on them are what he would lose.
    expect(channelKeyframes(after, 'scale').map((k) => [k.t, k.value])).toEqual([
      [0.25, 1],
      [1.7333, 1.42],
      [4.1, 0.98],
    ])
    expect(channelKeyframes(after, 'scale')[1].curve).toEqual([0.2, 0, 0.35, 1])
    // And nothing else about the clip moved either, transform, opacity, title,
    // the lot, only `effects` grew.
    expect({ ...after, effects: [] }).toEqual({ ...before, effects: [] })
    expect(after.effects).toHaveLength(before.effects.length + 1)
  })

  it('keeps the ANIMATED instance first when a second copy of the same effect lands', () => {
    // The channel adapter resolves to the FIRST effect of a type. If a fresh,
    // neutral copy could land in front of the keyframed one, the keyframes would
    // still be in the file but the Inspector would read the empty instance and
    // his animation would look deleted.
    const clip = seed(withEveryKeyframe)
    const animatedId = clipById(clip.id).effects.find((e) => e.type === 'gaussianBlur')!.id

    applyEffectToClips([clip.id], 'gaussianBlur')

    const after = clipById(clip.id)
    const blurs = after.effects.filter((e) => e.type === 'gaussianBlur')
    expect(blurs).toHaveLength(2)
    expect(blurs[0].id).toBe(animatedId)
    expect(paramKeyframes(blurs[0], 'blur')).toEqual(BLUR_KFS)
    expect(channelKeyframes(after, 'blur')).toEqual(BLUR_KFS)
  })

  it('inserts without reordering a stack he has arranged by hand', () => {
    const clip = seed((c) => c)
    applyEffectToClips([clip.id], 'saturation')
    applyEffectToClips([clip.id], 'gaussianBlur')
    // Canonical order is saturation then blur; he drags the blur in front.
    const blurId = clipById(clip.id).effects.find((e) => e.type === 'gaussianBlur')!.id
    moveEffectInStack(clip.id, blurId, -1)
    const beforeIds = clipById(clip.id).effects.map((e) => e.id)
    expect(clipById(clip.id).effects.map((e) => e.type)).toEqual(['gaussianBlur', 'saturation'])

    applyEffectToClips([clip.id], 'vignette')

    const after = clipById(clip.id).effects
    // His two are still in HIS order, still the same instances; the newcomer is
    // simply added.
    expect(after.filter((e) => beforeIds.includes(e.id)).map((e) => e.id)).toEqual(beforeIds)
    expect(after).toHaveLength(3)
    expect(after.some((e) => e.type === 'vignette')).toBe(true)
  })

  it('says "Select a clip first" instead of swallowing a drop with nothing selected', () => {
    // The empty target list is exactly what the Inspector's own empty state
    // hands the action. This sentence IS the fix for the reported bug.
    applyEffectToClips([], 'vignette')
    expect(toasts.shown).toEqual([{ message: 'Select a clip first', kind: 'danger' }])
  })

  it('says why an audio clip cannot take one', () => {
    const clip = seed((c) => ({ ...c, title: undefined }), 2)
    applyEffectToClips([clip.id], 'vignette')
    expect(clipById(clip.id).effects).toEqual([])
    expect(toasts.shown).toHaveLength(1)
    expect(toasts.shown[0].message).toContain('audio')
    expect(toasts.shown[0].kind).toBe('danger')
  })

  it('applies nothing and records no undo step for a clip on a LOCKED track', () => {
    // The drop target refuses this one at the cursor (see effectDrop.ts), the
    // way Timeline refuses the same drag over a locked track. Pinned here so the
    // action underneath stays harmless even if a caller gets past that.
    const clip = seed((c) => c)
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    const before = useStore.getState().project
    applyEffectToClips([clip.id], 'vignette')
    expect(clipById(clip.id).effects).toEqual([])
    expect(useStore.getState().project).toBe(before)
  })
})
