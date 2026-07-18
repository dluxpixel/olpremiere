import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes } from '../engine/effects/channels'
import { recomputeDuration } from '../engine/timeline'
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
import { updateTitles } from './titleActions'
import { updateActiveSequence, useStore } from './store'

// The suite runs on the node environment; the real toast store reaches for
// window.setTimeout. Same shim the other action suites use.
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips

function seedTitle(startS: number, durS = 5): Clip {
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
  it('each dispatch is ONE undo step; off deletes the field entirely', () => {
    const a = seedTitle(0)
    setClipDenoise(a.id, 1)
    setClipDenoise(a.id, 0.6)
    expect(clips()[0].denoise).toBeCloseTo(0.6, 9)
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
  it('whiteFlash defaults to its 200 ms hit; other kinds keep the 1 s default', () => {
    const a = seedTitle(0)
    setClipTransition(a.id, 'in', 'whiteFlash')
    expect(clips()[0].transitionIn).toEqual({ type: 'whiteFlash', durationS: 0.2 })
    setClipTransition(a.id, 'in', 'crossDissolve')
    expect(clips()[0].transitionIn!.durationS).toBe(1)
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
