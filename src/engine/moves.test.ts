// The move table is the product, so this file holds it to the two things a
// finished move has to be: exactly the keyframes the design specifies, and safe
// on every clip length and every depth the shelf can reach.
//
// The edge sweep at the bottom is the important one. A move that shifts the
// picture further than the zoom it paid for shows the black behind his footage,
// and it would show it on ONE clip length at ONE depth, which is exactly the
// kind of thing nobody finds by clicking around.

import { describe, expect, it } from 'vitest'
import { channelBase, channelKeyframes, resolveChannel } from './effects/channels'
import {
  MOVES,
  MOVE_BY_ID,
  applyMove,
  clearMoveChannels,
  matchMove,
  moveBeatTimes,
  moveByDigit,
  moveSamples,
  type MoveDef,
} from './moves'
import { defaultTitleDef, newTitleClip, type Clip } from './types'

const FPS = 30
const W = 1920
const H = 1080
const DEPTH = 1.2
const RISE = 5

/** A clip of `durS` seconds sitting at 0, at its own natural framing. */
const seed = (durS: number): Clip => newTitleClip(defaultTitleDef('x'), 0, durS)

const build = (id: keyof typeof MOVE_BY_ID, durS: number, over?: Partial<{ depth: number; startS: number; endS: number }>): Clip =>
  applyMove(seed(durS), FPS, MOVE_BY_ID[id], {
    depth: over?.depth ?? DEPTH,
    riseFrames: RISE,
    seqWidth: W,
    seqHeight: H,
    startS: over?.startS,
    endS: over?.endS,
  })

/** Same as build, given the def itself: the sweeps walk MOVES and already hold it. */
const buildDef = (def: MoveDef, durS: number, over?: Partial<{ depth: number; startS: number; endS: number }>): Clip =>
  applyMove(seed(durS), FPS, def, {
    depth: over?.depth ?? DEPTH,
    riseFrames: RISE,
    seqWidth: W,
    seqHeight: H,
    startS: over?.startS,
    endS: over?.endS,
  })

const keys = (clip: Clip, channel: 'scale' | 'posX' | 'posY') => channelKeyframes(clip, channel)

describe('the table itself', () => {
  /**
   * ⛔ THE TEN IN HIS HANDS KEEP THEIR KEYS, FOREVER.
   *
   * This used to read `expect(MOVES).toHaveLength(10)`, which was the same
   * statement while there were exactly ten. There are more now, because he asked
   * for zoom-out presets on 2026-08-15, and there are still only ten digits. So
   * the invariant is stated as what it always meant: every digit 0 to 9 picks
   * exactly one move, no digit is shared, and a move added later is shelf-only
   * rather than renumbering something already under his fingers.
   */
  it('gives every digit 0 to 9 exactly one move, and never two', () => {
    for (let d = 0; d <= 9; d++) expect(moveByDigit(d)?.digit, `digit ${d}`).toBe(d)
    const digits = MOVES.map((m) => m.digit).filter((d) => d !== undefined)
    expect(new Set(digits).size, 'no digit is shared').toBe(digits.length)
    expect(digits).toHaveLength(10)
  })

  /**
   * Both edge invariants, stated as table rules rather than only measured
   * downstream: a move never shrinks the picture below the framing the clip
   * already has, and never aims outside the middle 44 percent of the frame.
   */
  it('keeps every depth inside 0..1 and every aim inside 0.28..0.72', () => {
    for (const move of MOVES) {
      for (const beat of move.beats) {
        expect(beat.d).toBeGreaterThanOrEqual(0)
        expect(beat.d).toBeLessThanOrEqual(1)
        expect(beat.aim.x).toBeGreaterThanOrEqual(0.28)
        expect(beat.aim.x).toBeLessThanOrEqual(0.72)
        expect(beat.aim.y).toBeGreaterThanOrEqual(0.28)
        expect(beat.aim.y).toBeLessThanOrEqual(0.72)
      }
    }
  })

  /**
   * A window that fills the clip has to START at the window start and END at the
   * window end, because that is what lets matchMove read the window back off the
   * keyframes instead of storing it. Store it and a hand edit makes it lie.
   */
  it('anchors every clip-length move to both ends of its window', () => {
    for (const move of MOVES) {
      if (move.window !== 'clip') continue
      expect(move.beats[0].at).toEqual({ frames: 0 })
      expect(move.beats[move.beats.length - 1].at).toEqual({ fromEnd: 0 })
    }
  })

  it('reaches full depth in every move, so the depth reads back off the keyframes', () => {
    for (const move of MOVES) {
      if (move.beats.length === 0) continue
      expect(Math.max(...move.beats.map((b) => b.d))).toBe(1)
    }
  })

  it('never uses the overshoot curve, which dips below the target on the way down', () => {
    for (const move of MOVES) for (const beat of move.beats) expect(beat.curve).not.toBe('overshoot')
  })
})

describe('his sentence: Left, then right', () => {
  /**
   * THE EXACT OUTPUT, on the measurement's own assumptions: a 20 second clip at
   * 30fps on 1920x1080, 120 percent deep, a 5 frame rise, base framing untouched.
   * Six moments, three channels, eighteen keyframes.
   */
  it('writes the six moments the design specifies, to the number', () => {
    const out = build('leftThenRight', 20)
    const scale = keys(out, 'scale')
    const x = keys(out, 'posX')
    const y = keys(out, 'posY')
    expect(scale).toHaveLength(6)
    expect(x).toHaveLength(6)
    expect(y).toHaveLength(6)

    const t = scale.map((k) => k.t)
    expect(t[0]).toBeCloseTo(0, 6)
    expect(t[1]).toBeCloseTo(5 / 30, 6)
    expect(t[2]).toBeCloseTo(6, 6)
    expect(t[3]).toBeCloseTo(14.4, 6)
    expect(t[4]).toBeCloseTo(20 - 5 / 30, 6)
    expect(t[5]).toBeCloseTo(20, 6)

    expect(scale.map((k) => k.value)).toEqual([1, 1.2, 1.2, 1.2, 1.2, 1].map((v) => expect.closeTo(v, 6)))
    expect(x.map((k) => k.value)).toEqual([0, 84.48, 84.48, -84.48, -84.48, 0].map((v) => expect.closeTo(v, 4)))
    expect(y.map((k) => k.value)).toEqual([0, 10.8, 10.8, 10.8, 10.8, 0].map((v) => expect.closeTo(v, 4)))

    // The curves come out of the ONE table, and the ease under each is its
    // shipped partner. The last keyframe terminates linear: there is no segment
    // leaving it to shape.
    expect(scale[0].curve).toEqual([0.16, 1, 0.3, 1])
    expect(scale[0].ease).toBe('easeOut')
    expect(scale[1].curve).toBeUndefined()
    expect(scale[2].curve).toEqual([0.37, 0, 0.63, 1])
    expect(scale[2].ease).toBe('easeInOut')
    expect(scale[4].curve).toEqual([0.16, 1, 0.3, 1])
    expect(scale[5].curve).toBeUndefined()
    expect(scale[5].ease).toBe('linear')
  })

  /** The 9:16 numbers, because that is the only shape he actually publishes. */
  it('lands the same move on a vertical sequence', () => {
    const out = applyMove(seed(20), FPS, MOVE_BY_ID.leftThenRight, {
      depth: DEPTH,
      riseFrames: RISE,
      seqWidth: 1080,
      seqHeight: 1920,
    })
    expect(keys(out, 'posX')[1].value).toBeCloseTo(47.52, 4)
    expect(keys(out, 'posY')[1].value).toBeCloseTo(19.2, 4)
  })

  /**
   * THE HOLD, which is the beat the old build could not tell him he needed. The
   * picture has to SIT on the left after the punch lands, not start creeping
   * right the instant it arrives.
   */
  it('holds on the left before it travels, and holds on the right before it leaves', () => {
    const out = build('leftThenRight', 20)
    expect(resolveChannel(out, 'posX', 1)).toBeCloseTo(84.48, 4)
    expect(resolveChannel(out, 'posX', 5.9)).toBeCloseTo(84.48, 4)
    // Travelling by the middle of the sweep, and arrived by the end of it.
    expect(resolveChannel(out, 'posX', 10)).toBeLessThan(60)
    expect(resolveChannel(out, 'posX', 14.4)).toBeCloseTo(-84.48, 4)
    expect(resolveChannel(out, 'posX', 19)).toBeCloseTo(-84.48, 4)
    // And home on the last frame, both channels, exactly.
    expect(resolveChannel(out, 'posX', 20)).toBeCloseTo(0, 6)
    expect(resolveChannel(out, 'scale', 20)).toBeCloseTo(1, 6)
  })

  it('is the mirror of Right, then left', () => {
    const a = keys(build('leftThenRight', 6), 'posX').map((k) => k.value)
    const b = keys(build('rightThenLeft', 6), 'posX').map((k) => k.value)
    expect(a.map((v) => -v)).toEqual(b.map((v) => expect.closeTo(v, 6)))
  })
})

describe('applying a move', () => {
  it('REPLACES whatever was there: a second tile never stacks onto the first', () => {
    const first = build('leftThenRight', 6)
    const second = applyMove(first, FPS, MOVE_BY_ID.punchIn, {
      depth: DEPTH,
      riseFrames: RISE,
      seqWidth: W,
      seqHeight: H,
    })
    expect(keys(second, 'scale')).toHaveLength(2)
    // Punch in is dead centre, so it leaves no position lanes behind at all.
    expect(keys(second, 'posX')).toHaveLength(0)
    expect(keys(second, 'posY')).toHaveLength(0)
  })

  it('keeps the clip its own size: None clears the move and leaves the framing alone', () => {
    const scaled = { ...seed(6), transform: { ...seed(6).transform, scale: 1.5, x: 40 } }
    const moved = applyMove(scaled, FPS, MOVE_BY_ID.pushIn, {
      depth: DEPTH,
      riseFrames: RISE,
      seqWidth: W,
      seqHeight: H,
    })
    // The move is built ON the clip's own framing, not on 100 percent.
    expect(keys(moved, 'scale')[1].value).toBeCloseTo(1.5 * 1.2, 6)
    const cleared = applyMove(moved, FPS, MOVE_BY_ID.none, {
      depth: DEPTH,
      riseFrames: RISE,
      seqWidth: W,
      seqHeight: H,
    })
    expect(keys(cleared, 'scale')).toHaveLength(0)
    expect(channelBase(cleared, 'scale')).toBeCloseTo(1.5, 6)
    expect(channelBase(cleared, 'posX')).toBeCloseTo(40, 6)
  })

  /**
   * Hold big is ONE keyframe on purpose. A lone keyframe holds everywhere, which
   * is what the move means, and unlike a static size it can be taken back off
   * with None, which a static one silently could not.
   */
  it('writes Hold big as a single keyframe that None can remove again', () => {
    const held = build('holdBig', 4)
    expect(keys(held, 'scale')).toHaveLength(1)
    expect(resolveChannel(held, 'scale', 0)).toBeCloseTo(DEPTH, 6)
    expect(resolveChannel(held, 'scale', 3.99)).toBeCloseTo(DEPTH, 6)
    expect(keys(clearMoveChannels(held), 'scale')).toHaveLength(0)
  })

  it('snaps every moment onto the frame grid', () => {
    for (const move of MOVES) {
      const out = buildDef(move, 3.37)
      for (const k of keys(out, 'scale')) expect(k.t * FPS).toBeCloseTo(Math.round(k.t * FPS), 6)
    }
  })

  /**
   * A move on a clip too short to hold all of it drops the beats that cannot
   * clear a frame, rather than stacking six diamonds on one pixel. What survives
   * is still a real move that comes home at the end.
   */
  it('degrades on a clip far too short for it', () => {
    const out = build('leftThenRight', 0.4)
    const scale = keys(out, 'scale')
    expect(scale.length).toBeGreaterThanOrEqual(2)
    expect(scale.length).toBeLessThan(6)
    for (let i = 1; i < scale.length; i++) expect(scale[i].t - scale[i - 1].t).toBeGreaterThanOrEqual(1 / FPS - 1e-9)
    // It still ends where it started: on the clip's own framing, on the last frame.
    expect(scale[scale.length - 1].value).toBeCloseTo(1, 6)
    expect(scale[scale.length - 1].t).toBeCloseTo(0.4, 6)
  })

  it('takes a window, so a move can run over part of a clip', () => {
    const out = build('leftThenRight', 20, { startS: 3, endS: 9 })
    const scale = keys(out, 'scale')
    expect(scale[0].t).toBeCloseTo(3, 6)
    expect(scale[scale.length - 1].t).toBeCloseTo(9, 6)
    // The snap is still five frames. Only the holds and the travel stretch.
    expect(scale[1].t - scale[0].t).toBeCloseTo(5 / FPS, 6)
  })
})

/**
 * The zoom-independent shift, added 2026-08-15 so a move he RECORDS can hold a
 * path the built-in ten cannot express. His ask: *"I want it to be just like the
 * built-in ten."*
 *
 * ⛔ THE FIRST TEST IS THE ONE THAT MATTERS. The ten in his hands, and every
 * project already on his disk, must build byte for byte what they always did.
 * They do that by never setting `shift`, so the new term is multiplied by
 * nothing. Assert the premise rather than trusting it: a beat that quietly
 * gained a shift would move thousands of frames that nobody would look at.
 */
describe('a beat can carry a shift that does not depend on the zoom', () => {
  const ctx = { riseFrames: RISE, seqWidth: W, seqHeight: H }

  it('⛔ NO BUILT-IN MOVE SETS ONE, so all of them are unchanged', () => {
    for (const move of MOVES) {
      for (const beat of move.beats) {
        expect(beat.shift, `${move.id} gained a shift`).toBeUndefined()
      }
    }
  })

  it('writing zero is the same as writing nothing', () => {
    const withNone: MoveDef = { ...MOVE_BY_ID.pushIn, id: 'pushIn' }
    const withZero: MoveDef = {
      ...withNone,
      beats: withNone.beats.map((b) => ({ ...b, shift: { x: 0, y: 0 } })),
    }
    const a = applyMove(seed(4), FPS, withNone, { depth: DEPTH, ...ctx })
    const b = applyMove(seed(4), FPS, withZero, { depth: DEPTH, ...ctx })
    expect(keys(b, 'scale')).toEqual(keys(a, 'scale'))
    expect(keys(b, 'posX')).toEqual(keys(a, 'posX'))
  })

  /**
   * ⛔ THE WHOLE REASON IT EXISTS: travel at NORMAL SIZE. `aim` is multiplied by
   * how far the zoom is from normal, so a move that never zooms can never pan
   * through `aim`, however the aim is written. This is that move.
   */
  it('carries a pan at depth 1, which aim alone cannot do at all', () => {
    const slide: MoveDef = {
      id: 'pushIn',
      name: 'x',
      hint: 'x',
      window: 'clip',
      beats: [
        { at: { frames: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, shift: { x: -0.1, y: 0 }, curve: 'linear' },
        { at: { fromEnd: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, shift: { x: 0.1, y: 0 }, curve: 'linear' },
      ],
    }
    // depth 1 means r is 1 everywhere, so travel is 0 and aim contributes nothing.
    const out = applyMove(seed(4), FPS, slide, { depth: 1, ...ctx })
    const xs = keys(out, 'posX')
    expect(xs, 'a pan with no zoom must still be written').toHaveLength(2)
    expect(xs[1].value - xs[0].value).toBeCloseTo(0.2 * W, 6)
    // And it really did not zoom: a flat scale lane is dropped entirely.
    expect(keys(out, 'scale')).toHaveLength(0)
  })

  it('adds to the aim rather than replacing it, when a move uses both', () => {
    const both: MoveDef = {
      id: 'pushIn',
      name: 'x',
      hint: 'x',
      window: 'clip',
      beats: [
        { at: { frames: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, curve: 'linear' },
        { at: { fromEnd: 0 }, d: 1, aim: { x: 0.3, y: 0.5 }, shift: { x: 0.05, y: 0 }, curve: 'linear' },
      ],
    }
    const out = applyMove(seed(4), FPS, both, { depth: DEPTH, ...ctx })
    const last = keys(out, 'posX')[1]
    const aimPart = -((0.3 - 0.5) * W) * Math.abs(DEPTH - 1)
    expect(last.value).toBeCloseTo(aimPart + 0.05 * W, 4)
  })
})

describe('matchMove: the lit tile is worked out, never remembered', () => {
  it('names every move back, at any length and any depth', () => {
    for (const move of MOVES) {
      for (const durS of [0.6, 2, 6, 20]) {
        for (const depth of [1.1, 1.2, 1.7]) {
          const out = buildDef(move, durS, { depth })
          const found = matchMove(out, FPS, { riseFrames: RISE, seqWidth: W, seqHeight: H })
          expect(found?.id, `${move.id} @ ${durS}s x${depth}`).toBe(move.id)
          if (move.beats.length > 0) expect(found?.depth).toBeCloseTo(depth, 4)
        }
      }
    }
  })

  it('says None on a clip with no move at all', () => {
    expect(matchMove(seed(5), FPS, { seqWidth: W, seqHeight: H })?.id).toBe('none')
  })

  /** One diamond moved by hand and no tile is lit. The shelf cannot lie. */
  it('goes blank the moment a keyframe is edited by hand', () => {
    const out = build('leftThenRight', 20)
    const scale = [...keys(out, 'scale')]
    scale[2] = { ...scale[2], t: scale[2].t + 0.5 }
    const hand: Clip = { ...out, keyframes: { ...out.keyframes, scale } }
    expect(matchMove(hand, FPS, { riseFrames: RISE, seqWidth: W, seqHeight: H })).toBeNull()
  })

  /**
   * ⛔ AND IT GOES BLANK AT 60 FPS TOO, WHICH IT DID NOT. His footage IS 60.
   *
   * The tolerance was hardcoded to 1/60 under a comment claiming "half a frame
   * at 30fps". At 60 that is a WHOLE frame, so nudging a diamond by the smallest
   * amount the app can express left the tile lit, still claiming the clip held
   * the untouched preset while the picture on screen said otherwise. Audit item
   * 7, 2026-08-14. Both rates are pinned here so a future edit cannot quietly
   * make one of them right at the other's expense.
   */
  it('goes blank on a ONE FRAME hand retime, at 30 and at 60', () => {
    for (const fps of [30, 60]) {
      const out = applyMove(seed(20), fps, MOVE_BY_ID.leftThenRight, {
        depth: DEPTH,
        riseFrames: RISE,
        seqWidth: W,
        seqHeight: H,
      })
      const ctx = { riseFrames: RISE, seqWidth: W, seqHeight: H }
      expect(matchMove(out, fps, ctx)?.id, `untouched @ ${fps}`).toBe('leftThenRight')

      const scale = [...keys(out, 'scale')]
      scale[2] = { ...scale[2], t: scale[2].t + 1 / fps }
      const hand: Clip = { ...out, keyframes: { ...out.keyframes, scale } }
      expect(matchMove(hand, fps, ctx), `one frame moved @ ${fps}`).toBeNull()
    }
  })

  /** Retiming the WINDOW is a parameter of the move, not a hand edit. */
  it('still names a move whose window was dragged in from both ends', () => {
    const out = build('leftThenRight', 20, { startS: 4, endS: 12 })
    const found = matchMove(out, FPS, { riseFrames: RISE, seqWidth: W, seqHeight: H })
    expect(found?.id).toBe('leftThenRight')
    expect(found?.startS).toBeCloseTo(4, 6)
    expect(found?.endS).toBeCloseTo(12, 6)
  })
})

describe('no move can ever show the edge of his footage', () => {
  /**
   * The sweep. Every move, every depth the slider reaches, every clip length,
   * resolved through the SAME resolveChannel preview and export read, at 240
   * points across the clip.
   *
   * The rule is the geometry: a frame scaled by s has (s-1)/2 of its width spare
   * on each side, so a shift bigger than W(s-1)/2 puts black on screen.
   */
  it('holds |shift| under the room the zoom made, at every depth and every length', () => {
    const depths = [1.05, 1.1, 1.2, 1.4, 1.7, 2]
    // MEASURED 2026-08-12: this one test was 1,658 ms of the file's 1,700 ms, and
    // under a full parallel run it reached 5,376 ms against a 5,000 ms budget, so
    // it went red in his ship path on untouched code. The sweep is 57,840 sample
    // points and it was calling expect() three times at each one: the geometry is
    // nothing and the matcher is everything. Comparing in plain JS and reporting
    // at the end keeps every point, every tolerance and a better message, since
    // this now names every offender instead of dying on the first.
    // The alternative was raising the timeout, which is widening a budget to hide
    // a slow instrument rather than fixing it.
    const failures: string[] = []
    for (const move of MOVES) {
      for (const durS of [0.4, 2, 6, 20]) {
        for (const depth of depths) {
          const out = buildDef(move, durS, { depth })
          for (let i = 0; i <= 240; i++) {
            const t = (i / 240) * durS
            const s = resolveChannel(out, 'scale', t)
            const x = resolveChannel(out, 'posX', t)
            const y = resolveChannel(out, 'posY', t)
            const roomX = (W * (s - 1)) / 2 + 1e-6
            const roomY = (H * (s - 1)) / 2 + 1e-6
            if (s >= 1 - 1e-9 && Math.abs(x) <= roomX && Math.abs(y) <= roomY) continue
            const where = `${move.id} ${durS}s x${depth} @${t.toFixed(3)}`
            if (s < 1 - 1e-9) failures.push(`${where}: scale ${s} is under 1`)
            if (Math.abs(x) > roomX) failures.push(`${where}: posX ${x} needs ${roomX}`)
            if (Math.abs(y) > roomY) failures.push(`${where}: posY ${y} needs ${roomY}`)
          }
        }
      }
    }
    expect(failures.slice(0, 12), 'a move showed the edge of his footage').toEqual([])
  })
})

describe('the little picture on a tile', () => {
  it('samples the move through the renderer, and stays inside the frame', () => {
    for (const move of MOVES) {
      const samples = moveSamples(move, DEPTH, RISE, 24)
      expect(samples).toHaveLength(25)
      for (const s of samples) {
        expect(s.scale).toBeGreaterThanOrEqual(1 - 1e-9)
        expect(Math.abs(s.dx)).toBeLessThanOrEqual((s.scale - 1) / 2 + 1e-9)
        expect(Math.abs(s.dy)).toBeLessThanOrEqual((s.scale - 1) / 2 + 1e-9)
      }
    }
  })

  it('actually moves for every move except None', () => {
    for (const move of MOVES) {
      const spread = moveSamples(move, DEPTH, RISE, 24).map((s) => s.scale + Math.abs(s.dx))
      const moved = Math.max(...spread) - Math.min(...spread)
      if (move.id === 'none') expect(moved).toBeCloseTo(0, 9)
      else if (move.id !== 'holdBig') expect(moved).toBeGreaterThan(0.05)
    }
  })
})

describe('the moments a tile marks', () => {
  it('gives every move on the shelf every beat it has, at the tile length', () => {
    // The tile draws a tick per moment, so a beat quietly dropped for want of a
    // frame of daylight would be a tile that lies about the move. At the tile's
    // own length nothing is dropped, and this is where that is held.
    for (const move of MOVES) {
      const { durS, timesS } = moveBeatTimes(move, DEPTH, RISE)
      expect(timesS, move.id).toHaveLength(move.beats.length)
      expect(durS).toBeGreaterThan(0)
      for (const t of timesS) {
        expect(t, move.id).toBeGreaterThanOrEqual(0)
        expect(t, move.id).toBeLessThanOrEqual(durS + 1e-9)
      }
      for (let i = 1; i < timesS.length; i++) expect(timesS[i], move.id).toBeGreaterThan(timesS[i - 1])
    }
  })

  it('measures those moments on the same clock the samples are drawn on', () => {
    // A tick measured against a different length would stand in the wrong place
    // on the strip with nothing to catch it, so the two share tileDurS.
    for (const move of MOVES) {
      expect(moveBeatTimes(move, DEPTH, RISE).durS, move.id).toBe(move.window === 'moment' ? 1.4 : 2)
      expect(moveSamples(move, DEPTH, RISE, 4)).toHaveLength(5)
    }
  })
})

// His ask, 2026-08-14: *"go out and go more out than it can before."* The slider
// used to start at 105 percent, so a move could only ever grow. The engine
// always handled shrinking; it was simply unreachable. These pin the three
// things that were actually wrong underneath, all three found by PROBING the
// compiler at depths below 1 rather than by reading it.
describe('moves that pull back', () => {
  const ctx = { riseFrames: 5, seqWidth: 1080, seqHeight: 1920 }
  const scaleOf = (c: Clip): number[] => channelKeyframes(c, 'scale').map((k) => +k.value.toFixed(4))
  const posXOf = (c: Clip): number[] => channelKeyframes(c, 'posX').map((k) => +k.value.toFixed(1))
  const byId = (id: string): MoveDef => MOVES.find((m) => m.id === id)!

  it('a zoom-out compiles to a shrinking scale track', () => {
    const out = applyMove(seed(4), FPS, byId('pushIn'), { depth: 0.5, ...ctx })
    expect(scaleOf(out)).toEqual([1, 0.5])
  })

  it('⛔ a sideways move keeps its DIRECTION when it shrinks', () => {
    // The bug: posX = base - fx * (r - 1), and (r - 1) flips sign below 1, so
    // "Left, then right" travelled right then left. Measured before the fix:
    // depth 0.8 gave [0, -47.5, -47.5, +47.5, +47.5, 0], the mirror of 1.2.
    const inward = posXOf(applyMove(seed(4), FPS, byId('leftThenRight'), { depth: 1.2, ...ctx }))
    const outward = posXOf(applyMove(seed(4), FPS, byId('leftThenRight'), { depth: 0.8, ...ctx }))
    expect(inward.length).toBeGreaterThan(2)
    expect(outward).toEqual(inward)
    // ...and it is genuinely the left-then-right shape, not a flat line.
    expect(Math.max(...inward)).toBeGreaterThan(0)
    expect(Math.min(...inward)).toBeLessThan(0)
  })

  it('travels FURTHER the further from normal it goes, in both directions', () => {
    const near = posXOf(applyMove(seed(4), FPS, byId('leftThenRight'), { depth: 0.8, ...ctx }))
    const far = posXOf(applyMove(seed(4), FPS, byId('leftThenRight'), { depth: 0.5, ...ctx }))
    expect(Math.max(...far)).toBeGreaterThan(Math.max(...near))
  })

  it('⛔ a zoom-out is still RECOGNISED as its own move, so the tile stays lit', () => {
    // The bug: matchMove took Math.max of the scale keyframes, which for a
    // shrinking move is just the base, so depth read as 1 and nothing matched.
    // Every zoom-out came back null and the shelf went dark.
    for (const id of ['pushIn', 'inAndOut', 'leftThenRight', 'rightThenLeft', 'driftRight']) {
      for (const depth of [0.8, 0.6, 0.5]) {
        const out = applyMove(seed(4), FPS, byId(id), { depth, ...ctx })
        const m = matchMove(out, FPS, ctx)
        expect(m, `${id} at ${depth}`).not.toBeNull()
        expect(m!.id, `${id} at ${depth}`).toBe(id)
        expect(m!.depth, `${id} at ${depth}`).toBeCloseTo(depth, 2)
      }
    }
  })

  it('still recognises every move that grows, exactly as before', () => {
    for (const id of ['pushIn', 'inAndOut', 'leftThenRight', 'rightThenLeft', 'driftRight']) {
      for (const depth of [1.2, 1.5, 2]) {
        const out = applyMove(seed(4), FPS, byId(id), { depth, ...ctx })
        const m = matchMove(out, FPS, ctx)
        expect(m!.id, `${id} at ${depth}`).toBe(id)
        expect(m!.depth, `${id} at ${depth}`).toBeCloseTo(depth, 2)
      }
    }
  })

  it('⛔ exactly 1.0 is NO MOVE, and distinct moves are indistinguishable there', () => {
    // Why the depth control refuses to sit on 100 percent. Keeping flat
    // keyframes so the tile stayed lit was tried and is worse: every preset
    // compiles to the same thing, so the shelf lights whichever matches first
    // and then rebuilds THAT one when the slider moves off.
    const a = applyMove(seed(4), FPS, byId('rightThenLeft'), { depth: 1, ...ctx })
    expect(scaleOf(a)).toEqual([])
    expect(matchMove(a, FPS, ctx)?.id).toBe('none')
  })
})
