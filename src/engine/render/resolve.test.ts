import { describe, expect, it } from 'vitest'
import { migrateClipEffects } from '../effects/migrate'
import { resolveFrame, _activeIndexForTest } from './resolve'
import type { RenderLayer, RenderOp } from './types'
import { defaultTransform, type Clip, type Keyframe, type Sequence, type Track } from '../types'

// --- Fixtures -------------------------------------------------------------

let uid = 0
const id = (p: string): string => `${p}-${uid++}`

const kf = (t: number, value: number, e: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease: e })

/** A clip with defaults; startS/inS/outS drive its placement + source window. */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: id('clip'),
    assetId: id('asset'),
    startS: 0,
    inS: 0,
    outS: 2,
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    ...over,
  }
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: id('track'),
    kind: 'video',
    name: 'V1',
    height: 64,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [],
    ...over,
  }
}

function seqOf(tracks: Track[], over: Partial<Sequence> = {}): Sequence {
  return {
    id: id('seq'),
    name: 'Seq',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 0,
    tracks,
    markers: [],
    ...over,
  }
}

// Narrowing helpers so tests read cleanly.
const asLayer = (op: RenderOp): RenderLayer => {
  expect(op.type).toBe('layer')
  if (op.type !== 'layer') throw new Error('not a layer')
  return op.layer
}
const asTransition = (op: RenderOp) => {
  expect(op.type).toBe('transition')
  if (op.type !== 'transition') throw new Error('not a transition')
  return op
}

// --- Frame shell ----------------------------------------------------------

describe('resolveFrame shell', () => {
  it('frame width/height come from the sequence native resolution', () => {
    const f = resolveFrame(seqOf([], { width: 1280, height: 720 }), 0)
    expect(f.width).toBe(1280)
    expect(f.height).toBe(720)
    expect(f.ops).toEqual([])
  })

  it('empty sequence produces no ops', () => {
    expect(resolveFrame(seqOf([]), 5).ops).toHaveLength(0)
  })

  it('a time before any clip yields no ops', () => {
    const t = track({ clips: [clip({ startS: 4, outS: 2 })] })
    expect(resolveFrame(seqOf([t]), 0).ops).toHaveLength(0)
  })

  it('a time past the last clip yields no ops', () => {
    const t = track({ clips: [clip({ startS: 0, outS: 2 })] })
    expect(resolveFrame(seqOf([t]), 10).ops).toHaveLength(0)
  })
})

// --- Identity clip --------------------------------------------------------

describe('identity clip', () => {
  it('emits one layer op with identity transform, opacity 1, neutral filters', () => {
    const c = clip({ startS: 0, inS: 0, outS: 2 })
    const f = resolveFrame(seqOf([track({ clips: [c] })]), 1)
    expect(f.ops).toHaveLength(1)
    const layer = asLayer(f.ops[0])
    expect(layer.clipId).toBe(c.id)
    expect(layer.assetId).toBe(c.assetId)
    expect(layer.isImage).toBe(false)
    expect(layer.transform).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotationDeg: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      cropT: 0,
      cropR: 0,
      cropB: 0,
      cropL: 0,
    })
    expect(layer.opacity).toBe(1)
    // An ungraded clip resolves to an EMPTY stack, so the renderer compiles the
    // identity program rather than ten no-op uniforms.
    expect(layer.effects).toEqual([])
  })

  it('blendMode flows onto the resolved layer', () => {
    const c = clip({ startS: 0, inS: 0, outS: 2, blendMode: 'screen' })
    const f = resolveFrame(seqOf([track({ clips: [c] })]), 1)
    expect(asLayer(f.ops[0]).blendMode).toBe('screen')
  })

  it('the shape mask flows onto the resolved layer (and is absent without one)', () => {
    const mask = { kind: 'ellipse' as const, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, feather: 0.05, invert: false }
    const masked = clip({ startS: 0, inS: 0, outS: 2, mask })
    expect(asLayer(resolveFrame(seqOf([track({ clips: [masked] })]), 1).ops[0]).mask).toEqual(mask)
    const plain = clip({ startS: 0, inS: 0, outS: 2 })
    expect(asLayer(resolveFrame(seqOf([track({ clips: [plain] })]), 1).ops[0]).mask).toBeUndefined()
  })

  it('frameSeed is the sequence-time frame index, identical for preview and export at one frame', () => {
    const c = clip({ startS: 0, inS: 0, outS: 5 })
    const seq = seqOf([track({ clips: [c] })]) // fps 30
    expect(asLayer(resolveFrame(seq, 1).ops[0]).frameSeed).toBe(30)
    expect(asLayer(resolveFrame(seq, 2.5).ops[0]).frameSeed).toBe(75)
    // Sub-frame preview times quantize to the SAME seed as the exact frame time,
    // so stochastic effects (grain) cannot diverge between preview and export.
    expect(asLayer(resolveFrame(seq, 2.5 + 0.01).ops[0]).frameSeed).toBe(75)
  })

  it('fadeInS ramps layer opacity up over the fade, full after it', () => {
    const c = clip({ startS: 0, inS: 0, outS: 4, fadeInS: 1 })
    const at = (t: number) => asLayer(resolveFrame(seqOf([track({ clips: [c] })]), t).ops[0]).opacity
    expect(at(0)).toBeCloseTo(0, 5) // fully transparent at the very start
    expect(at(0.5)).toBeCloseTo(0.5, 5) // halfway through the fade
    expect(at(2)).toBe(1) // past the fade
  })

  it('fadeOutS ramps layer opacity down to 0 at the end', () => {
    const c = clip({ startS: 0, inS: 0, outS: 4, fadeOutS: 1 }) // endS = 4
    const at = (t: number) => asLayer(resolveFrame(seqOf([track({ clips: [c] })]), t).ops[0]).opacity
    expect(at(2)).toBe(1) // before the fade-out
    expect(at(3.5)).toBeCloseTo(0.5, 5) // halfway through the fade-out
  })

  it('whiteFlash on a lone in-edge emits a transition op (white → footage), not a fade ramp', () => {
    // The FIRST clip on a timeline: no neighbor, yet the intro must open on
    // white — the lone-edge fade-from-black ramp would be wrong for this kind.
    const c = clip({ startS: 0, inS: 0, outS: 2, transitionIn: { type: 'whiteFlash', durationS: 0.2 } })
    const at = (t: number) => resolveFrame(seqOf([track({ clips: [c] })]), t).ops[0]

    const t0 = at(0)
    expect(t0.type).toBe('transition')
    if (t0.type !== 'transition') throw new Error('not a transition')
    expect(t0.kind).toBe('whiteFlash')
    expect(t0.progress).toBeCloseTo(0, 6)
    // The shader ignores `from`; both sides are the clip's own layer.
    expect(t0.from).toBe(t0.to)

    const mid = at(0.1)
    if (mid.type !== 'transition') throw new Error('not a transition')
    expect(mid.progress).toBeCloseTo(0.5, 6)

    // Past the window: a plain layer at FULL opacity — no residual fade.
    const after = at(0.3)
    expect(after.type).toBe('layer')
    expect(asLayer(after).opacity).toBe(1)
  })

  it('whiteFlash between two adjacent clips still flashes at the head of B', () => {
    const a = clip({ startS: 0, inS: 0, outS: 2 })
    const b = clip({ startS: 2, inS: 0, outS: 2, transitionIn: { type: 'whiteFlash', durationS: 0.2 } })
    const op = resolveFrame(seqOf([track({ clips: [a, b] })]), 2.05).ops[0]
    expect(op.type).toBe('transition')
    if (op.type !== 'transition') throw new Error('not a transition')
    expect(op.kind).toBe('whiteFlash')
    expect(op.progress).toBeCloseTo(0.25, 6)
  })

  it('whiteFlash on a lone OUT edge ramps footage → white at the video end', () => {
    // The LAST clip on the timeline: the outro must land on full white, not
    // the generic fade-to-black ramp. Progress is inverted so the shared
    // shader curve mirrors: near the end progress → 0 (alpha → 1, white).
    const c = clip({ startS: 0, inS: 0, outS: 2, transitionOut: { type: 'whiteFlash', durationS: 0.2 } })
    const at = (t: number) => resolveFrame(seqOf([track({ clips: [c] })]), t).ops[0]

    const nearEnd = at(1.95)
    expect(nearEnd.type).toBe('transition')
    if (nearEnd.type !== 'transition') throw new Error('not a transition')
    expect(nearEnd.kind).toBe('whiteFlash')
    expect(nearEnd.progress).toBeCloseTo(0.25, 6) // alpha (1-p)² = 0.56 and rising

    const windowStart = at(1.8)
    if (windowStart.type !== 'transition') throw new Error('not a transition')
    expect(windowStart.progress).toBeCloseTo(1, 6) // pure footage at the window's start

    // Before the window: plain full-opacity layer.
    const before = at(1.5)
    expect(before.type).toBe('layer')
    expect(asLayer(before).opacity).toBe(1)
  })

  it('whiteFlash + fadeInS on the same edge does not re-fade after the flash', () => {
    // fadeInS longer than the flash window: the transition owns the edge, so
    // the handle must not dim the footage after the white resolves.
    const c = clip({
      startS: 0,
      inS: 0,
      outS: 4,
      fadeInS: 1,
      transitionIn: { type: 'whiteFlash', durationS: 0.2 },
    })
    const op = resolveFrame(seqOf([track({ clips: [c] })]), 0.5).ops[0]
    expect(op.type).toBe('layer')
    expect(asLayer(op).opacity).toBe(1)
  })

  it('a fade + a lone-edge transition on the same edge do NOT double-fade', () => {
    // Last clip on its track (no next partner) with BOTH a 1s dip-to-black
    // transitionOut and a 1s fade-out handle. The transition OWNS its window,
    // so the handle cannot multiply into it (which used to risk a quadratic
    // ramp); outside the window the handle is the only thing acting.
    const c = clip({
      startS: 0,
      inS: 0,
      outS: 4,
      fadeOutS: 1,
      transitionOut: { type: 'dipToBlack', durationS: 1 },
    })
    const s = seqOf([track({ clips: [c] })])
    const op = asTransition(resolveFrame(s, 3.5).ops[0])
    expect(op.kind).toBe('dipToBlack')
    expect(op.progress).toBeCloseTo(0.5, 5)
    expect(op.from.opacity).toBeCloseTo(1, 5) // NOT pre-ramped by the handle
    expect(asLayer(resolveFrame(s, 2.5).ops[0]).opacity).toBeCloseTo(1, 5)
  })

  it('color-correction flows from a migrated clip into the resolved layer', () => {
    const c = migrateClipEffects(clip({ filters: { lift: 0.2, gamma: -0.3, gain: 0.1, temperature: 0.5, tint: -0.4 } }))
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 0).ops[0])
    expect(layer.effects.map((e) => e.type)).toEqual(['colorWheels', 'whiteBalance'])
    expect(layer.effects[0].params.lift).toBeCloseTo(0.2)
    expect(layer.effects[0].params.gamma).toBeCloseTo(-0.3)
    expect(layer.effects[0].params.gain).toBeCloseTo(0.1)
    expect(layer.effects[1].params.temperature).toBeCloseTo(0.5)
    expect(layer.effects[1].params.tint).toBeCloseTo(-0.4)
  })

  it('a disabled effect is dropped from the resolved stack', () => {
    const c = clip({ effects: [{ id: 'x', type: 'saturation', params: { saturation: -1 }, enabled: false }] })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 0).ops[0])
    expect(layer.effects).toEqual([])
  })

  it('an unknown effect type is ignored rather than crashing the render', () => {
    const c = clip({ effects: [{ id: 'x', type: 'timeWarp', params: { amount: 3 }, enabled: true }] })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 0).ops[0])
    expect(layer.effects).toEqual([])
  })

  it('sourceTimeS = inS + (t - startS) at speed 1', () => {
    const c = clip({ startS: 3, inS: 1, outS: 5 })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 4).ops[0])
    // t=4, startS=3 → local 1s; inS 1 → source 2
    expect(layer.sourceTimeS).toBeCloseTo(2)
  })

  it('sourceTimeS scales by |speed| (2×)', () => {
    const c = clip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    // duration = (4-0)/2 = 2s; at t=1 → source = 0 + 1*2 = 2
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.sourceTimeS).toBeCloseTo(2)
  })

  it('sourceTimeS uses |speed| for reverse clips too', () => {
    const c = clip({ startS: 0, inS: 0, outS: 4, speed: -2 })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.sourceTimeS).toBeCloseTo(2)
  })

  it('carries the clip speed onto the layer (preview matches the video rate to it)', () => {
    expect(asLayer(resolveFrame(seqOf([track({ clips: [clip({ speed: 0.5 })] })]), 0).ops[0]).speed).toBe(0.5)
    expect(asLayer(resolveFrame(seqOf([track({ clips: [clip({ speed: -2 })] })]), 0).ops[0]).speed).toBe(-2)
  })

  it('is active at its exact start and inactive at its exact end (half-open)', () => {
    const c = clip({ startS: 2, inS: 0, outS: 2 }) // ends at 4
    const s = seqOf([track({ clips: [c] })])
    expect(resolveFrame(s, 2).ops).toHaveLength(1) // start inclusive
    expect(resolveFrame(s, 4).ops).toHaveLength(0) // end exclusive
  })
})

// --- Keyframes ------------------------------------------------------------

describe('keyframed channels resolve at local clip time', () => {
  it('animated scale interpolates via localT', () => {
    // scale 1→3 over local [0,2]; clip starts at 5.
    const c = clip({
      startS: 5,
      inS: 0,
      outS: 2,
      keyframes: { scale: [kf(0, 1), kf(2, 3)] },
    })
    const s = seqOf([track({ clips: [c] })])
    expect(asLayer(resolveFrame(s, 5).ops[0]).transform.scale).toBeCloseTo(1)
    expect(asLayer(resolveFrame(s, 6).ops[0]).transform.scale).toBeCloseTo(2)
    expect(asLayer(resolveFrame(s, 6.5).ops[0]).transform.scale).toBeCloseTo(2.5)
  })

  it('animated opacity interpolates and clamps', () => {
    const c = clip({
      startS: 0,
      inS: 0,
      outS: 2,
      opacity: 1,
      keyframes: { opacity: [kf(0, 0), kf(2, 1)] },
    })
    const s = seqOf([track({ clips: [c] })])
    expect(asLayer(resolveFrame(s, 0).ops[0]).opacity).toBeCloseTo(0)
    expect(asLayer(resolveFrame(s, 1).ops[0]).opacity).toBeCloseTo(0.5)
  })

  it('opacity keyframe values above 1 clamp to 1', () => {
    const c = clip({ startS: 0, outS: 2, keyframes: { opacity: [kf(0, 5), kf(2, 5)] } })
    expect(asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0]).opacity).toBe(1)
  })

  it('animated posX/posY resolve into transform.x/.y', () => {
    const c = clip({
      startS: 0,
      outS: 2,
      keyframes: { posX: [kf(0, 0), kf(2, 100)], posY: [kf(0, 0), kf(2, -40)] },
    })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.transform.x).toBeCloseTo(50)
    expect(layer.transform.y).toBeCloseTo(-20)
  })

  it('animated rotation maps to rotationDeg', () => {
    const c = clip({ startS: 0, outS: 2, keyframes: { rotation: [kf(0, 0), kf(2, 90)] } })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.transform.rotationDeg).toBeCloseTo(45)
  })

  it('an animated effect param samples at the clip-local time', () => {
    const c = migrateClipEffects(clip({ startS: 0, outS: 2, keyframes: { brightness: [kf(0, 0), kf(2, 0.5)] } }))
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    const bc = layer.effects.find((e) => e.type === 'brightnessContrast')
    expect(bc?.params.brightness).toBeCloseTo(0.25)
  })

  it('an animated param keeps its effect in the stack even where it reads neutral', () => {
    // At t=0 brightness is exactly 0. The effect must NOT be dropped, or the
    // frame would pop when the animation leaves zero.
    const c = migrateClipEffects(clip({ startS: 0, outS: 2, keyframes: { brightness: [kf(0, 0), kf(2, 0.5)] } }))
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 0).ops[0])
    expect(layer.effects.map((e) => e.type)).toEqual(['brightnessContrast'])
  })

  it('static effects (no keyframes) pass through, and neutral siblings stay neutral', () => {
    const c = migrateClipEffects(clip({ startS: 0, outS: 2, filters: { blur: 8, saturation: -0.5 } }))
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.effects.map((e) => e.type)).toEqual(['saturation', 'gaussianBlur'])
    expect(layer.effects[0].params.saturation).toBe(-0.5)
    expect(layer.effects[1].params.blur).toBe(8)
  })

  it('static transform (no keyframes) passes through', () => {
    const c = clip({
      startS: 0,
      outS: 2,
      transform: { ...defaultTransform(), x: 12, scale: 2, rotationDeg: 30 },
    })
    const layer = asLayer(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops[0])
    expect(layer.transform.x).toBe(12)
    expect(layer.transform.scale).toBe(2)
    expect(layer.transform.rotationDeg).toBe(30)
  })
})

// --- Stacking / muting / disabling ----------------------------------------

describe('track stacking and filtering', () => {
  it('two stacked tracks emit two ops bottom→top', () => {
    const bottom = clip({ startS: 0, outS: 4 })
    const top = clip({ startS: 0, outS: 4 })
    const s = seqOf([
      track({ name: 'V1', clips: [bottom] }),
      track({ name: 'V2', clips: [top] }),
    ])
    const ops = resolveFrame(s, 1).ops
    expect(ops).toHaveLength(2)
    expect(asLayer(ops[0]).clipId).toBe(bottom.id) // lower track first
    expect(asLayer(ops[1]).clipId).toBe(top.id)
  })

  it('a muted video track is omitted', () => {
    const bottom = clip({ startS: 0, outS: 4 })
    const top = clip({ startS: 0, outS: 4 })
    const s = seqOf([
      track({ name: 'V1', clips: [bottom] }),
      track({ name: 'V2', muted: true, clips: [top] }),
    ])
    const ops = resolveFrame(s, 1).ops
    expect(ops).toHaveLength(1)
    expect(asLayer(ops[0]).clipId).toBe(bottom.id)
  })

  it('audio tracks contribute nothing visual', () => {
    const v = clip({ startS: 0, outS: 4 })
    const a = clip({ startS: 0, outS: 4 })
    const s = seqOf([
      track({ name: 'V1', clips: [v] }),
      track({ kind: 'audio', name: 'A1', clips: [a] }),
    ])
    const ops = resolveFrame(s, 1).ops
    expect(ops).toHaveLength(1)
    expect(asLayer(ops[0]).clipId).toBe(v.id)
  })

  it('a disabled clip is omitted (nothing renders on its track)', () => {
    const c = clip({ startS: 0, outS: 4, enabled: false })
    expect(resolveFrame(seqOf([track({ clips: [c] })]), 1).ops).toHaveLength(0)
  })

  it('picks the correct active clip among many on a track', () => {
    const a = clip({ startS: 0, outS: 2 }) // [0,2)
    const b = clip({ startS: 2, outS: 2 }) // [2,4)
    const c = clip({ startS: 4, outS: 2 }) // [4,6)
    const s = seqOf([track({ clips: [a, b, c] })])
    expect(asLayer(resolveFrame(s, 3).ops[0]).clipId).toBe(b.id)
    expect(asLayer(resolveFrame(s, 5).ops[0]).clipId).toBe(c.id)
  })
})

// --- Transitions (two-clip) -----------------------------------------------

describe('two-clip transitions', () => {
  // A [0,2), B [2,4) adjacent; crossDissolve on B.transitionIn, D=1.
  const makeAB = (trIn?: Clip['transitionIn'], trOutA?: Clip['transitionOut']) => {
    const a = clip({ startS: 0, inS: 0, outS: 2, transitionOut: trOutA })
    const b = clip({ startS: 2, inS: 0, outS: 2, transitionIn: trIn })
    return { a, b, s: seqOf([track({ clips: [a, b] })]) }
  }

  it('emits a transition op inside the window with correct progress', () => {
    const { a, b, s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    // window [2,3). At t=2.5 → progress 0.5.
    const op = asTransition(resolveFrame(s, 2.5).ops[0])
    expect(op.kind).toBe('crossDissolve')
    expect(op.progress).toBeCloseTo(0.5)
    expect(op.from.clipId).toBe(a.id)
    expect(op.to.clipId).toBe(b.id)
  })

  it('from-layer samples A PAST its out point; to-layer samples B normally', () => {
    const { s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    // At t=2.5: A.inS=0, from.sourceTimeS = 0 + (2.5-0)*1 = 2.5 (past A.outS=2).
    const op = asTransition(resolveFrame(s, 2.5).ops[0])
    expect(op.from.sourceTimeS).toBeCloseTo(2.5)
    // to.sourceTimeS = B.inS + (2.5 - 2) = 0.5
    expect(op.to.sourceTimeS).toBeCloseTo(0.5)
  })

  it('progress is 0 at the window start', () => {
    const { s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    expect(asTransition(resolveFrame(s, 2).ops[0]).progress).toBeCloseTo(0)
  })

  it('outside the window B renders as a plain layer', () => {
    const { b, s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    // window [2,3); at t=3.5 B is plain.
    const op = resolveFrame(s, 3.5).ops[0]
    const layer = asLayer(op)
    expect(layer.clipId).toBe(b.id)
    expect(layer.opacity).toBe(1)
  })

  it('A renders as a plain layer during its own span (no double-draw)', () => {
    const { a, s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    // A span [0,2) does not overlap window [2,3).
    const op = resolveFrame(s, 1).ops[0]
    expect(asLayer(op).clipId).toBe(a.id)
    expect(resolveFrame(s, 1).ops).toHaveLength(1)
  })

  it('at the window end (t=D) B is plain again, not a transition', () => {
    const { b, s } = makeAB({ type: 'crossDissolve', durationS: 1 })
    // window is [2,3) half-open; at t=3 → plain B.
    const op = resolveFrame(s, 3).ops[0]
    expect(asLayer(op).clipId).toBe(b.id)
  })

  it('A.transitionOut supplies the transition when B.transitionIn is absent', () => {
    const { a, b, s } = makeAB(undefined, { type: 'wipeLeft', durationS: 1 })
    const op = asTransition(resolveFrame(s, 2.5).ops[0])
    expect(op.kind).toBe('wipeLeft')
    expect(op.from.clipId).toBe(a.id)
    expect(op.to.clipId).toBe(b.id)
  })

  it('B.transitionIn wins over A.transitionOut', () => {
    const { s } = makeAB({ type: 'dipToBlack', durationS: 1 }, { type: 'wipeRight', durationS: 1 })
    expect(asTransition(resolveFrame(s, 2.5).ops[0]).kind).toBe('dipToBlack')
  })

  it('non-adjacent clips (a gap between them) do NOT form a transition', () => {
    const a = clip({ startS: 0, outS: 2 }) // [0,2)
    const b = clip({ startS: 3, outS: 2, transitionIn: { type: 'crossDissolve', durationS: 1 } })
    const s = seqOf([track({ clips: [a, b] })])
    // At t=3.5 (would be the window head if adjacent) there is no pair: B runs
    // its own LONE-edge transition instead (window [3,4)), against nothing.
    const op = asTransition(resolveFrame(s, 3.5).ops[0])
    expect(op.to.clipId).toBe(b.id)
    expect(op.from.clipId).toBe(b.id) // the empty side is a copy of B, at alpha 0
    expect(op.from.opacity).toBe(0)
  })
})

// --- Adjustment layers ------------------------------------------------------

describe('adjustment layers', () => {
  it('an adjustment clip on an upper track emits an adjustment op ABOVE the footage layer', () => {
    const footage = track({ clips: [clip({ startS: 0, inS: 0, outS: 4 })] })
    const adj = clip({ startS: 0, inS: 0, outS: 4, adjustment: true })
    adj.effects = [{ id: 'fx1', type: 'saturation', params: { saturation: -1 }, enabled: true }]
    const f = resolveFrame(seqOf([footage, track({ clips: [adj] })]), 1)
    expect(f.ops).toHaveLength(2)
    expect(f.ops[0].type).toBe('layer')
    const op = f.ops[1]
    expect(op.type).toBe('adjustment')
    if (op.type === 'adjustment') {
      expect(op.effects).toEqual([{ type: 'saturation', params: { saturation: -1 } }])
      expect(op.opacity).toBe(1)
      expect(op.frameSeed).toBe(30)
    }
  })

  it('fading an adjustment clip scales the op opacity (grade fades in)', () => {
    const adj = clip({ startS: 0, inS: 0, outS: 4, adjustment: true, fadeInS: 2 })
    const f = resolveFrame(seqOf([track({ clips: [adj] })]), 1)
    const op = f.ops[0]
    expect(op.type).toBe('adjustment')
    if (op.type === 'adjustment') expect(op.opacity).toBeCloseTo(0.5, 6)
  })

  it('a frame without adjustment clips emits no adjustment ops (fast path preserved)', () => {
    const f = resolveFrame(seqOf([track({ clips: [clip({ startS: 0, outS: 4 })] })]), 1)
    expect(f.ops.every((o) => o.type !== 'adjustment')).toBe(true)
  })

  it('adjustment clips never form pair transitions — the edge falls back to the lone-edge fade', () => {
    // Video clip butt-joined to an adjustment clip carrying an In transition:
    // a pair side built from an adjustment clip would be fully transparent.
    const a = clip({ startS: 0, inS: 0, outS: 2 })
    const adj = clip({
      startS: 2,
      inS: 0,
      outS: 2,
      adjustment: true,
      transitionIn: { type: 'crossDissolve', durationS: 1 },
    })
    const f = resolveFrame(seqOf([track({ clips: [a, adj] })]), 2.5)
    expect(f.ops).toHaveLength(1)
    const op = f.ops[0]
    expect(op.type).toBe('adjustment')
    // The lone-edge fade ramps the grade in: halfway through the 1s window.
    if (op.type === 'adjustment') expect(op.opacity).toBeCloseTo(0.5, 6)
  })
})

// --- activeIndex binary search ---------------------------------------------

describe('activeIndex binary search', () => {
  it('agrees with a linear scan across adjacency, gaps, and boundaries', () => {
    const clips: ReturnType<typeof clip>[] = []
    let t0 = 0
    for (let k = 0; k < 40; k++) {
      const dur = 0.5 + (k % 3) * 0.25
      clips.push(clip({ startS: t0, inS: 0, outS: dur }))
      // Half the cuts are butt-joined, half leave a gap.
      t0 += dur + (k % 2 === 0 ? 0 : 0.3)
    }
    const linear = (t: number): number => {
      let ans = -1
      for (let j = 0; j < clips.length; j++) {
        if (clips[j].startS <= t) ans = j
        else break
      }
      return ans
    }
    const probes: number[] = [-5, 0, 1e6]
    for (const c of clips) {
      const dur = c.outS - c.inS
      probes.push(c.startS, c.startS + dur / 2, c.startS + dur, c.startS + dur + 0.05)
    }
    for (const p of probes) {
      expect(_activeIndexForTest(clips, p), `probe t=${p}`).toBe(linear(p))
    }
  })

  it('a disabled containing clip resolves to no op (later clips cannot match)', () => {
    const a = clip({ startS: 0, inS: 0, outS: 2 })
    const b = clip({ startS: 2, inS: 0, outS: 2, enabled: false })
    const f = resolveFrame(seqOf([track({ clips: [a, b] })]), 3)
    expect(f.ops).toHaveLength(0)
  })
})

// --- Transition kind coercion + D clamping --------------------------------

describe('transition kind coercion', () => {
  const at = (type: string) => {
    const a = clip({ startS: 0, outS: 2 })
    const b = clip({ startS: 2, outS: 2, transitionIn: { type, durationS: 1 } })
    return asTransition(resolveFrame(seqOf([track({ clips: [a, b] })]), 2.5).ops[0])
  }

  it('coerces a valid kind (dipToWhite) through unchanged', () => {
    expect(at('dipToWhite').kind).toBe('dipToWhite')
  })

  it('coerces slideLeft/slideRight/wipeRight through', () => {
    expect(at('slideLeft').kind).toBe('slideLeft')
    expect(at('slideRight').kind).toBe('slideRight')
    expect(at('wipeRight').kind).toBe('wipeRight')
  })

  it('coerces the stylized kinds (zoom/spin/glitch/lumaWipe) through', () => {
    expect(at('zoom').kind).toBe('zoom')
    expect(at('spin').kind).toBe('spin')
    expect(at('glitch').kind).toBe('glitch')
    expect(at('lumaWipe').kind).toBe('lumaWipe')
  })

  it('an unknown type falls back to crossDissolve', () => {
    expect(at('sparkle-warp').kind).toBe('crossDissolve')
    expect(at('').kind).toBe('crossDissolve')
  })
})

describe('transition duration clamping', () => {
  it('D is clamped to the shorter neighbor duration', () => {
    // A [0,1) 1s, B [1,5) 4s. Requested D=3 → clamp to min(1,4)=1.
    const a = clip({ startS: 0, inS: 0, outS: 1 })
    const b = clip({ startS: 1, inS: 0, outS: 4, transitionIn: { type: 'crossDissolve', durationS: 3 } })
    const s = seqOf([track({ clips: [a, b] })])
    // window becomes [1,2). At t=1.5 → progress 0.5 (not 3s-based).
    expect(asTransition(resolveFrame(s, 1.5).ops[0]).progress).toBeCloseTo(0.5)
    // At t=2 → plain B (window ended at 2).
    expect(resolveFrame(s, 2).ops[0].type).toBe('layer')
  })

  it('D is clamped up to at least one frame (1/fps)', () => {
    // fps 30 → min D = 1/30. Requested tiny D=0.001.
    const a = clip({ startS: 0, outS: 2 })
    const b = clip({ startS: 2, outS: 2, transitionIn: { type: 'crossDissolve', durationS: 0.001 } })
    const s = seqOf([track({ clips: [a, b] })], { fps: 30 })
    // window [2, 2+1/30). At the half-frame the op is still a transition.
    const half = 2 + 1 / 60
    expect(resolveFrame(s, half).ops[0].type).toBe('transition')
    expect(asTransition(resolveFrame(s, half).ops[0]).progress).toBeCloseTo(0.5)
  })
})

// --- Lone-edge fades ------------------------------------------------------

describe('lone-edge transitions run their REAL form', () => {
  // A transition with no partner used to collapse to a fade-from-black opacity
  // ramp for every kind but White Flash — so "Glitch" on the head of the first
  // clip drew a black fade while the Inspector still said Glitch. The absent
  // side is now a transparent copy of the layer, which the shader treats as
  // "nothing here".

  it('a lone cross dissolve is the transition, and still resolves to the same picture', () => {
    // Single clip [0,4), transitionIn D=2, no partner.
    const c = clip({ startS: 0, inS: 0, outS: 4, transitionIn: { type: 'crossDissolve', durationS: 2 } })
    const s = seqOf([track({ clips: [c] })])

    const op = asTransition(resolveFrame(s, 0.5).ops[0])
    expect(op.kind).toBe('crossDissolve')
    expect(op.progress).toBeCloseTo(0.25)
    // mix(transparent, to, p) premultiplied IS to*p — the exact opacity ramp
    // this replaced, so nothing about a dissolve moved.
    expect(op.from.opacity).toBe(0)
    expect(op.to.opacity).toBeCloseTo(1)
    expect(asTransition(resolveFrame(s, 1).ops[0]).progress).toBeCloseTo(0.5)
  })

  it('after the window it is an ordinary layer at full opacity', () => {
    const c = clip({ startS: 0, outS: 4, transitionIn: { type: 'crossDissolve', durationS: 2 } })
    const s = seqOf([track({ clips: [c] })])
    expect(asLayer(resolveFrame(s, 3).ops[0]).opacity).toBeCloseTo(1)
  })

  it('a lone out edge runs FORWARD into nothing', () => {
    const c = clip({ startS: 0, outS: 4, transitionOut: { type: 'crossDissolve', durationS: 2 } })
    const s = seqOf([track({ clips: [c] })])
    // endS=4, window [2,4): halfway at t=3, three-quarters at t=3.5.
    const half = asTransition(resolveFrame(s, 3).ops[0])
    expect(half.progress).toBeCloseTo(0.5)
    expect(half.from.opacity).toBeCloseTo(1)
    expect(half.to.opacity).toBe(0)
    expect(asTransition(resolveFrame(s, 3.5).ops[0]).progress).toBeCloseTo(0.75)
    expect(asLayer(resolveFrame(s, 1).ops[0]).opacity).toBeCloseTo(1)
  })

  it('carries the clip base opacity into the live side, so it still multiplies', () => {
    const c = clip({
      startS: 0,
      outS: 4,
      opacity: 0.5,
      transitionIn: { type: 'crossDissolve', durationS: 2 },
    })
    const s = seqOf([track({ clips: [c] })])
    const op = asTransition(resolveFrame(s, 1).ops[0])
    expect(op.to.opacity).toBeCloseTo(0.5)
    expect(op.progress).toBeCloseTo(0.5) // 0.5 * 0.5 = the old 0.25
  })

  it('D still clamps to at least one frame, and to the clip duration', () => {
    const short = clip({ startS: 0, outS: 4, transitionIn: { type: 'crossDissolve', durationS: 0 } })
    const s30 = seqOf([track({ clips: [short] })], { fps: 30 })
    expect(asTransition(resolveFrame(s30, 0).ops[0]).progress).toBeCloseTo(0)
    expect(asTransition(resolveFrame(s30, 1 / 60).ops[0]).progress).toBeCloseTo(0.5)

    // clip 1s, requested 5s → clamped to 1s, so t=0.5 is halfway.
    const long = clip({ startS: 0, inS: 0, outS: 1, transitionIn: { type: 'crossDissolve', durationS: 5 } })
    const s1 = seqOf([track({ clips: [long] })])
    expect(asTransition(resolveFrame(s1, 0.5).ops[0]).progress).toBeCloseTo(0.5)
  })

  it('THE BUG: a lone Glitch is a glitch, not a fade to black', () => {
    const c = clip({ startS: 0, outS: 4, transitionIn: { type: 'glitch', durationS: 0.2 } })
    const s = seqOf([track({ clips: [c] })])
    const op = asTransition(resolveFrame(s, 0.1).ops[0])
    expect(op.kind).toBe('glitch')
    expect(op.from.opacity).toBe(0)
  })

  it('every kind keeps its own identity on a lone edge', () => {
    for (const kind of ['wipeLeft', 'slideRight', 'zoom', 'spin', 'lumaWipe', 'dipToWhite'] as const) {
      const c = clip({ startS: 0, outS: 4, transitionIn: { type: kind, durationS: 1 } })
      const s = seqOf([track({ clips: [c] })])
      expect(asTransition(resolveFrame(s, 0.5).ops[0]).kind).toBe(kind)
    }
  })

  it('an adjustment layer keeps the opacity ramp — it has no texture to transition', () => {
    const c = clip({
      startS: 0,
      outS: 4,
      adjustment: true,
      transitionIn: { type: 'wipeLeft', durationS: 2 },
    })
    const s = seqOf([track({ clips: [c] })])
    const op = resolveFrame(s, 1).ops[0]
    expect(op.type).toBe('adjustment')
  })

  it('a lone clip with no transitions renders at full opacity throughout', () => {
    const c = clip({ startS: 0, outS: 4 })
    const s = seqOf([track({ clips: [c] })])
    expect(asLayer(resolveFrame(s, 0).ops[0]).opacity).toBe(1)
    expect(asLayer(resolveFrame(s, 3.99).ops[0]).opacity).toBe(1)
  })
})

describe('precedence', () => {
  it('a two-clip transition takes over the window, not a lone fade', () => {
    // B has transitionIn AND an adjacent previous A → two-clip transition,
    // NOT a lone fade-in.
    const a = clip({ startS: 0, outS: 2 })
    const b = clip({ startS: 2, outS: 2, transitionIn: { type: 'crossDissolve', durationS: 1 } })
    const s = seqOf([track({ clips: [a, b] })])
    // window [2,3): at t=2.5 → transition op (from A + to B), NOT a faded layer.
    const op = resolveFrame(s, 2.5).ops[0]
    expect(op.type).toBe('transition')
    const tr = asTransition(op)
    expect(tr.from.clipId).toBe(a.id)
    expect(tr.to.clipId).toBe(b.id)
  })

  it("A's transitionOut with an adjacent next clip does not lone-fade A", () => {
    // A adjacent to B, A.transitionOut set → two-clip transition at B head;
    // A itself renders plainly (full opacity) during its own span.
    const a = clip({ startS: 0, outS: 2, transitionOut: { type: 'crossDissolve', durationS: 1 } })
    const b = clip({ startS: 2, outS: 2 })
    const s = seqOf([track({ clips: [a, b] })])
    // During A's span the opacity is full (no lone fade-out).
    expect(asLayer(resolveFrame(s, 1.5).ops[0]).opacity).toBe(1)
    // The transition lives at B's head window [2,3).
    expect(resolveFrame(s, 2.5).ops[0].type).toBe('transition')
  })

  it('B.transitionIn with an adjacent previous clip does not lone-fade B', () => {
    const a = clip({ startS: 0, outS: 2 })
    const b = clip({ startS: 2, outS: 4, transitionIn: { type: 'crossDissolve', durationS: 1 } })
    const s = seqOf([track({ clips: [a, b] })])
    // Just past the window (t=3.5) B is plain at full opacity — no residual fade.
    expect(asLayer(resolveFrame(s, 3.5).ops[0]).opacity).toBe(1)
  })
})
