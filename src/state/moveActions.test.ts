// The shelf against the document: what one tile click does to a selection, what
// it refuses, and how many times he has to press Ctrl+Z afterwards.
//
// The twelve-clip test is the one that matters. His Short is twenty clips, so a
// tile that costs one undo step per clip is not a shelf, it is a chore, and the
// whole two-move claim collapses at the second clip.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelBase, channelKeyframes, resolveChannel } from '../engine/effects/channels'
import { MOVES } from '../engine/moves'
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
  appendMoveToSelection,
  applyMoveToSelection,
  dropMove,
  moveOnClip,
  movesOnClip,
  setMoveDepth,
  setMoveWindow,
} from './moveActions'
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

/**
 * TWO MOVES ON ONE CLIP, and the shelf still names both of them.
 *
 * His call, 2026-08-17: a chain is exactly two, they may touch, they may never
 * overlap. Nothing is stored about either one, so every test here reads the pair
 * back off the keyframes the same way the panel does.
 */
describe('a second move after the first', () => {
  const names = (id: string): string[] => movesOnClip(clipById(id)).map((m) => m.id)

  it('reads back as both moves, in the order they run', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    expect(names(clip.id)).toEqual(['inAndOut', 'leftThenRight'])
  })

  /**
   * ⛔ THE PAIR THE OLD ENGINE TEST SAID WAS IMPOSSIBLE. Where two moves touch they
   * share one instant, and it can hold only one outgoing curve, so the head used to
   * read as hand edited. Recognition stopped comparing a field the run does not own
   * (moves.ts, sameTracks) and the head keeps its name.
   */
  it('lets the two of them TOUCH, with nothing in between', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    appendMoveToSelection('punchIn')
    const [head, tail] = movesOnClip(clipById(clip.id))
    expect([head.id, tail.id]).toEqual(['leftThenRight', 'punchIn'])
    expect(tail.startS).toBeCloseTo(head.endS, 6)
  })

  /**
   * ⛔ A MOVE THAT ENDS UP CLOSE CAN BE FOLLOWED, his call of 2026-08-17: *"Look at
   * what the best programs have."* They chain from where the picture is, so the tail
   * is written against the head's landing instead of against the resting framing.
   * This exact pair was refused out loud until then.
   */
  it('follows a move that stays where it lands, from where it landed', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('pushIn')
    toasted.length = 0
    appendMoveToSelection('leftThenRight')
    const [head, tail] = movesOnClip(clipById(clip.id))
    expect([head.id, tail.id]).toEqual(['pushIn', 'leftThenRight'])
    expect(toasted).toEqual([])
    // Touching, and the picture standing still across the join: the tail starts at
    // the size the head left it at rather than snapping home in one frame.
    expect(tail.startS).toBeCloseTo(head.endS, 6)
    const written = clipById(clip.id)
    const at = (t: number): number => resolveChannel(written, 'scale', t)
    expect(at(head.endS)).toBeCloseTo(at(tail.startS), 6)
    expect(at(head.endS)).toBeGreaterThan(channelBase(written, 'scale') + 1e-3)
  })

  /**
   * ⛔ AND THE HALF THAT MOVED IS STILL THE HALF THAT GOES DARK. The tail's anchor is
   * read off the head's own last keyframe, so a hand edit in the head could have
   * quietly taken the tail's name with it. One diamond dragged inside the head, and
   * the shelf names neither half rather than naming the wrong thing.
   */
  it('goes dark on a chain he has edited by hand', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('pushIn')
    appendMoveToSelection('leftThenRight')
    expect(movesOnClip(clipById(clip.id))).toHaveLength(2)
    updateActiveSequence('hand edit', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? {
              ...t,
              clips: t.clips.map((c) => {
                const scale = [...channelKeyframes(c, 'scale')]
                scale[1] = { ...scale[1], value: scale[1].value * 1.13 }
                return { ...c, keyframes: { ...c.keyframes, scale } }
              }),
            }
          : t,
      ),
    }))
    expect(movesOnClip(clipById(clip.id))).toEqual([])
  })

  it('refuses a second move that does not start from normal', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('leftThenRight')
    const before = clipById(clip.id)
    toasted.length = 0
    appendMoveToSelection('holdBig')
    expect(clipById(clip.id)).toBe(before)
    expect(toasted).toContain('Hold big does not start from normal, so it cannot follow another move')
  })

  /** And the other way round: one held size cannot be the first of two either. */
  it('refuses to follow a move that is one held size, and names IT', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('holdBig')
    const before = clipById(clip.id)
    toasted.length = 0
    appendMoveToSelection('punchIn')
    expect(clipById(clip.id)).toBe(before)
    expect(toasted).toContain('Hold big holds one size, so it cannot be the first of two')
  })

  /**
   * ⛔ THE ONE THAT MAKES THE FEATURE REACHABLE AT ALL. Every clip-window move
   * already runs the whole length of the clip, so a tail asked to start where the
   * head ends would start where the clip ends and write nothing. The head is
   * squeezed into the front half instead, and the two touch.
   */
  it('makes room when the first move already fills the clip', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    expect(moveOnClip(clipById(clip.id))?.endS).toBeCloseTo(6, 6)
    appendMoveToSelection('leftThenRight')
    const [head, tail] = movesOnClip(clipById(clip.id))
    expect([head.id, tail.id]).toEqual(['inAndOut', 'leftThenRight'])
    expect(head.endS).toBeLessThan(6)
    // Touching, which is the edit he asked for: no gap between them.
    expect(tail.startS).toBeCloseTo(head.endS, 6)
  })

  it('is one undo step across a whole selection', () => {
    const clips = seedClips(12, 6)
    useStore.getState().setUI({ selection: clips.map((c) => c.id) })
    applyMoveToSelection('inAndOut')
    const before = undoDepth()
    appendMoveToSelection('leftThenRight')
    expect(undoDepth()).toBe(before + 1)
    for (const c of clips) expect(names(c.id)).toEqual(['inAndOut', 'leftThenRight'])
  })

  /**
   * ⛔ EVERY ORDERED PAIR OF THE SHIPPED TWELVE, MEASURED RATHER THAN ARGUED. 47 of
   * the 144 joined while both halves were written against the resting framing. The
   * tail is written against the head's landing since, which is his call of 2026-08-17,
   * so the only refusals left are tails that do not start from normal.
   */
  it('joins every pair except the two a move itself rules out', () => {
    const defs = MOVES.filter((m) => m.beats.length > 0)
    // The expectation comes off the table rather than being a number typed in, so
    // adding a move to the shelf cannot quietly shrink what chains.
    const canLead = (d: (typeof defs)[number]): boolean => d.beats.length >= 2
    const canFollow = (d: (typeof defs)[number]): boolean => d.beats[0].d === 0
    const joined: string[] = []
    const refused: string[] = []
    for (const head of defs) {
      for (const tail of defs) {
        useStore.getState().setProject(newProject())
        const [clip] = seedClips(1, 6)
        useStore.getState().setUI({ selection: [clip.id], playheadS: 0, punchDepth: 1.2, punchRiseFrames: 5 })
        applyMoveToSelection(head.id)
        appendMoveToSelection(tail.id)
        const back = movesOnClip(clipById(clip.id)).map((m) => m.id)
        const pair = `${head.id}>${tail.id}`
        ;(back.length === 2 && back[0] === head.id && back[1] === tail.id ? joined : refused).push(pair)
        // Whatever happened, it happened for the reason the table predicts.
        expect(refused.includes(pair)).toBe(!canLead(head) || !canFollow(tail))
      }
    }
    expect(joined.length + refused.length).toBe(144)
    expect(joined).toHaveLength(defs.filter(canLead).length * defs.filter(canFollow).length)
    // 99 of 144 on 2026-08-17, against 47 while both halves were written from rest.
    expect(joined).toHaveLength(99)
  })

  /**
   * ⛔ THE COST OF THE LOOSER ANCHOR, MEASURED RATHER THAN HOPED FOR. The tail is now
   * rebuilt against wherever the picture is at the join instead of always against the
   * resting framing, so there are strictly more ways a set of keyframes could fall
   * apart into a nameable pair. The thing that would break is the promise the whole
   * panel rests on: that a clip he has touched by hand stops claiming a preset.
   *
   * So every joining pair is written and every diamond that carries its SHAPE is
   * dragged in time, one at a time, and the shelf has to stop naming the pair.
   *
   * ⛔ WHICH DIAMONDS COUNT IS THE WHOLE CARE OF THIS TEST, and getting it wrong is a
   * false alarm rather than a bug found. Three diamonds cannot be hand edits: the two
   * ends of a half are its window and dragging them is a retime the panel supports on
   * purpose, and the one where the halves meet is both of their windows at once. A
   * VALUE cannot be one either, because a push in at 130 percent is still a push in
   * and the depth is read back rather than stored. What is left is the interior
   * timing, which no depth and no window can absorb, and that is what is swept here.
   */
  it('stops naming a pair once a diamond that carries its shape moves', () => {
    const defs = MOVES.filter((m) => m.beats.length > 0)
    let swept = 0
    for (const head of defs.filter((d) => d.beats.length >= 2)) {
      for (const tail of defs.filter((d) => d.beats[0].d === 0)) {
        useStore.getState().setProject(newProject())
        const [clip] = seedClips(1, 6)
        useStore.getState().setUI({ selection: [clip.id], playheadS: 0, punchDepth: 1.2, punchRiseFrames: 5 })
        applyMoveToSelection(head.id)
        appendMoveToSelection(tail.id)
        const pair = clipById(clip.id)
        const runs = movesOnClip(pair)
        expect(runs.map((m) => m.id)).toEqual([head.id, tail.id])
        const ends = [runs[0].startS, runs[0].endS, runs[1].startS, runs[1].endS]
        const kfs = channelKeyframes(pair, 'scale')
        const shape = kfs
          .map((_, i) => i)
          .filter((i) => !ends.some((e) => Math.abs(kfs[i].t - e) < 1e-6))
        for (const i of shape) {
          updateActiveSequence('nudge', (sq) => ({
            ...sq,
            tracks: sq.tracks.map((t, ti) =>
              ti === 0
                ? {
                    ...t,
                    clips: t.clips.map((c) => {
                      if (c.id !== clip.id) return c
                      const scale = [...channelKeyframes(pair, 'scale')]
                      scale[i] = { ...scale[i], t: scale[i].t + 4 / 30 }
                      return { ...c, keyframes: { ...c.keyframes, scale } }
                    }),
                  }
                : t,
            ),
          }))
          expect(movesOnClip(clipById(clip.id)).map((m) => m.id)).not.toEqual([head.id, tail.id])
          swept++
        }
      }
    }
    // Not every pair has an interior diamond: two two-keyframe moves that touch are
    // three diamonds and all three are windows. The ones that do are swept.
    expect(swept).toBeGreaterThan(140)
  })

  /**
   * ⛔ AND THE HONEST OTHER HALF OF IT, WRITTEN DOWN RATHER THAN LEFT AS A GAP. Push in
   * twice over is three diamonds and every one of them is a window or a depth, so
   * there is no hand edit of it for the shelf to catch: whatever he drags, the clip
   * really is still a push in followed by a push in. Better said out loud here than
   * discovered as a surprise later.
   */
  it('keeps naming two push ins when the diamond between them moves, because that is the truth', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('pushIn')
    appendMoveToSelection('pushIn')
    const pair = clipById(clip.id)
    expect(movesOnClip(pair).map((m) => m.id)).toEqual(['pushIn', 'pushIn'])
    updateActiveSequence('nudge', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, ti) =>
        ti === 0
          ? {
              ...t,
              clips: t.clips.map((c) => {
                const scale = [...channelKeyframes(c, 'scale')]
                scale[1] = { ...scale[1], value: scale[1].value * 1.09 }
                return { ...c, keyframes: { ...c.keyframes, scale } }
              }),
            }
          : t,
      ),
    }))
    expect(movesOnClip(clipById(clip.id)).map((m) => m.id)).toEqual(['pushIn', 'pushIn'])
  })

  /** A clip holds two. The third is refused out loud rather than written and left unnameable. */
  it('refuses a third move and says so', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    const full = clipById(clip.id)
    toasted.length = 0
    appendMoveToSelection('shake')
    expect(clipById(clip.id)).toBe(full)
    expect(toasted).toContain('A clip holds two moves, and this one is full')
  })

  /** Nothing to chain after: an empty clip simply takes the move, and says nothing. */
  it('puts the move on a clip that has none', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    toasted.length = 0
    appendMoveToSelection('punchIn')
    expect(names(clip.id)).toEqual(['punchIn'])
    expect(toasted).toEqual([])
  })

  it('leaves a hand-edited clip exactly as he shaped it', () => {
    const [clip] = seedClips(1, 6)
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
    expect(movesOnClip(handEdited)).toHaveLength(0)
    appendMoveToSelection('pop')
    expect(clipById(clip.id)).toBe(handEdited)
  })

  /** The slider says how big the move on this clip is, so both halves answer it. */
  it('takes the depth slider through both halves at once', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    setMoveDepth(1.6, [clip.id])
    const runs = movesOnClip(clipById(clip.id))
    expect(runs.map((r) => r.id)).toEqual(['inAndOut', 'leftThenRight'])
    for (const run of runs) expect(run.depth).toBeCloseTo(1.6, 4)
  })

  /**
   * ⛔ RETIMING ONE HALF MUST NOT DELETE THE OTHER. `applyMove` clears the move
   * channels before it writes, so a retime that did not carry the neighbour
   * through would take it off the clip and leave a chain he cannot get back.
   */
  it('retimes one half and leaves the other where it was', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    const [head, tail] = movesOnClip(clipById(clip.id))
    setMoveWindow(clip.id, 0.5, head.endS, { id: head.id, depth: head.depth, other: tail })
    const after = movesOnClip(clipById(clip.id))
    expect(after.map((r) => r.id)).toEqual(['inAndOut', 'leftThenRight'])
    expect(after[0].startS).toBeCloseTo(0.5, 2)
    expect(after[1].startS).toBeCloseTo(tail.startS, 6)
    expect(after[1].endS).toBeCloseTo(tail.endS, 6)
  })

  /** Touching is allowed. Crossing is not: the neighbour's edge is the wall. */
  it('will not drag one half across the other', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    const [head, tail] = movesOnClip(clipById(clip.id))
    setMoveWindow(clip.id, 0, 5.5, { id: head.id, depth: head.depth, other: tail })
    const after = movesOnClip(clipById(clip.id))
    expect(after.map((r) => r.id)).toEqual(['inAndOut', 'leftThenRight'])
    expect(after[0].endS).toBeLessThanOrEqual(tail.startS + 1e-6)
  })

  it('takes one half off and leaves the other where it is', () => {
    const [clip] = seedClips(1, 6)
    useStore.getState().setUI({ selection: [clip.id] })
    applyMoveToSelection('inAndOut')
    appendMoveToSelection('leftThenRight')
    const [, tail] = movesOnClip(clipById(clip.id))
    dropMove(clip.id, 0)
    const left = movesOnClip(clipById(clip.id))
    expect(left.map((r) => r.id)).toEqual(['leftThenRight'])
    expect(left[0].startS).toBeCloseTo(tail.startS, 6)
    expect(left[0].endS).toBeCloseTo(tail.endS, 6)
  })
})
