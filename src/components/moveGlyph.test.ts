// THE ACCEPTANCE TEST FOR THE SHELF, written down.
//
// Cover the labels and a person still has to be able to tell the ten tiles
// apart. That is not a taste question, it is a property of the drawing, so it
// gets asserted here rather than judged off a screenshot: every tile's picture
// is compared with every other tile's picture, and two that come out the same
// fail the file.
//
// The second thing this pins is that the pictures come out of the MOVE TABLE and
// nothing else. Every "follows the numbers" test below hands shelfGlyphs a table
// with one number changed and checks the picture moved with it, which is the one
// guarantee a hand drawn set of icons could never give and the reason the shelf
// was rejected the first time.

import { describe, expect, it } from 'vitest'

import { MOVES, MOVE_BY_ID, type Beat, type MoveDef, type MoveId } from '../engine/moves'
import { shelfGlyphs, type MoveGlyph } from './moveGlyph'

/** His format: a 9:16 Short, which is the smallest tile the shelf ever draws. */
const TALL = { w: 38, h: 68 }
/** A wide project, where the same picture has to hold up in a short box. */
const WIDE = { w: 78, h: 44 }
const TAPE_H = 11
const DEPTH = 1.2
const RISE = 5

const shelf = (moves: readonly MoveDef[] = MOVES, depth = DEPTH, stage = TALL): Map<MoveId, MoveGlyph> => {
  const out = shelfGlyphs(moves, depth, RISE, stage, TAPE_H)
  return new Map(out.glyphs.map((g) => [g.id, g]))
}

const tile = (id: MoveId, moves: readonly MoveDef[] = MOVES, depth = DEPTH, stage = TALL): MoveGlyph => {
  const g = shelf(moves, depth, stage).get(id)
  if (!g) throw new Error(`no glyph for ${id}`)
  return g
}

/** What the eye gets off the top pane: the rectangles, the route and the arrow. */
const stageOf = (g: MoveGlyph): string => JSON.stringify({ marks: g.marks, route: g.route, head: g.head })
/** And off the bottom one: the depth curve and the moments standing on it. */
const tapeOf = (g: MoveGlyph): string => JSON.stringify({ line: g.tapeLine, beats: g.beats })
const wholeOf = (g: MoveGlyph): string => `${stageOf(g)}|${tapeOf(g)}`

/** The last rectangle a tile draws is always where the move ENDS up. */
const endRect = (g: MoveGlyph) => g.marks[g.marks.length - 1].rect

/**
 * ⛔ THE COUNT WAS NEVER THE POINT, AND IT USED TO BE WRITTEN AS IF IT WERE.
 *
 * These read `toHaveLength(10)` while there were exactly ten moves, so the two
 * statements looked the same. He asked for zoom-out presets on 2026-08-15 and
 * there are thirteen now. The invariant that matters is that NO TWO TILES DRAW
 * THE SAME PICTURE, whatever the shelf holds, and stated that way it gets
 * harder every time a move is added rather than needing an edit.
 */
describe('cover the labels and every tile is still its own picture', () => {
  for (const stage of [TALL, WIDE]) {
    it(`draws no two tiles the same at ${stage.w}x${stage.h}`, () => {
      const glyphs = [...shelf(MOVES, DEPTH, stage).values()]
      expect(glyphs).toHaveLength(MOVES.length)
      const seen = new Map<string, MoveId>()
      for (const g of glyphs) {
        const key = wholeOf(g)
        const clash = seen.get(key)
        expect(clash, `${g.id} draws exactly what ${clash} draws`).toBeUndefined()
        seen.set(key, g.id)
      }
    })
  }

  /**
   * EVERY assertion in this file is about the STILL picture, which is what
   * someone who has asked their system for less motion gets and what everyone
   * else gets for the 99 percent of the time the pointer is somewhere else. The
   * hover loop adds nothing to it and takes nothing away.
   */
  it('gives every tile something to draw standing still', () => {
    for (const g of shelf().values()) {
      expect(g.marks.length, g.id).toBeGreaterThanOrEqual(1)
      expect(g.marks[g.marks.length - 1].kind).toBe('to')
      expect(g.tapeLine, g.id).not.toBe('')
    }
  })

  /**
   * The division of labour, pinned. Some moves end up in the same place from the
   * same place, so the top pane CANNOT tell those apart and is not asked to:
   * they differ in WHEN, and the tape is what says when. If someone ever decides
   * the tape is decoration and deletes it, this fails and names the pair it
   * broke.
   */
  it('never leans on the stage alone, so any two tiles that share one differ on the tape', () => {
    const glyphs = [...shelf().values()]
    for (let i = 0; i < glyphs.length; i++) {
      for (let j = i + 1; j < glyphs.length; j++) {
        if (stageOf(glyphs[i]) !== stageOf(glyphs[j])) continue
        expect(
          tapeOf(glyphs[i]),
          `${glyphs[i].id} and ${glyphs[j].id} share a stage, so the tape is all that is left`,
        ).not.toBe(tapeOf(glyphs[j]))
      }
    }
    // And that loop really has work to do: Push in and Punch in arrive in the
    // same place from the same place and differ only in how fast they get there.
    expect(stageOf(tile('pushIn'))).toBe(stageOf(tile('punchIn')))
    expect(tapeOf(tile('pushIn'))).not.toBe(tapeOf(tile('punchIn')))
  })

  /** And the mirror pair, which the tape cannot separate, is separated by the stage. */
  it('leans on the stage for the two travelling moves that share a tape', () => {
    expect(tapeOf(tile('leftThenRight'))).toBe(tapeOf(tile('rightThenLeft')))
    expect(stageOf(tile('leftThenRight'))).not.toBe(stageOf(tile('rightThenLeft')))
  })
})

describe('which way a move goes is drawn, not implied', () => {
  it('points the arrow the way the picture actually travels', () => {
    expect(tile('leftThenRight').travel?.x).toBeGreaterThan(0)
    expect(tile('rightThenLeft').travel?.x).toBeLessThan(0)
    expect(tile('driftRight').travel?.x).toBeGreaterThan(0)
    for (const g of [tile('leftThenRight'), tile('rightThenLeft'), tile('driftRight')]) {
      expect(g.head, g.id).not.toBe('')
      expect(g.route, g.id).not.toBe('')
    }
  })

  it('draws no arrow on a move that never goes anywhere', () => {
    for (const id of ['none', 'holdBig', 'pushIn', 'punchIn', 'inAndOut', 'pop', 'shake'] as MoveId[]) {
      const g = tile(id)
      expect(g.travel, `${id} does not travel`).toBeNull()
      expect(g.head, id).toBe('')
      expect(g.route, id).toBe('')
    }
  })

  it('makes the widest journey on the shelf worth looking at, and keeps it inside the tile', () => {
    for (const stage of [TALL, WIDE]) {
      const widest = Math.max(
        ...[...shelf(MOVES, DEPTH, stage).values()].map((g) => Math.abs(g.travel?.x ?? 0)),
      )
      expect(widest, 'a journey nobody can see is not a journey').toBeGreaterThan(stage.w * 0.3)
      expect(widest).toBeLessThanOrEqual(stage.w)
    }
  })
})

describe('nothing a tile draws leaves its own box', () => {
  it('holds every rectangle inside the stage at every depth he can pick', () => {
    for (const stage of [TALL, WIDE]) {
      for (const depth of [1.05, 1.1, 1.2, 1.4, 1.7, 2]) {
        for (const g of shelf(MOVES, depth, stage).values()) {
          for (const m of g.marks) {
            const where = `${g.id} ${m.kind} at ${depth} in ${stage.w}x${stage.h}`
            expect(m.rect.x, where).toBeGreaterThanOrEqual(0)
            expect(m.rect.y, where).toBeGreaterThanOrEqual(0)
            expect(m.rect.x + m.rect.w, where).toBeLessThanOrEqual(stage.w)
            expect(m.rect.y + m.rect.h, where).toBeLessThanOrEqual(stage.h)
            expect(m.rect.w, where).toBeGreaterThan(0)
            expect(m.rect.h, where).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('keeps every tick on the tape', () => {
    for (const g of shelf().values()) {
      for (const b of g.beats) {
        expect(b.x, g.id).toBeGreaterThanOrEqual(0)
        expect(b.x, g.id).toBeLessThanOrEqual(100)
        expect(b.y1, g.id).toBeGreaterThanOrEqual(0)
        expect(b.y2, g.id).toBeLessThanOrEqual(TAPE_H)
      }
    }
  })
})

describe('the moments on the tape belong to the move', () => {
  it('draws one tick for every beat the builder actually writes', () => {
    for (const def of MOVES) {
      expect(tile(def.id).beats, def.id).toHaveLength(def.beats.length)
    }
    // Stated separately so the two ends of the table are named out loud: None
    // does nothing and gets nothing, Hold big is one lone keyframe that holds.
    expect(tile('none').beats).toHaveLength(0)
    expect(tile('holdBig').beats).toHaveLength(1)
    expect(tile('none').still).toBe(true)
    for (const def of MOVES) {
      if (def.id !== 'none') expect(tile(def.id).still, def.id).toBe(false)
    }
  })

  it('puts both moments of a punch at the head of the tape, and a push at both ends', () => {
    const punch = tile('punchIn').beats.map((b) => Math.round(b.x))
    const push = tile('pushIn').beats.map((b) => Math.round(b.x))
    expect(punch[0]).toBe(0)
    expect(punch[1], 'a punch is over in the first fifth of its own tile').toBeLessThan(20)
    expect(push[0]).toBe(0)
    expect(push[1], 'a push takes the whole clip').toBe(100)
  })
})

describe('a tile follows the numbers, because it is drawn from them', () => {
  /** One move swapped for a changed copy of itself, the rest of the shelf untouched. */
  const swap = (id: MoveId, beats: readonly Beat[]): MoveDef[] =>
    MOVES.map((m) => (m.id === id ? { ...m, beats } : m))

  it('draws a shallower Push in as a shallower Push in', () => {
    const before = tile('pushIn')
    const shallow = swap(
      'pushIn',
      MOVE_BY_ID.pushIn.beats.map((b, i) => (i === 1 ? { ...b, d: 0.4 } : b)),
    )
    const after = tile('pushIn', shallow)
    // Less zoom means MORE of the frame is still on screen, so the rectangle the
    // move ends on is bigger. Nothing else in the file had to be told.
    expect(endRect(after).w).toBeGreaterThan(endRect(before).w + 1)
    expect(endRect(after).h).toBeGreaterThan(endRect(before).h + 1)
  })

  it('shortens the journey when the move stops aiming so far off centre', () => {
    const tamed = swap(
      'leftThenRight',
      MOVE_BY_ID.leftThenRight.beats.map((b) => ({
        ...b,
        aim: { x: 0.5 + (b.aim.x - 0.5) * 0.4, y: b.aim.y },
      })),
    )
    const ltr = tile('leftThenRight', tamed)
    const rtl = tile('rightThenLeft', tamed)
    expect(Math.abs(ltr.travel?.x ?? 0)).toBeLessThan(Math.abs(rtl.travel?.x ?? 0) * 0.6)
    // And it still points the right way: a smaller move, not a different one.
    expect(ltr.travel?.x).toBeGreaterThan(0)
  })

  it('grows a tick when the move grows a moment', () => {
    const extra: Beat = { at: { frac: 0.5 }, d: 0.6, aim: { x: 0.5, y: 0.5 }, curve: 'smooth' }
    const withBeat = swap('pushIn', [MOVE_BY_ID.pushIn.beats[0], extra, MOVE_BY_ID.pushIn.beats[1]])
    expect(tile('pushIn', withBeat).beats).toHaveLength(tile('pushIn').beats.length + 1)
    expect(tapeOf(tile('pushIn', withBeat))).not.toBe(tapeOf(tile('pushIn')))
  })
})

describe('dragging How big moves the number, not the pictures', () => {
  /**
   * Deliberate. The tiles are drawn against the depth he has chosen, so a beat
   * at d = 1 fills the range at 110 percent and at 200 percent alike, and the
   * ten stay comparable with each other while he drags. The magnitude he is
   * choosing is on the readout, in percent, which is where a number belongs.
   */
  it('keeps the depth curve and the rectangle sizes the same at every depth', () => {
    for (const def of MOVES) {
      const a = tile(def.id, MOVES, 1.1)
      const b = tile(def.id, MOVES, 1.9)
      expect(a.tapeLine, def.id).toBe(b.tapeLine)
      expect(endRect(a).w, def.id).toBeCloseTo(endRect(b).w, 6)
      expect(endRect(a).h, def.id).toBeCloseTo(endRect(b).h, 6)
    }
  })

  /** The travel is the one thing that does move, because a deeper zoom really does carry the picture further. */
  it('still tells every tile apart at both ends of the slider', () => {
    for (const depth of [1.05, 2]) {
      const keys = new Set([...shelf(MOVES, depth).values()].map(wholeOf))
      expect(keys.size, `at ${depth}`).toBe(MOVES.length)
    }
  })
})
