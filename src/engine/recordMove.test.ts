// ⛔ THE ONLY PROOF THAT MATTERS HERE IS A ROUND TRIP.
//
// `normaliseRecording` claims to read a performed move back into the normalised
// beats a tile is made of. The way to believe that is to take real keyframes,
// turn them into a MoveDef, build a clip from THAT, and get the same keyframes
// back. Anything less is checking that the arithmetic ran.
//
// His ask, 2026-08-15: *"I want it to be just like the built-in ten."*

import { describe, expect, it } from 'vitest'
import { channelKeyframes } from './effects/channels'
import { MOVES, MOVE_BY_ID, applyMove, type MoveDef } from './moves'
import { curveName, normaliseRecording } from './recordMove'
import { withKeyframes } from './motion'
import { defaultTitleDef, newTitleClip, type Clip } from './types'

const FPS = 30
const W = 1920
const H = 1080
const DEPTH = 1.2
const RISE = 5
const CTX = { seqWidth: W, seqHeight: H, fps: FPS }

const seed = (durS: number): Clip => newTitleClip(defaultTitleDef('x'), 0, durS)
const keys = (c: Clip, ch: 'scale' | 'posX' | 'posY') =>
  channelKeyframes(c, ch).map((k) => ({ t: k.t, value: k.value }))

/**
 * ⛔ REBUILT OVER THE WINDOW IT WAS RECORDED ON, and that is not a fudge.
 *
 * A recorded move is a CLIP-window move: applied to a clip it fills the window
 * it is given, exactly as Push in does. So the faithful round trip hands it the
 * span it was performed over. Rebuilding it across the whole clip instead would
 * be asking a stretching move to reproduce a five-frame punch, which is a
 * different question and the wrong one.
 */
const spanOf = (c: Clip): { startS: number; endS: number } => {
  const ts = (['scale', 'posX', 'posY'] as const).flatMap((ch) => keys(c, ch).map((k) => k.t))
  return { startS: Math.min(...ts), endS: Math.max(...ts) }
}

const rebuild = (def: MoveDef, durS: number, over: { startS: number; endS: number }): Clip =>
  applyMove(seed(durS), FPS, def, {
    depth: def.recordedDepth ?? DEPTH,
    riseFrames: RISE,
    seqWidth: W,
    seqHeight: H,
    ...over,
  })

const same = (a: { t: number; value: number }[], b: { t: number; value: number }[], what: string) => {
  expect(b.length, `${what}: keyframe count`).toBe(a.length)
  a.forEach((k, i) => {
    expect(b[i].t, `${what}: moment ${i}`).toBeCloseTo(k.t, 5)
    expect(b[i].value, `${what}: value ${i}`).toBeCloseTo(k.value, 3)
  })
}

describe('normaliseRecording', () => {
  it('says nothing at all about a clip with no move on it', () => {
    expect(normaliseRecording(seed(4), CTX)).toBeNull()
  })

  /**
   * Every built-in put through the recorder and back. A performed move IS just
   * concrete keyframes, so a preset applied to a clip is the most honest fixture
   * available: it exercises zooms, travels, holds, snaps and the shake's six
   * beats without inventing a hand path nobody would ever draw.
   */
  it('round-trips every built-in move, keyframe for keyframe', () => {
    for (const move of MOVES) {
      if (move.beats.length === 0) continue
      for (const durS of [2, 6]) {
        const built = applyMove(seed(durS), FPS, move, {
          depth: DEPTH,
          riseFrames: RISE,
          seqWidth: W,
          seqHeight: H,
        })
        const def = normaliseRecording(built, CTX)
        expect(def, `${move.id} @ ${durS}s`).not.toBeNull()
        const back = rebuild(def!, durS, spanOf(built))
        const label = `${move.id} @ ${durS}s`
        same(keys(built, 'scale'), keys(back, 'scale'), `${label} scale`)
        same(keys(built, 'posX'), keys(back, 'posX'), `${label} posX`)
        same(keys(built, 'posY'), keys(back, 'posY'), `${label} posY`)
      }
    }
  })

  /**
   * ⛔ THE ONE THE WHOLE WIDENING WAS FOR. A hand path that slides across without
   * ever resizing cannot be held by `aim`, which is multiplied by how far the
   * zoom is from normal. This is the shape that used to be impossible.
   */
  it('round-trips a pan performed at normal size, which aim alone cannot hold', () => {
    const base = seed(4)
    const clip = withKeyframes(base, 'posX', [
      { t: 0, value: -200, ease: 'linear' },
      { t: 2, value: 0, ease: 'linear' },
      { t: 4, value: 260, ease: 'linear' },
    ])
    const def = normaliseRecording(clip, CTX)
    expect(def).not.toBeNull()
    expect(def!.recordedDepth, 'it never resized').toBeCloseTo(1, 9)
    const back = rebuild(def!, 4, spanOf(clip))
    same(keys(clip, 'posX'), keys(back, 'posX'), 'pan at normal size')
    expect(keys(back, 'scale'), 'and it still writes no zoom').toHaveLength(0)
  })

  /**
   * ⛔ A TAKE THAT GOES BOTH WAYS. `d` is a share of ONE depth, so a move that
   * grows AND shrinks in one performance needs a negative `d`, which the built-in
   * table never uses and the maths handles perfectly well.
   */
  it('round-trips a take that goes bigger and then smaller than his own framing', () => {
    const base = seed(4)
    const clip = withKeyframes(base, 'scale', [
      { t: 0, value: 1, ease: 'linear' },
      { t: 1.5, value: 1.3, ease: 'linear' },
      { t: 4, value: 0.85, ease: 'linear' },
    ])
    const def = normaliseRecording(clip, CTX)
    expect(def).not.toBeNull()
    // Furthest from his own framing is 1.3, so that is the depth, and the 0.85
    // beat lands on a NEGATIVE share of it.
    expect(def!.recordedDepth).toBeCloseTo(1.3, 6)
    expect(def!.beats.some((b) => b.d < 0), 'a shrink below his framing').toBe(true)
    same(keys(clip, 'scale'), keys(rebuild(def!, 4, spanOf(clip)), 'scale'), 'both directions')
  })

  it('reads a stored curve back by name, and never renames a hand-shaped one', () => {
    expect(curveName(undefined)).toBe('linear')
    expect(curveName([0.16, 1, 0.3, 1])).toBe('snapIn')
    expect(curveName([0.37, 0, 0.63, 1])).toBe('smooth')
    // Nothing in the table: called linear rather than labelled as something it
    // is not. The shape itself is what he drew and is not this function's to name.
    expect(curveName([0.11, 0.22, 0.33, 0.44])).toBe('linear')
  })

  it('keeps the shape of the segments, not only where the moments are', () => {
    const built = applyMove(seed(6), FPS, MOVE_BY_ID.punchIn, {
      depth: DEPTH,
      riseFrames: RISE,
      seqWidth: W,
      seqHeight: H,
    })
    const back = rebuild(normaliseRecording(built, CTX)!, 6, spanOf(built))
    const a = channelKeyframes(built, 'scale')
    const b = channelKeyframes(back, 'scale')
    a.forEach((k, i) => {
      expect(b[i].ease, `ease ${i}`).toBe(k.ease)
      expect(b[i].curve, `curve ${i}`).toEqual(k.curve)
    })
  })
})

/**
 * ⛔ A BURST HE PERFORMED MUST NOT BECOME A SLOW PUSH ON A LONGER CLIP.
 *
 * The first version of the recorder made EVERY recording a clip-length move, so
 * a half second punch performed on a 6 second clip stretched to twenty seconds
 * the moment it was applied to a twenty second one. Measured, not suspected.
 *
 * The rule is the one the built-in table already answers for itself: a
 * clip-length move runs from the window start to the window end. A performance
 * that starts late or stops early is a moment, and it keeps its own timing.
 */
describe('a performance that does not fill the clip stays a burst', () => {
  const punch = () =>
    withKeyframes(seed(6), 'scale', [
      { t: 1, value: 1, ease: 'linear' },
      { t: 1.5, value: 1.3, ease: 'linear' },
    ])

  it('keeps its real length when it lands on a much longer clip', () => {
    const def = normaliseRecording(punch(), CTX)!
    expect(def.window).toBe('moment')
    const onLong = applyMove(seed(20), FPS, def, {
      depth: def.recordedDepth ?? DEPTH,
      riseFrames: RISE,
      seqWidth: W,
      seqHeight: H,
    })
    const ks = keys(onLong, 'scale')
    expect(ks[ks.length - 1].t - ks[0].t, 'half a second stays half a second').toBeCloseTo(0.5, 5)
  })

  /**
   * ⛔ AND HIS RISE SETTING MUST NOT STRETCH IT EITHER. A `frames` beat is scaled
   * by the rise (`scaledFrames`), which is right for a hand-authored table
   * written at a rise of 5 and wrong for a performance: turning the rise up would
   * lengthen a move he had already recorded.
   */
  it('is not stretched by his rise setting', () => {
    const def = normaliseRecording(punch(), CTX)!
    const spanAt = (riseFrames: number) => {
      const out = applyMove(seed(20), FPS, def, {
        depth: def.recordedDepth ?? DEPTH,
        riseFrames,
        seqWidth: W,
        seqHeight: H,
      })
      const ks = keys(out, 'scale')
      return ks[ks.length - 1].t - ks[0].t
    }
    expect(spanAt(10)).toBeCloseTo(spanAt(5), 5)
  })

  it('still calls a performance that fills the clip a clip move', () => {
    const full = withKeyframes(seed(6), 'scale', [
      { t: 0, value: 1, ease: 'linear' },
      { t: 6, value: 1.3, ease: 'linear' },
    ])
    expect(normaliseRecording(full, CTX)!.window).toBe('clip')
  })
})
