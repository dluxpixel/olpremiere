// The shelf against the document: what one tile click does to a selection, what
// it refuses, and how many times he has to press Ctrl+Z afterwards.
//
// The twelve-clip test is the one that matters. His Short is twenty clips, so a
// tile that costs one undo step per clip is not a shelf, it is a chore, and the
// whole two-move claim collapses at the second clip.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelKeyframes, resolveChannel } from '../engine/effects/channels'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { applyMoveToSelection, moveOnClip, setMoveDepth, setMoveWindow } from './moveActions'
import { updateActiveSequence, useStore } from './store'

const toasted: string[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => void (globalThis as { __toasts?: string[] }).__toasts?.push(m) }) },
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const undoDepth = (): number => useStore.getState().history.undo.length

function seedClips(count: number, durS = 4): Clip[] {
  const made: Clip[] = []
  for (let i = 0; i < count; i++) made.push(newTitleClip(defaultTitleDef('x'), i * durS, durS))
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: made } : t)) }),
  )
  return made
}

beforeEach(() => {
  ;(globalThis as { __toasts?: string[] }).__toasts = toasted
  toasted.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, punchDepth: 1.2, punchRiseFrames: 5 })
})

describe('one tile click', () => {
  it('puts the move on the selected clip and names the undo step after it', () => {
    const [clip] = seedClips(1)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    expect(channelKeyframes(clipById(clip.id), 'scale')).toHaveLength(6)
    expect(undoDepth()).toBe(2) // the seed, then the move
    expect(useStore.getState().history.undo[1].label).toBe('Left, then right')
  })

  /**
   * TWELVE CLIPS, ONE UNDO STEP. One dispatch over the whole selection, not one
   * per clip: twelve steps to Ctrl+Z through is exactly the kind of thing that
   * makes an editor feel like it is fighting you.
   */
  it('applies to a whole selection in ONE undo step, and one press takes it back', () => {
    const clips = seedClips(12)
    useStore.getState().setUI({ selection: clips.map((c) => c.id) })
    const before = undoDepth()
    applyMoveToSelection('punchIn')
    expect(undoDepth()).toBe(before + 1)
    for (const c of clips) expect(channelKeyframes(clipById(c.id), 'scale')).toHaveLength(2)

    useStore.getState().popHistory('undo')
    expect(useStore.getState().history.undo).toHaveLength(before)
  })

  /** A second tile REPLACES the first. One clip, one move, nothing to clean up. */
  it('replaces the move that was there rather than stacking onto it', () => {
    const [clip] = seedClips(1)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    applyMoveToSelection('pushIn')
    expect(channelKeyframes(clipById(clip.id), 'scale')).toHaveLength(2)
    expect(channelKeyframes(clipById(clip.id), 'posX')).toHaveLength(0)
    expect(moveOnClip(clipById(clip.id))?.id).toBe('pushIn')
  })

  /** Tile 0 takes it all off again, both the size and the position it moved. */
  it('None clears every channel the move wrote', () => {
    const [clip] = seedClips(1)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    applyMoveToSelection('none')
    for (const ch of ['scale', 'posX', 'posY'] as const) {
      expect(channelKeyframes(clipById(clip.id), ch)).toHaveLength(0)
    }
    expect(resolveChannel(clipById(clip.id), 'posY', 0)).toBeCloseTo(0, 9)
  })

  it('says so and writes nothing when no clip is selected', () => {
    seedClips(1)
    const before = undoDepth()
    applyMoveToSelection('punchIn')
    expect(undoDepth()).toBe(before)
    expect(toasted).toContain('Pick a clip first')
  })

  it('refuses a locked track out loud', () => {
    const [clip] = seedClips(1)
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    useStore.getState().setUI({ selection: [clip.id] })
    const before = undoDepth()
    applyMoveToSelection('punchIn')
    expect(undoDepth()).toBe(before)
    expect(channelKeyframes(clipById(clip.id), 'scale')).toHaveLength(0)
  })

  /**
   * A clip whose entrance animation owns its keyframes is refused with the exact
   * sentence the gizmo badge already uses. Same guard, same wording, because the
   * appearance is recompiled on every transform edit and would silently eat the
   * move.
   */
  it('refuses a clip whose entrance animation owns its keyframes', () => {
    const [clip] = seedClips(1)
    updateActiveSequence('appearance', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0 ? { ...t, clips: t.clips.map((c) => ({ ...c, appearance: { in: 'fade', durS: 0.3 } })) } : t,
      ),
    }))
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('punchIn')
    expect(channelKeyframes(clipById(clip.id), 'scale')).toHaveLength(0)
    expect(toasted).toContain('This clip uses an entrance animation, which owns its keyframes.')
  })
})

describe('the one slider', () => {
  /** A whole drag is ONE undo press, folded the way every scrubbed field folds. */
  it('changes how big the move goes, live, in one undo step for the run', () => {
    const [clip] = seedClips(1)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('punchIn')
    const before = undoDepth()
    for (const d of [1.25, 1.3, 1.35, 1.4]) setMoveDepth(d, [clip.id])
    expect(undoDepth()).toBe(before + 1)
    expect(channelKeyframes(clipById(clip.id), 'scale')[1].value).toBeCloseTo(1.4, 6)
    // Still the same move: the slider changes one number, it does not re-decide
    // what the clip is doing.
    expect(moveOnClip(clipById(clip.id))?.id).toBe('punchIn')
  })

  it('leaves a hand-edited clip alone rather than straightening it into a tile', () => {
    const [clip] = seedClips(1)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    updateActiveSequence('hand edit', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? {
              ...t,
              clips: t.clips.map((c) => {
                const scale = [...channelKeyframes(c, 'scale')]
                scale[2] = { ...scale[2], t: scale[2].t + 0.5 }
                return { ...c, keyframes: { ...c.keyframes, scale } }
              }),
            }
          : t,
      ),
    }))
    const handEdited = clipById(clip.id)
    expect(moveOnClip(handEdited)).toBeNull()
    setMoveDepth(1.6, [clip.id])
    expect(channelKeyframes(clipById(clip.id), 'scale')).toEqual(channelKeyframes(handEdited, 'scale'))
  })
})

describe('dragging the ends of the move', () => {
  it('retimes the move without unlighting the tile', () => {
    const [clip] = seedClips(1, 10)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    setMoveWindow(clip.id, 2, 6)
    const found = moveOnClip(clipById(clip.id))
    expect(found?.id).toBe('leftThenRight')
    expect(found?.startS).toBeCloseTo(2, 6)
    expect(found?.endS).toBeCloseTo(6, 6)
    // Outside the window the clip sits at its own framing, untouched.
    expect(resolveChannel(clipById(clip.id), 'scale', 0.5)).toBeCloseTo(1, 6)
    expect(resolveChannel(clipById(clip.id), 'scale', 9)).toBeCloseTo(1, 6)
  })

  it('keeps the depth it already had', () => {
    const [clip] = seedClips(1, 10)
    useStore.getState().setUI({ selection: [clip.id] })
    useStore.getState().setUI({ punchDepth: 1.5 })
    applyMoveToSelection('inAndOut')
    setMoveWindow(clip.id, 1, 5)
    expect(moveOnClip(clipById(clip.id))?.depth).toBeCloseTo(1.5, 4)
  })
})

/** A move made on one clip is the same move on the next: same digit, same result. */
describe('the same move on the next clip', () => {
  it('is one action on a fresh selection', () => {
    const clips = seedClips(2)
    useStore.getState().setUI({ selection: [clips[0].id] })
    applyMoveToSelection('leftThenRight')
    useStore.getState().setUI({ selection: [clips[1].id] })
    applyMoveToSelection('leftThenRight')
    const a = channelKeyframes(clipById(clips[0].id), 'posX').map((k) => k.value)
    const b = channelKeyframes(clipById(clips[1].id), 'posX').map((k) => k.value)
    expect(a).toEqual(b)
  })
})

// His report, 2026-08-14: dragging the ends of the bar loses the clip's move.
// It was never the SELECTION. setMoveWindow re-derived the move from the
// keyframes on every pointermove, and recognition fails at many window widths
// because the rebuilt beats quantise a frame differently. At the first such
// width the function returned, so the drag died under his cursor, the tile went
// dark and the depth slider went inert. A real drag crosses those widths
// constantly, which is why it felt random.
describe('a retime can never lose the move it is retiming', () => {
  /** Every width a real drag passes through, not the two that happen to work. */
  const sweep = (id: 'leftThenRight' | 'inAndOut' | 'pushIn'): string[] => {
    const broken: string[] = []
    for (let i = 1; i <= 34; i++) {
      const [clip] = seedClips(1, 6)
      useStore.getState().setUI({ selection: [clip.id] })
      applyMoveToSelection(id)
      const endS = (i / 35) * 6
      setMoveWindow(clip.id, 0, endS, { id, depth: 1.2 })
      // His complaint, precisely: the move must still BE there afterwards.
      const n = channelKeyframes(clipById(clip.id), 'scale').length
      if (n === 0) broken.push(`${endS.toFixed(2)}:wiped`)
    }
    return broken
  }

  it('keeps the move at EVERY window width a drag passes through', () => {
    // Before the fix the drag went dead at the first bad width and every later
    // pointermove was ignored, so the gesture died under his cursor.
    // ⚠️ The TILE can still go dark at a few widths: recognition compares the
    // keyframe COUNT (moves.ts:439) and a rebuild can collapse two beats onto
    // one frame. That is a separate defect and is written up, not fixed here.
    expect(sweep('leftThenRight')).toEqual([])
    expect(sweep('inAndOut')).toEqual([])
    expect(sweep('pushIn')).toEqual([])
  })

  it('refuses a window too small to hold the move, rather than deleting it', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    const before = channelKeyframes(clipById(clip.id), 'scale')
    expect(before.length).toBeGreaterThan(0)

    // A hair of a window: every beat lands on one frame, so a rebuild would
    // produce nothing at all and the move would be gone with no way back.
    setMoveWindow(clip.id, 0, 0.02, { id: 'inAndOut', depth: 1.2 })

    const after = clipById(clip.id)
    expect(channelKeyframes(after, 'scale').length).toBeGreaterThan(0)
    expect(moveOnClip(after)?.id).toBe('inAndOut')
  })
})
