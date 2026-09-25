import { describe, expect, it } from 'vitest'
import {
  moveSelectionWith,
  rateStretchGroup,
  rippleTrimGroup,
  rippleTrimSolo,
  rollEditTo,
  slideClip,
  slipClip,
  slipGroup,
} from '../engine/timeline'
import { trimIntoNeighbour } from '../engine/overlapCrossfade'
import type { Sequence } from '../engine/types'
import {
  carriedOthers,
  dragCommit,
  moveTipText,
  rollPair,
  rollStep,
  slideNeighborIds,
  slideStep,
  slipStep,
  snapMoveStart,
  soloMoveIntent,
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
    expect(soloMoveIntent(seq, [], v.id)).toBe(true)
    expect(soloMoveIntent(seq, [v.id], v.id)).toBe(true)
    expect(soloMoveIntent(seq, [v.id, a.id], v.id)).toBe(false)
  })
})

describe('trimFnFor', () => {
  it('picks the ripple verbs by solo', () => {
    expect(trimFnFor(true, true)).toBe(rippleTrimSolo)
    expect(trimFnFor(false, true)).toBe(rippleTrimGroup)
  })

  it('makes a plain trim the crossfade-aware trim, carrying solo', () => {
    const { v, seq } = linkedFixture()
    for (const solo of [true, false]) {
      expect(trimFnFor(solo, false)(seq, ASSETS, v.id, 'out', 1.5)).toEqual(
        trimIntoNeighbour(seq, ASSETS, v.id, 'out', 1.5, solo),
      )
    }
  })
})

describe('carriedOthers', () => {
  it('carries nothing for a lone selection', () => {
    const { v, seq } = linkedFixture()
    expect(carriedOthers(seq, [v.id], v.id)).toEqual([])
    expect(carriedOthers(seq, [], v.id)).toEqual([])
  })

  it('carries every other selected clip once per link group, with its own solo', () => {
    const { v, w, x, a, seq } = linkedFixture()
    // The grabbed clip's partner is skipped (it travels with the group). An
    // unlinked clip is its own whole group, so it is never solo.
    expect(carriedOthers(seq, [v.id, a.id, x.id], v.id)).toEqual([{ id: x.id, startS0: 4, solo: false }])
    // Grab w with v and a selected: the pair is carried once, not solo.
    expect(carriedOthers(seq, [w.id, v.id, a.id], w.id)).toEqual([{ id: v.id, startS0: 0, solo: false }])
    // Only v of the pair selected: it goes solo.
    expect(carriedOthers(seq, [w.id, v.id], w.id)).toEqual([{ id: v.id, startS0: 0, solo: true }])
  })

  it('leaves clips on locked tracks behind', () => {
    const v = makeClip({ startS: 0 })
    const locked = makeClip({ startS: 0 })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ locked: true, clips: [locked] })])
    expect(carriedOthers(seq, [v.id, locked.id], v.id)).toEqual([])
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

describe('snapMoveStart', () => {
  const points = [0, 5, 10]
  it('snaps the leading edge', () => {
    expect(snapMoveStart(4.9, 2, points, 0.2)).toEqual({ desired: 5, indicatorT: 5 })
  })
  it('snaps the trailing edge, drawing the line where the tail lands', () => {
    expect(snapMoveStart(7.9, 2, points, 0.2)).toEqual({ desired: 8, indicatorT: 10 })
  })
  it('keeps the closer catch, the head on a tie', () => {
    // Head 4.9 is 0.1 from 5, tail 9.95 is 0.05 from 10: the tail wins.
    expect(snapMoveStart(4.9, 5.05, points, 0.2).indicatorT).toBe(10)
    expect(snapMoveStart(4.9, 5.2, points, 0.2).indicatorT).toBe(5)
  })
  it('leaves the time alone when nothing is in reach', () => {
    expect(snapMoveStart(2.5, 1, points, 0.2)).toEqual({ desired: 2.5, indicatorT: null })
  })
})

describe('drag steps', () => {
  it('reads out a move as its start and signed delta', () => {
    expect(moveTipText(2, 1, 30)).toBe('Move  00:00:02:00  +00:01:00 / +30f')
  })

  it('slips by the applied offset', () => {
    const { w, seq } = linkedFixture()
    const drag = { kind: 'slip' as const, clipId: w.id, startXPx: 0, solo: true }
    const step = slipStep(seq, ASSETS, drag, -1)
    expect(step.next).toEqual(slipClip(seq, ASSETS, w.id, -1))
    expect(step.tip).toBe('Slip  in 00:00:01:00 · out 00:00:03:00  -00:01:00 / -30f')
    expect(slipStep(seq, ASSETS, { ...drag, solo: false }, -1).next).toEqual(slipGroup(seq, ASSETS, w.id, -1))
  })

  it('rolls the cut and reads out the right clip', () => {
    const { w, x, seq } = linkedFixture()
    const step = rollStep(seq, ASSETS, { kind: 'roll', leftId: w.id, rightId: x.id }, 4.5)
    expect(step.next).toEqual(rollEditTo(seq, ASSETS, w.id, x.id, 4.5))
    expect(step.tip).toBe('Roll  00:00:04:15  +00:00:15 / +15f')
  })

  it('slides and reads out the slid clip', () => {
    const { v, w, x, seq } = linkedFixture()
    const step = slideStep(seq, ASSETS, { kind: 'slide', clipId: w.id, grabOffsetS: 0, neighborIds: [v.id, x.id] }, 2.5)
    expect(step.next).toEqual(slideClip(seq, ASSETS, w.id, 2.5))
    expect(step.tip).toBe('Slide  00:00:02:15  +00:00:15 / +15f')
  })

  it('stretches and reads out the speed and length', () => {
    const { x, seq } = linkedFixture()
    const step = stretchStep(seq, { kind: 'stretch', clipId: x.id, edge: 'out' }, 8)
    expect(step.next).toEqual(rateStretchGroup(seq, x.id, 'out', 8))
    expect(step.tip).toBe(`Speed ${Math.round(Math.abs(clipIn(step.next, x.id).speed) * 100)}%  ·  00:00:04:00`)
  })

  it('trims and reads out the edge', () => {
    const { x, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: x.id, edge: 'out', ripple: false, solo: false }, 5)
    expect(clipIn(step.next, x.id).outS).toBe(5)
    expect(step.tip).toBe('00:00:05:00  -00:01:00 / -30f')
  })

  it('reads out a ripple in-trim as the source edge', () => {
    const { x, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: x.id, edge: 'in', ripple: true, solo: false }, 4.5)
    expect(step.tip?.startsWith('Ripple  ')).toBe(true)
  })

  it('reads out a trim into the neighbour as a crossfade', () => {
    const { w, seq } = linkedFixture()
    const step = trimStep(seq, ASSETS, { kind: 'trim', clipId: w.id, edge: 'out', ripple: false, solo: false }, 5)
    expect(step.tip).toBe('Crossfade  00:00:01:00')
  })
})

describe('dragCommit', () => {
  const { v, w, x, a, seq } = linkedFixture()
  const final = { trackId: '', tS: 4.5 }

  it('names a move by how many travel and commits moveSelectionWith', () => {
    const drag = {
      kind: 'move' as const,
      clipId: x.id,
      grabOffsetS: 0,
      trackKind: 'video' as const,
      downClientX: 0,
      downClientY: 0,
      others: [],
      collapseCandidate: false,
      solo: true,
    }
    const target = { trackId: seq.tracks[0].id, tS: 8 }
    const c = dragCommit(drag, target, seq, ASSETS)!
    expect(c.label).toBe('Move clip')
    expect(c.apply(seq)).toEqual(moveSelectionWith(seq, x.id, target.trackId, 8, [], true))
    expect(dragCommit({ ...drag, others: [{ id: v.id, startS0: 0 }] }, target, seq, ASSETS)!.label).toBe('Move clips')
  })

  it('labels a trim, a ripple trim and a trim that became a crossfade', () => {
    const trim = { kind: 'trim' as const, clipId: x.id, edge: 'out' as const, ripple: false, solo: false }
    expect(dragCommit(trim, final, seq, ASSETS)!.label).toBe('Trim clip')
    expect(dragCommit({ ...trim, ripple: true }, final, seq, ASSETS)!.label).toBe('Ripple trim')
    expect(dragCommit({ ...trim, clipId: w.id }, { trackId: '', tS: 5 }, seq, ASSETS)!.label).toBe('Crossfade')
  })

  it('commits the same edit the preview showed for every edge gesture', () => {
    const cases: [Drag, string][] = [
      [{ kind: 'stretch', clipId: x.id, edge: 'out' }, 'Rate stretch'],
      [{ kind: 'slip', clipId: w.id, startXPx: 0, solo: true }, 'Slip clip'],
      [{ kind: 'roll', leftId: w.id, rightId: x.id }, 'Roll edit'],
      [{ kind: 'slide', clipId: w.id, grabOffsetS: 0, neighborIds: [v.id, x.id] }, 'Slide clip'],
    ]
    for (const [drag, label] of cases) {
      const c = dragCommit(drag, final, seq, ASSETS)!
      expect(c.label).toBe(label)
      expect(c.apply(seq)).not.toBe(seq)
    }
    expect(dragCommit(cases[1][0], { trackId: '', tS: -1 }, seq, ASSETS)!.apply(seq)).toEqual(slipClip(seq, ASSETS, w.id, -1))
    expect(a.id).toBeTruthy()
  })

  it('commits nothing for scrub, hand and marquee', () => {
    expect(dragCommit({ kind: 'scrub' }, final, seq, ASSETS)).toBeNull()
    expect(dragCommit({ kind: 'hand', startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 }, final, seq, ASSETS)).toBeNull()
    expect(dragCommit({ kind: 'marquee', x0: 0, y0: 0, additive: false, base: [] }, final, seq, ASSETS)).toBeNull()
  })
})
