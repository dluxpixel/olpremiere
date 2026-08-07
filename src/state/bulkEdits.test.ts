import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes } from '../engine/effects/channels'
import { MOTION_CURVES } from '../engine/motion'
import { recomputeDuration } from '../engine/timeline'
import { MERGE_WINDOW_MS } from './history'
import { setClipDenoise, setClipTransition, toggleChannelAnimation } from './clipEdits'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import {
  applyEffectToAllClips,
  applyEffectToClips,
  clearEffectsForClips,
  mapClips,
  setChannelForClips,
  setClipsFade,
  setClipsGainDb,
  setClipsPosition,
} from './bulkEdits'
import { setClipsAppearance } from './appearanceActions'
import { updateTitles } from './titleActions'
import { updateActiveSequence, useStore } from './store'

// The suite runs on the node environment; the real toast store reaches for
// window.setTimeout. Same shim the other action suites use.
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips
const clipById = (id: string): Clip =>
  seq()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!

/** Seed a title on a track (V1 by default; V2 to overlap one in time). */
function seedTitle(startS: number, durS = 5, trackIndex = 0): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, durS)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

/**
 * ARM a clip the way the app does: give it motion of its own. Armed is a
 * derived per-clip fact now (any of posX, posY, scale, rotation carrying
 * keyframes), not a stored preference, so there is nothing to switch on.
 */
function arm(clipId: string): void {
  const before = useStore.getState().ui.playheadS
  useStore.getState().setUI({ playheadS: 0 })
  toggleChannelAnimation(clipId, 'scale')
  useStore.getState().setUI({ playheadS: before })
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('updateTitles (bulk boldness)', () => {
  it('toggles boldness on every selected title in ONE undo step', () => {
    // defaultTitleDef() is bold:true (captions ship bold), so the meaningful
    // bulk edit is turning it OFF across the whole selection.
    const a = seedTitle(0)
    const b = seedTitle(6)
    const c = seedTitle(12)
    expect(clips().map((x) => x.title!.bold)).toEqual([true, true, true])
    updateTitles([a.id, b.id, c.id], { bold: false })
    expect(clips().map((x) => x.title!.bold)).toEqual([false, false, false])
    // A single undo reverts all three → proves one command, not three.
    useStore.getState().undo()
    expect(clips().map((x) => x.title!.bold)).toEqual([true, true, true])
  })

  it('sets font family + color across the selection', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    updateTitles([a.id, b.id], { fontFamily: "'Versatile Bold', sans-serif", color: '#FFD400' })
    expect(clips().every((x) => x.title!.fontFamily === "'Versatile Bold', sans-serif")).toBe(true)
    expect(clips().every((x) => x.title!.color === '#FFD400')).toBe(true)
  })
})

describe('setChannelForClips', () => {
  it('sets opacity on all selected clips at once', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    setChannelForClips([a.id, b.id], 'opacity', 0.5)
    expect(clips().map((x) => x.opacity)).toEqual([0.5, 0.5])
    useStore.getState().undo()
    expect(clips().map((x) => x.opacity)).toEqual([1, 1])
  })

  it('keys the value at the playhead on ANIMATED clips instead of a no-op base write', () => {
    const a = seedTitle(0)
    useStore.getState().setUI({ playheadS: 2 })
    toggleChannelAnimation(a.id, 'scale') // seeds a scale keyframe → channel is animated
    useStore.getState().setUI({ playheadS: 3 })
    setChannelForClips([a.id], 'scale', 2)
    // A keyframe carrying value 2 was upserted (not silently dropped onto the base).
    expect(channelKeyframes(clips()[0], 'scale').some((k) => Math.abs(k.value - 2) < 1e-9)).toBe(true)
  })
})

describe('applyEffectToClips', () => {
  it('adds one fresh effect instance to each selected clip', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    applyEffectToClips([a.id, b.id], 'saturation')
    const [ca, cb] = clips()
    expect(ca.effects).toHaveLength(1)
    expect(cb.effects).toHaveLength(1)
    expect(ca.effects[0].type).toBe('saturation')
    // Distinct instance ids (not a shared reference).
    expect(ca.effects[0].id).not.toBe(cb.effects[0].id)
  })
})

describe('applyEffectToAllClips', () => {
  it('applies to EVERY video clip with nothing selected, in ONE undo step', () => {
    seedTitle(0)
    seedTitle(6)
    seedTitle(12)
    useStore.getState().setUI({ selection: [] })
    applyEffectToAllClips('saturation')
    expect(clips().map((c) => c.effects.length)).toEqual([1, 1, 1])
    // Distinct instance ids per clip, not one shared object.
    const ids = clips().map((c) => c.effects[0].id)
    expect(new Set(ids).size).toBe(3)
    useStore.getState().undo()
    expect(clips().map((c) => c.effects.length)).toEqual([0, 0, 0])
  })

  it('leaves audio clips alone (a visual effect means nothing on them)', () => {
    seedTitle(0)
    updateActiveSequence('seed audio', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.kind === 'audio'
          ? { ...t, clips: [{ ...newTitleClip(defaultTitleDef('a'), 0, 5), title: undefined }] }
          : t,
      ),
    }))
    applyEffectToAllClips('saturation')
    const audio = seq().tracks.find((t) => t.kind === 'audio')!
    expect(audio.clips[0].effects).toHaveLength(0)
  })

  it('does nothing (no undo entry) when there are no video clips', () => {
    const before = useStore.getState().project
    applyEffectToAllClips('saturation')
    expect(useStore.getState().project).toBe(before)
  })
})

describe('setClipDenoise (undo granularity)', () => {
  // The strength field is a ScrubField, so an arrow key commits on every press.
  // That run is ONE gesture and now folds into ONE undo step (see
  // undoMerge.test.ts, which owns the rule); a pause longer than the merge
  // window still starts the next step. This test used to fire two commits back
  // to back and demand two entries, which is precisely the flood he asked to be
  // rid of. The clock is driven by hand so BOTH halves are asserted.
  let now = 0
  beforeEach(() => {
    now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a run of nudges is ONE undo step; a pause starts the next', () => {
    const a = seedTitle(0)
    setClipDenoise(a.id, 1)
    now += 50
    setClipDenoise(a.id, 0.6)
    expect(clips()[0].denoise).toBeCloseTo(0.6, 9)
    // Both landed inside the window, so one undo takes the WHOLE run off.
    useStore.getState().undo()
    expect('denoise' in clips()[0]).toBe(false)

    setClipDenoise(a.id, 1)
    now += MERGE_WINDOW_MS + 1
    setClipDenoise(a.id, 0.6)
    useStore.getState().undo()
    expect(clips()[0].denoise).toBe(1)
    useStore.getState().undo()
    expect('denoise' in clips()[0]).toBe(false)
  })

  it('same value / strength 0 are no-ops that add NO undo entry', () => {
    const a = seedTitle(0)
    setClipDenoise(a.id, 0.5)
    const before = useStore.getState().project
    setClipDenoise(a.id, 0.5) // identical → no entry
    expect(useStore.getState().project).toBe(before)
    setClipDenoise(a.id, 0) // 0 ≡ off
    expect('denoise' in clips()[0]).toBe(false)
  })

  it('clamps strength above 1', () => {
    const a = seedTitle(0)
    setClipDenoise(a.id, 5)
    expect(clips()[0].denoise).toBe(1)
  })
})

describe('setClipTransition duration envelope (whiteFlash)', () => {
  it('every kind gets its own default: a hit is short, a blend longer, none a full second', () => {
    const a = seedTitle(0)
    setClipTransition(a.id, 'in', 'whiteFlash')
    expect(clips()[0].transitionIn).toEqual({ type: 'whiteFlash', durationS: 0.2 })
    setClipTransition(a.id, 'in', 'crossDissolve')
    const dissolve = clips()[0].transitionIn!.durationS
    expect(dissolve).toBeGreaterThan(0.2)
    // A full second is half a shot at his pacing, so the old flat default is gone.
    expect(dissolve).toBeLessThanOrEqual(0.5)
  })

  it('keeps in-envelope durations; snaps out-of-envelope ones to the default', () => {
    const a = seedTitle(0)
    setClipTransition(a.id, 'in', 'whiteFlash', 0.35)
    expect(clips()[0].transitionIn!.durationS).toBeCloseTo(0.35, 9)
    // A 1 s dissolve switched to White Flash: 1 s is outside 100-500 ms → 200 ms.
    setClipTransition(a.id, 'in', 'whiteFlash', 1)
    expect(clips()[0].transitionIn!.durationS).toBe(0.2)
    setClipTransition(a.id, 'in', 'whiteFlash', 0.01)
    expect(clips()[0].transitionIn!.durationS).toBe(0.2)
  })

  it('does not carry the OLD kind\'s default across, even when it fits the new envelope', () => {
    // The reported case. Dip to Black defaults to 0.5 s and White Flash's ceiling
    // is exactly 0.5 s, so the old "is it in envelope" test said yes on a
    // technicality and handed back a flash at 2.5x its own default.
    const a = seedTitle(0)
    setClipTransition(a.id, 'in', 'dipToBlack')
    expect(clips()[0].transitionIn).toEqual({ type: 'dipToBlack', durationS: 0.5 })
    setClipTransition(a.id, 'in', 'whiteFlash', clips()[0].transitionIn!.durationS)
    expect(clips()[0].transitionIn).toEqual({ type: 'whiteFlash', durationS: 0.2 })
  })

  it('still keeps a duration he actually chose when the kind changes', () => {
    // 0.3 s is nobody's default, so it reads as deliberate and must survive.
    const a = seedTitle(0)
    setClipTransition(a.id, 'in', 'whiteFlash', 0.3)
    expect(clips()[0].transitionIn!.durationS).toBeCloseTo(0.3, 9)
    setClipTransition(a.id, 'in', 'crossDissolve', clips()[0].transitionIn!.durationS)
    expect(clips()[0].transitionIn).toEqual({ type: 'crossDissolve', durationS: 0.3 })
  })
})

describe('setClipsGainDb / setClipsFade', () => {
  it('sets the same gain + fades on every selected clip', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    setClipsGainDb([a.id, b.id], -6)
    setClipsFade([a.id, b.id], 'in', 0.5)
    expect(clips().map((x) => x.audioGainDb)).toEqual([-6, -6])
    expect(clips().map((x) => x.fadeInS)).toEqual([0.5, 0.5])
  })
})

describe('setClipsPosition', () => {
  it('aligns every selected clip to the same x,y in one undo step', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    setClipsPosition([a.id, b.id], 120, -40)
    expect(clips().map((c) => [c.transform.x, c.transform.y])).toEqual([
      [120, -40],
      [120, -40],
    ])
    useStore.getState().undo()
    expect(clips().map((c) => [c.transform.x, c.transform.y])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })

  // The multi-selection used to write transform.x/y unconditionally while the
  // single-clip gizmo keyframed, so ONE drag animated one clip and permanently
  // moved the others. Both paths share withChannelsAtTime now, and both ask the
  // same armed question of each clip.
  it('an ARMED selection animates EVERY clip in it, not just the one under the gizmo', () => {
    const a = seedTitle(0)
    const b = seedTitle(0, 5, 1) // V2, so both clips are live at the playhead
    arm(a.id)
    arm(b.id)
    useStore.getState().setUI({ playheadS: 2 })

    setClipsPosition([a.id, b.id], 120, -40)

    for (const c of [clipById(a.id), clipById(b.id)]) {
      // Two keyframes: the old value pinned at the head, the new one at the playhead.
      expect(channelKeyframes(c, 'posX').map((k) => [k.t, k.value])).toEqual([
        [0, 0],
        [2, 120],
      ])
      expect(channelKeyframes(c, 'posY').map((k) => [k.t, k.value])).toEqual([
        [0, 0],
        [2, -40],
      ])
      // ...and the base is left alone, so nothing jumps outside the animation.
      expect([c.transform.x, c.transform.y]).toEqual([0, 0])
    }
    // Still ONE undo step for the whole selection.
    useStore.getState().undo()
    expect(channelKeyframes(clipById(a.id), 'posX')).toHaveLength(0)
    expect(channelKeyframes(clipById(b.id), 'posX')).toHaveLength(0)
  })

  // A STILL clip in the selection keeps the plain move: nothing about it says
  // he wants motion, and a persisted toggle no longer speaks for it.
  it('leaves a clip carrying no motion of its own on the base write', () => {
    const a = seedTitle(0)
    useStore.getState().setUI({ playheadS: 2 })
    setClipsPosition([a.id], 120, -40)
    expect(channelKeyframes(clipById(a.id), 'posX')).toHaveLength(0)
    expect([clipById(a.id).transform.x, clipById(a.id).transform.y]).toEqual([120, -40])
  })

  // The heart of it: one gesture, one meaning. The bulk commit writes the SAME
  // curve the single-clip commit writes, off the same table.
  it('writes the chosen move curve on the keyframe the move leaves FROM', () => {
    const a = seedTitle(0)
    arm(a.id)
    useStore.getState().setUI({ playheadS: 2, moveCurve: 'snapIn' })

    setClipsPosition([a.id], 120, -40)

    const kfs = channelKeyframes(clipById(a.id), 'posX')
    expect(kfs[0].curve).toEqual([...MOTION_CURVES.snapIn])
  })

  it('keys an ALREADY-animated clip at the playhead instead of a dead base write', () => {
    const a = seedTitle(0)
    useStore.getState().setUI({ playheadS: 1 })
    toggleChannelAnimation(a.id, 'posX') // channel is animated from here on
    useStore.getState().setUI({ playheadS: 3 })

    setClipsPosition([a.id], 200, 0)

    const kfs = channelKeyframes(clipById(a.id), 'posX')
    expect(kfs.some((k) => Math.abs(k.t - 3) < 1e-9 && k.value === 200)).toBe(true)
  })

  it('a selected clip the playhead is OUTSIDE keeps the plain move', () => {
    const a = seedTitle(0) // [0, 5)
    const b = seedTitle(6) // [6, 11), nowhere near the playhead
    arm(a.id)
    arm(b.id)
    useStore.getState().setUI({ playheadS: 2 })

    setClipsPosition([a.id, b.id], 90, 10)

    expect(channelKeyframes(clipById(a.id), 'posX')).toHaveLength(2)
    // b has no meaningful local time to key at, so it just moves.
    expect(channelKeyframes(clipById(b.id), 'posX')).toHaveLength(0)
    expect([clipById(b.id).transform.x, clipById(b.id).transform.y]).toEqual([90, 10])
  })

  it('an appearance-owned clip still recompiles from the new base', () => {
    const a = seedTitle(0)
    useStore.getState().setUI({ playheadS: 2 })
    setClipsAppearance([a.id], { in: 'pop' })

    setClipsPosition([a.id], 64, 0)

    const c = clipById(a.id)
    expect(c.transform.x).toBe(64)
    expect(c.appearance?.in).toBe('pop')
  })
})

describe('no-op guard', () => {
  it('records no command when nothing changes', () => {
    const a = seedTitle(0)
    const before = useStore.getState().project
    clearEffectsForClips([a.id]) // no effects to clear → no mutation
    expect(useStore.getState().project).toBe(before)
  })

  it('mapClips skips locked tracks', () => {
    const a = seedTitle(0)
    // Lock track 0.
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    const before = useStore.getState().project
    mapClips([a.id], 'try', (c) => ({ ...c, opacity: 0.2 }))
    expect(useStore.getState().project).toBe(before)
  })
})
