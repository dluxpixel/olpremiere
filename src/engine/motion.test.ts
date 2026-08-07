import { describe, expect, it } from 'vitest'
import { channelBase, resolveChannel } from './effects/channels'
import { evalChannel } from './keyframes'
import {
  impactClip,
  punchInClip,
  punchOutClip,
  rampSpeedRange,
  whipClips,
  MOTION_CURVES,
  RAMP_MOTION_BLUR_PX,
} from './motion'
import { clipEndS } from './timeline'
import {
  defaultTitleDef,
  newSequence,
  newTitleClip,
  type Clip,
  type Keyframe,
  type Sequence,
} from './types'

const FPS = 30

/** A 10s clip starting at 2s on V1 of a fresh sequence. */
function seed(): { seq: Sequence; clip: Clip } {
  const clip = newTitleClip(defaultTitleDef('x'), 2, 10)
  const seq = newSequence()
  seq.tracks[0].clips.push(clip)
  return { seq: { ...seq, durationS: 12 }, clip }
}

const scaleAt = (clip: Clip, tLocal: number) => resolveChannel(clip, 'scale', tLocal)

/**
 * Colour channels resolve out of the EFFECT STACK, not clip.keyframes, so assert
 * where the renderer actually reads, or a write to the dead legacy address
 * passes while nothing renders.
 */
const colorAt = (clip: Clip, ch: 'saturation' | 'blur', tLocal: number) => resolveChannel(clip, ch, tLocal)

describe('punchInClip', () => {
  it('holds 1.0, rises fast to the target, holds, and returns', () => {
    const { clip } = seed()
    const out = punchInClip(clip, FPS, { atS: 4, targetScale: 1.2, riseFrames: 5, holdS: 0.5 })
    const at = 2 // clip-local
    const rise = 5 / FPS
    // Without holdToEnd the four-knot envelope is exactly what it always was.
    expect(out.keyframes?.scale).toHaveLength(4)
    expect(scaleAt(out, 0)).toBeCloseTo(1, 6)
    expect(scaleAt(out, at)).toBeCloseTo(1, 6)
    // fast-in: past halfway up well before half the rise time
    expect(scaleAt(out, at + rise * 0.5)).toBeGreaterThan(1.1)
    expect(scaleAt(out, at + rise)).toBeCloseTo(1.2, 6)
    expect(scaleAt(out, at + rise + 0.25)).toBeCloseTo(1.2, 6)
    expect(scaleAt(out, at + rise + 0.5 + 0.25)).toBeCloseTo(1, 6)
    expect(scaleAt(out, 9)).toBeCloseTo(1, 6)
  })

  /**
   * The rise used to be the named ease 'easeOut'; it is the snap CURVE now.
   * Asserting the curve rather than the ease is the deliberate part: a rename
   * would have kept the old shape and quietly lost the whole point of the graft.
   */
  it('rises on the snap curve, not on a named ease', () => {
    const { clip } = seed()
    const out = punchInClip(clip, FPS, { atS: 4, targetScale: 1.2, riseFrames: 5 })
    const at = 2
    const rise = 5 / FPS
    expect(out.keyframes?.scale?.[0].curve).toEqual(MOTION_CURVES.snapIn)
    // snapIn is most of the way up at the halfway point, where easeOut was at 75%
    expect(scaleAt(out, at + rise * 0.5)).toBeGreaterThan(1.19)
  })

  it('holdToEnd writes exactly two knots and STAYS at the target', () => {
    const { clip } = seed()
    const base = channelBase(clip, 'scale')
    const out = punchInClip(clip, FPS, { atS: 4, targetScale: 1.2, riseFrames: 5, holdToEnd: true })
    const kfs = out.keyframes?.scale ?? []
    expect(kfs).toHaveLength(2)
    expect(kfs[kfs.length - 1].value).toBe(base * 1.2)
    expect(kfs[0].curve).toEqual(MOTION_CURVES.snapIn)
    const at = 2
    const rise = 5 / FPS
    expect(scaleAt(out, at + rise)).toBeCloseTo(1.2, 6)
    // where the old envelope had already slid back to base
    expect(scaleAt(out, at + rise + 0.5 + 0.25)).toBeCloseTo(1.2, 6)
    expect(scaleAt(out, 9)).toBeCloseTo(1.2, 6)
  })

  it('focal punch shifts position so the clicked point stays put', () => {
    const { clip } = seed()
    const out = punchInClip(clip, FPS, {
      atS: 4,
      focal: { x: 810, y: 960 }, // 270px right of center, vertical center
      seqWidth: 1080,
      seqHeight: 1920,
    })
    const peak = 2 + 5 / FPS
    // shift = -f * (r - 1) = -270 * 0.2
    expect(evalChannel(out.keyframes?.posX, peak, 0)).toBeCloseTo(-54, 4)
    expect(evalChannel(out.keyframes?.posY, peak, 0)).toBeCloseTo(0, 4)
    expect(evalChannel(out.keyframes?.posX, 9, 0)).toBeCloseTo(0, 4) // settles back
    // without a focal point, position stays untouched
    const plain = punchInClip(clip, FPS, { atS: 4 })
    expect(plain.keyframes?.posX).toBeUndefined()
  })

  it('stacks relative to an existing punch instead of clobbering it', () => {
    const { clip } = seed()
    const first = punchInClip(clip, FPS, { atS: 3 })
    const second = punchInClip(first, FPS, { atS: 8 })
    expect(scaleAt(second, 1 + 5 / FPS)).toBeCloseTo(1.2, 5) // first punch intact
    expect(scaleAt(second, 6 + 5 / FPS)).toBeCloseTo(1.2, 5) // second punch too
  })
})

describe('punchOutClip', () => {
  it('falls to the clip base EXACTLY and holds there', () => {
    const { clip } = seed()
    const base = channelBase(clip, 'scale')
    const held = punchInClip(clip, FPS, { atS: 4, targetScale: 1.4, riseFrames: 5, holdToEnd: true })
    const out = punchOutClip(held, FPS, { atS: 7, riseFrames: 5 })
    const start = 5 // clip-local
    const fall = 5 / FPS
    // merged onto the punch in rather than clobbering it
    expect(out.keyframes?.scale).toHaveLength(4)
    expect(scaleAt(out, start)).toBeCloseTo(1.4, 6) // still up when the fall starts
    expect(scaleAt(out, start + fall)).toBe(base) // lands ON base, not near it
    expect(scaleAt(out, start + fall + 0.5)).toBe(base) // and holds
    expect(scaleAt(out, 9.9)).toBe(base) // to the end of the clip
    const fallKnot = out.keyframes?.scale?.find((k) => Math.abs(k.t - start) < 1e-6)
    expect(fallKnot?.curve).toEqual(MOTION_CURVES.snapIn)
  })

  it('a focal fall returns the framing to its base position too', () => {
    const { clip } = seed()
    const focal = { x: 810, y: 960 } // 270px right of centre
    const frame = { seqWidth: 1080, seqHeight: 1920 }
    const held = punchInClip(clip, FPS, { atS: 4, targetScale: 1.2, holdToEnd: true, focal, ...frame })
    expect(evalChannel(held.keyframes?.posX, 5, 0)).toBeCloseTo(-54, 4)
    const out = punchOutClip(held, FPS, { atS: 7, ...frame, focal })
    // continuous where the fall starts, and back on base by the time it lands
    expect(evalChannel(out.keyframes?.posX, 5, 0)).toBeCloseTo(-54, 4)
    expect(evalChannel(out.keyframes?.posX, 5 + 5 / FPS, 0)).toBeCloseTo(0, 6)
    expect(evalChannel(out.keyframes?.posX, 9, 0)).toBeCloseTo(0, 6)
    // without a focal point, position stays untouched
    const plain = punchOutClip(clip, FPS, { atS: 7 })
    expect(plain.keyframes?.posX).toBeUndefined()
  })
})

describe('impactClip', () => {
  const at = 5 // sequence time → clip-local 3
  const local = 3

  it('desaturates, blurs, and punches at the beat, neutral before/after', () => {
    const { clip } = seed()
    const out = impactClip(clip, FPS, { atS: at, desat: 0.1, blurPx: 6, scale: 1.08 })
    expect(colorAt(out, 'saturation', local)).toBeCloseTo(-0.9, 6)
    expect(colorAt(out, 'blur', local)).toBeCloseTo(6, 6)
    // and they are real effect instances, so resolveFrame will render them
    expect(out.effects.map((e) => e.type).sort()).toEqual(['gaussianBlur', 'saturation'])
    expect(scaleAt(out, local)).toBeCloseTo(1.08, 6)
    // the lead-in knot runs the snap curve where it used to run a named easeOut
    expect(out.keyframes?.scale?.[0].curve).toEqual(MOTION_CURVES.snapIn)
    // well before and after: neutral
    expect(colorAt(out, 'saturation', 0.5)).toBeCloseTo(0, 6)
    expect(colorAt(out, 'blur', 9)).toBeCloseTo(0, 6)
    expect(scaleAt(out, 9)).toBeCloseTo(1, 6)
  })

  it('shakes the position and settles back to base', () => {
    const { clip } = seed()
    const out = impactClip(clip, FPS, { atS: at, shakePx: 2 })
    const t1 = local - 0.1
    expect(evalChannel(out.keyframes?.posX, t1 + 1 / FPS, 0)).toBeCloseTo(2, 6)
    expect(evalChannel(out.keyframes?.posX, 9, 0)).toBeCloseTo(0, 6)
  })
})

describe('whipClips', () => {
  let n = 0
  const idFor = () => `whip-${n++}`

  it('ramps directional blur into the cut and out of it, with a scale push', () => {
    const a = newTitleClip(defaultTitleDef('a'), 2, 10) // ends at 12
    const b = newTitleClip(defaultTitleDef('b'), 12, 5)
    const out = whipClips(a, b, FPS, idFor, { frames: 3, maxStrength: 1 })

    const fxA = out.a.effects.find((e) => e.type === 'directionalBlur')!
    const fxB = out.b.effects.find((e) => e.type === 'directionalBlur')!
    const sA = fxA.params.strength as { value: number; keyframes: Keyframe[] }
    const sB = fxB.params.strength as { value: number; keyframes: Keyframe[] }
    // A: 0 → max at its last frame; B: max at 0 → 0 after `frames`.
    expect(sA.keyframes.map((k) => [k.t.toFixed(3), k.value])).toEqual([
      [(10 - 3 / FPS).toFixed(3), 0],
      ['10.000', 1],
    ])
    expect(sB.keyframes[0]).toMatchObject({ t: 0, value: 1 })
    expect(sB.keyframes[1].value).toBe(0)
    // asymmetric by design: leaving winds up, arriving settles
    expect(sA.keyframes[0].curve).toEqual(MOTION_CURVES.windUp)
    expect(sB.keyframes[0].curve).toEqual(MOTION_CURVES.settle)
    // scale push on each side of the cut
    expect(evalChannel(out.a.keyframes?.scale, 10, 1)).toBeCloseTo(1.06, 6)
    expect(evalChannel(out.b.keyframes?.scale, 0, 1)).toBeCloseTo(1.06, 6)
    expect(evalChannel(out.b.keyframes?.scale, 1, 1)).toBeCloseTo(1, 6)
    // originals untouched (pure)
    expect(a.effects).toHaveLength(0)
  })
})

describe('rampSpeedRange', () => {
  const nextId = (() => {
    let n = 0
    return () => `fx-${n++}`
  })()

  it('splits at the bounds and speeds only the middle, with motion blur', () => {
    const { seq, clip } = seed()
    const { seq: out, middleId } = rampSpeedRange(seq, clip.id, 5, 8, 2, nextId)
    const clips = out.tracks[0].clips
    expect(clips).toHaveLength(3)
    const [left, middle, right] = clips
    expect(middleId).toBe(middle.id)
    expect(clipEndS(left)).toBeCloseTo(5, 6)
    expect(middle.startS).toBeCloseTo(5, 6)
    expect(middle.speed).toBe(2)
    expect(clipEndS(middle)).toBeCloseTo(6.5, 6) // 3s of content at 2x
    expect(right.startS).toBeCloseTo(8, 6) // never ripples
    expect(left.speed).toBe(1)
    expect(right.speed).toBe(1)
    expect(middle.effects.some((e) => e.type === 'gaussianBlur' && e.params.blur === RAMP_MOTION_BLUR_PX)).toBe(true)
    expect(left.effects).toHaveLength(0)
  })

  it('slow-motion gets no auto blur', () => {
    const { seq, clip } = seed()
    const { seq: out, middleId } = rampSpeedRange(seq, clip.id, 5, 8, 0.5, nextId)
    const middle = out.tracks[0].clips.find((c) => c.id === middleId)!
    expect(middle.speed).toBe(0.5)
    expect(middle.effects).toHaveLength(0)
  })

  it('slow-motion RIPPLES the tail instead of overlapping it', () => {
    // 3s of content at 0.5x lasts 6s, so the middle piece grows from [5,8) to
    // [5,11) and the right piece has to move. Overlapping clips on one track
    // break the resolver's binary search: the later clip wins and the tail of
    // the slow-motion the user just asked for is invisible.
    const { seq, clip } = seed()
    const { seq: out } = rampSpeedRange(seq, clip.id, 5, 8, 0.5, nextId)
    const clips = out.tracks[0].clips
    expect(clips).toHaveLength(3)
    const [left, middle, right] = clips
    expect(clipEndS(middle)).toBeCloseTo(11, 6)
    expect(right.startS).toBeCloseTo(11, 6)
    // and the whole track stays sorted + non-overlapping
    expect(clipEndS(left)).toBeLessThanOrEqual(middle.startS + 1e-6)
    expect(clipEndS(middle)).toBeLessThanOrEqual(right.startS + 1e-6)
  })

  it('a range covering the whole clip just re-speeds it (sliver guard folds the splits)', () => {
    const { seq, clip } = seed()
    const { seq: out, middleId } = rampSpeedRange(seq, clip.id, 2, 12, 2, nextId)
    const clips = out.tracks[0].clips
    expect(clips).toHaveLength(1)
    expect(clips[0].id).toBe(middleId)
    expect(clips[0].speed).toBe(2)
  })

  it('no-ops on degenerate ranges and unknown clips', () => {
    const { seq, clip } = seed()
    expect(rampSpeedRange(seq, clip.id, 5, 5, 2, nextId).middleId).toBeNull()
    expect(rampSpeedRange(seq, 'nope', 5, 8, 2, nextId).middleId).toBeNull()
  })
})
