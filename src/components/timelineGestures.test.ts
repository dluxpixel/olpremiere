import { describe, expect, it } from 'vitest'
import {
  clipEndS,
  findClip,
  rateStretchGroup,
  rippleTrimGroup,
  rippleTrimSolo,
  rollEditTo,
  slideClip,
  slipClip,
  slipGroup,
  trimClipTo,
  trimGroup,
} from '../engine/timeline'
import { dragBlockIds, moveBlock, snapBlockDelta } from '../engine/blockMove'
import type { Clip, Sequence } from '../engine/types'
import {
  dragCommit,
  moveStep,
  moveTipText,
  rollPair,
  rollStep,
  slideNeighborIds,
  slideStep,
  slipStep,
  soloTrimIntent,
  stretchStep,
  trimFnFor,
  trimStep,
} from './timelineGestures'
import type { Drag } from './timelineDrag'
import { ASSETS, makeClip, makeSeq, makeTrack } from './timelineTestFixtures'

const clipIn = (seq: Sequence, id: string) => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** V1: [v 0-2][w 2-4][x 4-6], A1: [a 0-2] linked to v. */
function linkedFixture() {
  const v = makeClip({ startS: 0, outS: 2, linkId: 'L' })
  const w = makeClip({ startS: 2, inS: 2, outS: 4 })
  const x = makeClip({ startS: 4, inS: 4, outS: 6 })
  const a = makeClip({ startS: 0, outS: 2, linkId: 'L' })
  const vt = makeTrack({ clips: [v, w, x] })
  const at = makeTrack({ kind: 'audio', clips: [a] })
  return { v, w, x, a, vt, at, seq: makeSeq([vt, at]) }
}

describe('solo intent', () => {
  const { v, a, seq } = linkedFixture()

  it('trims a linked pair together unless one half was singled out first', () => {
    expect(soloTrimIntent(seq, [], v.id)).toBe(false)
    expect(soloTrimIntent(seq, [v.id, a.id], v.id)).toBe(false)
    expect(soloTrimIntent(seq, [v.id], v.id)).toBe(true)
    // A selection that does not hold the grabbed clip says nothing about it.
    expect(soloTrimIntent(seq, [a.id], v.id)).toBe(false)
  })

  it('moves one half alone unless both halves are selected', () => {
    expect(dragBlockIds(seq, [], v.id)).toEqual([v.id])
    expect(dragBlockIds(seq, [v.id], v.id)).toEqual([v.id])
    expect(dragBlockIds(seq, [v.id, a.id], v.id)).toEqual([v.id, a.id])
  })
})

describe('trimFnFor', () => {
  it('picks the ripple verbs by solo', () => {
    expect(trimFnFor(true, true)).toBe(rippleTrimSolo)
    expect(trimFnFor(false, true)).toBe(rippleTrimGroup)
  })

  it('makes a plain trim the plain trim, the clip alone or the linked pair', () => {
    expect(trimFnFor(true, false)).toBe(trimClipTo)
    expect(trimFnFor(false, false)).toBe(trimGroup)
  })
})

describe('dragBlockIds', () => {
  it('carries only the grabbed clip for a lone selection', () => {
    const { v, seq } = linkedFixture()
    expect(dragBlockIds(seq, [v.id], v.id)).toEqual([v.id])
    expect(dragBlockIds(seq, [], v.id)).toEqual([v.id])
  })

  it('carries every selected clip, and a partner only when both halves are selected', () => {
    const { v, w, x, a, seq } = linkedFixture()
    // In sequence order: V1 then A1.
    expect(dragBlockIds(seq, [v.id, a.id, x.id], v.id)).toEqual([v.id, x.id, a.id])
    // Grab w with the pair selected: the pair travels as a pair.
    expect(dragBlockIds(seq, [w.id, v.id, a.id], w.id)).toEqual([v.id, w.id, a.id])
    // Only v of the pair selected: it goes alone.
    expect(dragBlockIds(seq, [w.id, v.id], w.id)).toEqual([v.id, w.id])
  })

  it('leaves clips on locked tracks behind', () => {
    const v = makeClip({ startS: 0 })
    const locked = makeClip({ startS: 0 })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ locked: true, clips: [locked] })])
    expect(dragBlockIds(seq, [v.id, locked.id], v.id)).toEqual([v.id])
  })
})

describe('slide and roll partners', () => {
  const { v, w, x, vt } = linkedFixture()
  it('finds the neighbours either side', () => {
    expect(slideNeighborIds(vt, w.id)).toEqual([v.id, x.id])
    expect(slideNeighborIds(vt, v.id)).toEqual([w.id])
    expect(slideNeighborIds(vt, x.id)).toEqual([w.id])
  })

  it('rolls the cut on the grabbed edge, or reports there is none', () => {
    expect(rollPair(vt, w.id, 'out')).toEqual({ leftId: w.id, rightId: x.id })
    expect(rollPair(vt, w.id, 'in')).toEqual({ leftId: v.id, rightId: w.id })
    expect(rollPair(vt, v.id, 'in')).toBeNull()
    expect(rollPair(vt, x.id, 'out')).toBeNull()
  })
})

describe('snapBlockDelta', () => {
  const points = [0, 5, 10]
  /** One clip at 0 that is `dur` long: its delta is its start. */
  const one = (dur: number) => [0, dur]
  it('snaps the leading edge', () => {
    expect(snapBlockDelta(one(2), 4.9, points, 0.2)).toEqual({ deltaS: 5, indicatorT: 5 })
  })
  it('snaps the trailing edge, drawing the line where the tail lands', () => {
    expect(snapBlockDelta(one(2), 7.9, points, 0.2)).toEqual({ deltaS: 8, indicatorT: 10 })
  })
  it('keeps the closer catch, the head on a tie', () => {
    // Head 4.9 is 0.1 from 5, tail 9.95 is 0.05 from 10: the tail wins.
    expect(snapBlockDelta(one(5.05), 4.9, points, 0.2).indicatorT).toBe(10)
    expect(snapBlockDelta(one(5.2), 4.9, points, 0.2).indicatorT).toBe(5)
    // Head 3.75 and tail 8.25 are each exactly 0.25 from a point.
    expect(snapBlockDelta(one(4.5), 3.75, [0, 4, 8], 0.5).indicatorT, 'an exact tie goes to the head').toBe(4)
  })
  it('leaves the time alone when nothing is in reach', () => {
    expect(snapBlockDelta(one(1), 2.5, points, 0.2)).toEqual({ deltaS: 2.5, indicatorT: null })
  })
  it('lets ANY clip of the block catch, and moves the whole block by that one correction', () => {
    // The grabbed clip 0-2 is nowhere near a point; the carried clip 10-12 lands at 12.9, 0.1 from 13.
    expect(snapBlockDelta([0, 2, 10, 12], 2.9, [13], 0.2)).toEqual({ deltaS: 3, indicatorT: 13 })
  })
})

describe('drag steps', () => {
  it('reads out a move as its start and signed delta', () => {
    expect(moveTipText(2, 1, 30)).toBe('Move  0:02.00  +1.00s')
  })

  it('slips by the applied offset', () => {
    const { w, seq } = linkedFixture()
    const drag = { kind: 'slip' as const, clipId: w.id, startXPx: 0, solo: true }
    const step = slipStep(seq, ASSETS, drag, -1)
    expect(step.next).toEqual(slipClip(seq, ASSETS, w.id, -1))
    expect(step.tip).toBe('Slip  in 0:01.00 · out 0:03.00  -1.00s')
    expect(slipStep(seq, ASSETS, { ...drag, solo: false }, -1).next).toEqual(slipGroup(seq, ASSETS, w.id, -1))
  })

  it('rolls the cut and reads out the right clip', () => {
    const { w, x, seq } = linkedFixture()
    const step = rollStep(seq, ASSETS, { kind: 'roll', leftId: w.id, rightId: x.id }, 4.5)
    expect(step.next).toEqual(rollEditTo(seq, ASSETS, w.id, x.id, 4.5))
    expect(step.tip).toBe('Roll  0:04.50  +0.50s')
  })

  it('slides and reads out the slid clip', () => {
    const { v, w, x, seq } = linkedFixture()
    const step = slideStep(seq, ASSETS, { kind: 'slide', clipId: w.id, grabOffsetS: 0, neighborIds: [v.id, x.id] }, 2.5)
    expect(step.next).toEqual(slideClip(seq, ASSETS, w.id, 2.5))
    expect(step.tip).toBe('Slide  0:02.50  +0.50s')
  })

  it('stretches and reads out the speed and length', () => {
    const { x, seq } = linkedFixture()
    const step = stretchStep(seq, { kind: 'stretch', clipId: x.id, edge: 'out' }, 8)
    expect(step.next).toEqual(rateStretchGroup(seq, x.id, 'out', 8))
    expect(step.tip).toBe(`Speed ${Math.round(Math.abs(clipIn(step.next, x.id).speed) * 100)}%  ·  0:04.00`)
  })

  it('trims and reads out the edge', () => {
    const { x, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: x.id, edge: 'out', ripple: false, solo: false }, 5)
    expect(clipIn(step.next, x.id).outS).toBe(5)
    expect(step.tip).toBe('0:05.00  -1.00s')
  })

  it('reads out a ripple in-trim as the source edge', () => {
    const { x, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: x.id, edge: 'in', ripple: true, solo: false }, 4.5)
    expect(step.tip?.startsWith('Ripple  ')).toBe(true)
  })

  it('reads out a trim pushed into the neighbour as the trim it is, stopped at the cut', () => {
    const { w, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: w.id, edge: 'out', ripple: false, solo: false }, 5)
    expect(step.next).toBe(seq)
    expect(step.tip).toBe('0:04.00  +0.00s')
  })
})

describe('dragCommit', () => {
  const { v, w, x, a, seq } = linkedFixture()
  const final = { trackId: '', tS: 4.5 }

  it('names a move by how many travel and commits moveBlock', () => {
    const drag = {
      kind: 'move' as const,
      clipId: x.id,
      grabOffsetS: 0,
      trackKind: 'video' as const,
      downClientX: 0,
      downClientY: 0,
      blockIds: [x.id],
      collapseCandidate: false,
    }
    const target = { trackId: seq.tracks[0].id, tS: 8 }
    const c = dragCommit(drag, target, ASSETS)!
    expect(c.label).toBe('Move clip')
    expect(c.apply(seq)).toEqual(moveBlock(seq, [x.id], x.id, target.trackId, 8))
    expect(dragCommit({ ...drag, blockIds: [v.id, x.id] }, target, ASSETS)!.label).toBe('Move clips')
  })

  it('labels a trim and a ripple trim, and a trim pushed into the neighbour is still a trim', () => {
    const trim = { kind: 'trim' as const, clipId: x.id, edge: 'out' as const, ripple: false, solo: false }
    expect(dragCommit(trim, final, ASSETS)!.label).toBe('Trim clip')
    expect(dragCommit({ ...trim, ripple: true }, final, ASSETS)!.label).toBe('Ripple trim')
    expect(dragCommit({ ...trim, clipId: w.id }, { trackId: '', tS: 5 }, ASSETS)!.label).toBe('Trim clip')
  })

  it('commits the same edit the preview showed for every edge gesture', () => {
    const cases: [Drag, string][] = [
      [{ kind: 'stretch', clipId: x.id, edge: 'out' }, 'Rate stretch'],
      [{ kind: 'slip', clipId: w.id, startXPx: 0, solo: true }, 'Slip clip'],
      [{ kind: 'roll', leftId: w.id, rightId: x.id }, 'Roll edit'],
      [{ kind: 'slide', clipId: w.id, grabOffsetS: 0, neighborIds: [v.id, x.id] }, 'Slide clip'],
    ]
    for (const [drag, label] of cases) {
      const c = dragCommit(drag, final, ASSETS)!
      expect(c.label).toBe(label)
      expect(c.apply(seq)).not.toBe(seq)
    }
    expect(dragCommit(cases[1][0], { trackId: '', tS: -1 }, ASSETS)!.apply(seq)).toEqual(slipClip(seq, ASSETS, w.id, -1))
    expect(a.id).toBeTruthy()
  })

  it('commits nothing for scrub, hand and marquee', () => {
    expect(dragCommit({ kind: 'scrub' }, final, ASSETS)).toBeNull()
    expect(dragCommit({ kind: 'hand', startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 }, final, ASSETS)).toBeNull()
    expect(dragCommit({ kind: 'marquee', x0: 0, y0: 0, additive: false, base: [] }, final, ASSETS)).toBeNull()
  })
})

describe('moveStep (one pointermove of a clip drag)', () => {
  /** V1: [p 0-2] [q 2-4] [r 8-10]; V2 empty. */
  function fixture() {
    const p = makeClip({ startS: 0, outS: 2 })
    const q = makeClip({ startS: 2, inS: 2, outS: 4 })
    const r = makeClip({ startS: 8, outS: 2 })
    const v1 = makeTrack({ clips: [p, q, r] })
    const v2 = makeTrack({ name: 'V2', clips: [] })
    return { p, q, r, v1, v2, seq: makeSeq([v1, v2]) }
  }
  const moveDrag = (clipId: string, blockIds: string[]) => ({
    kind: 'move' as const,
    clipId,
    grabOffsetS: 0,
    trackKind: 'video' as const,
    downClientX: 0,
    downClientY: 0,
    blockIds,
    collapseCandidate: false,
  })

  it('previews exactly what the release commits', () => {
    const { p, q, v1, v2, seq } = fixture()
    const drag = moveDrag(p.id, [p.id, q.id])
    for (const [startS, trackId] of [[3, v1.id], [5.5, v1.id], [1, v2.id], [0.3, v1.id]] as const) {
      const step = moveStep(seq, drag, { startS, trackId }, { points: [0, 8, 10], thresholdS: 0.2 })
      const commit = dragCommit(drag, step.final, ASSETS)!
      expect(commit.apply(seq)).toEqual(step.next)
    }
  })

  it('reads out where the grabbed clip LANDS, not where the pointer is', () => {
    const { p, q, v1, seq } = fixture()
    // The p+q block wants +5: q would sit on r, so the nearest fit is +4, butted against r.
    const step = moveStep(seq, moveDrag(p.id, [p.id, q.id]), { startS: 5, trackId: v1.id }, null)
    expect(findClip(step.next, p.id)!.clip.startS).toBe(4)
    expect(step.tip).toBe(moveTipText(4, 0, 30))
    expect(step.final).toEqual({ trackId: v1.id, tS: 5 })
  })

  it('snaps the block by any of its edges and draws the line only where it really lands', () => {
    const { p, q, v2, seq } = fixture()
    // On V2 (empty) q's tail at 4 + 3.95 catches the point 8.
    const caught = moveStep(seq, moveDrag(p.id, [p.id, q.id]), { startS: 3.95, trackId: v2.id }, { points: [8], thresholdS: 0.1 })
    expect(caught.indicatorT).toBe(8)
    expect(clipEndS(findClip(caught.next, q.id)!.clip)).toBe(8)
  })

  it('aimed at a lane with no room near the hand, it stays on its own lane, and the release lands exactly that (2026-10-03)', () => {
    // V1 packed 0 to 40 with 2 s cuts, an overlay on V2 at 10. The hand points at V1, 10.5 s.
    const cuts = Array.from({ length: 20 }, (_, i) => makeClip({ startS: i * 2, outS: 2 }))
    const v1 = makeTrack({ clips: cuts })
    const ov = makeClip({ startS: 10, outS: 2 })
    const v2 = makeTrack({ name: 'V2', clips: [ov] })
    const seq = makeSeq([v1, v2])
    const drag = moveDrag(ov.id, [ov.id])
    const step = moveStep(seq, drag, { startS: 10.5, trackId: v1.id }, null, 400 / 60)
    expect(findClip(step.next, ov.id)).toMatchObject({ track: { id: v2.id }, clip: { startS: 10.5 } })
    // `final` names the lane it lands on, so the release cannot pick a different one.
    expect(step.final).toEqual({ trackId: v2.id, tS: 10.5 })
    expect(dragCommit(drag, step.final, ASSETS)!.apply(seq)).toEqual(step.next)
  })

  it('a move that lands nowhere new changes nothing and commits nothing', () => {
    const { q, v1, seq } = fixture()
    // q is butted against p, so half a second left has nowhere to go but home.
    const step = moveStep(seq, moveDrag(q.id, [q.id]), { startS: 1.5, trackId: v1.id }, null)
    expect(step.next).toBe(seq)
    expect(dragCommit(moveDrag(q.id, [q.id]), step.final, ASSETS)!.apply(seq)).toBe(seq)
  })
})

describe('a plain edge drag stops at the neighbour (the Vegas crossfade is gone, 2026-10-03)', () => {
  /** A [0,4] then B [4,8] on V1, both with spare media either side; optionally linked sound on A1. */
  function cut(linked: boolean) {
    const a = makeClip({ startS: 0, inS: 1, outS: 5, ...(linked ? { linkId: 'LA' } : {}) })
    const b = makeClip({ startS: 4, inS: 3, outS: 7, ...(linked ? { linkId: 'LB' } : {}) })
    const tracks = [makeTrack({ clips: [a, b] })]
    let aa: Clip | undefined
    let ba: Clip | undefined
    if (linked) {
      aa = makeClip({ startS: 0, inS: 1, outS: 5, linkId: 'LA' })
      ba = makeClip({ startS: 4, inS: 3, outS: 7, linkId: 'LB' })
      tracks.push(makeTrack({ kind: 'audio', name: 'A1', clips: [aa, ba] }))
    }
    return { a, b, aa, ba, seq: makeSeq(tracks) }
  }
  const trim = (clipId: string, edge: 'in' | 'out', solo: boolean) => ({ kind: 'trim' as const, clipId, edge, ripple: false, solo })

  it("B's head pulled into A stops at the cut: A keeps every frame, nothing gets a dissolve", () => {
    const { a, b, seq } = cut(false)
    const solo = soloTrimIntent(seq, [], b.id)
    const step = trimStep(seq, ASSETS, trim(b.id, 'in', solo), 3)
    expect(findClip(step.next, a.id)!.clip).toEqual(a)
    expect(findClip(step.next, b.id)!.clip.startS).toBe(4)
    expect(findClip(step.next, b.id)!.clip.transitionIn).toBeUndefined()
    expect(step.tip).not.toMatch(/Crossfade/)
    expect(dragCommit(trim(b.id, 'in', solo), { trackId: '', tS: 3 }, ASSETS)!.label).toBe('Trim clip')
  })

  it('on a linked pair the picture and its sound both stay on the cut, in sync', () => {
    const { a, b, aa, ba, seq } = cut(true)
    const out = dragCommit(trim(b.id, 'in', false), { trackId: '', tS: 3 }, ASSETS)!.apply(seq)
    expect(findClip(out, b.id)!.clip.startS).toBe(4)
    expect(findClip(out, ba!.id)!.clip.startS).toBe(4)
    expect(clipEndS(findClip(out, a.id)!.clip)).toBe(4)
    expect(clipEndS(findClip(out, aa!.id)!.clip)).toBe(4)
  })

  it("A's tail pushed into B stops at the cut and writes nothing onto B", () => {
    const { a, b, seq } = cut(false)
    const out = dragCommit(trim(a.id, 'out', false), { trackId: '', tS: 5 }, ASSETS)!.apply(seq)
    expect(findClip(out, b.id)!.clip).toEqual(b)
    expect(clipEndS(findClip(out, a.id)!.clip)).toBe(4)
  })

  it("on audio the neighbour's own fades are left exactly as he set them", () => {
    const a = makeClip({ startS: 0, inS: 1, outS: 5, fadeOutS: 0.2 })
    const b = makeClip({ startS: 4, inS: 3, outS: 7, fadeInS: 0.1 })
    const seq = makeSeq([makeTrack({ kind: 'audio', name: 'A1', clips: [a, b] })])
    const out = dragCommit(trim(a.id, 'out', false), { trackId: '', tS: 6 }, ASSETS)!.apply(seq)
    expect(findClip(out, b.id)!.clip).toEqual(b)
    expect(findClip(out, a.id)!.clip.fadeOutS).toBe(0.2)
  })
})
