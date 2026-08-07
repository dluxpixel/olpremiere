// The delivery counter, and why it exists.
//
// previewHealth answers "was the picture the right frame" and cannot answer
// "did the picture arrive at all". Three separate harnesses reported the
// preview as healthy while he was watching it stutter, because a loop that
// paints every other frame scores a perfect zero error on the frames it does
// paint: the dropped ones are never sampled. These tests pin the difference.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { previewPacing, recordPreviewTick, resetPreviewPacing } from './previewTruth'
import { resolveFrame } from './render/resolve'
import { MOTION_CURVES } from './motion'
import type { RenderLayer, RenderOp } from './render/types'
import {
  defaultTransform,
  type Clip,
  type Curve,
  type Keyframe,
  type Sequence,
  type Track,
} from './types'

/** Drive performance.now() by hand so a test never depends on wall clock. */
let clock = 0
beforeEach(() => {
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  resetPreviewPacing()
})

const tick = (frame: number, painted: boolean, advanceMs = 8) => {
  recordPreviewTick(frame, painted)
  clock += advanceMs
}

describe('previewPacing', () => {
  it('reports nothing rather than a flattering zero before anything plays', () => {
    expect(previewPacing().ticks).toBe(0)
    expect(previewPacing().droppedRatio).toBe(0)
  })

  it('a loop that paints every frame drops nothing', () => {
    for (let f = 0; f < 20; f++) {
      tick(f, true, 16)
      tick(f, false, 16) // the second vsync of the same frame paints nothing, correctly
    }
    const p = previewPacing(60_000)
    expect(p.due).toBe(20)
    expect(p.painted).toBe(20)
    expect(p.droppedRatio).toBe(0)
    expect(p.worstHitchFrames).toBe(0)
  })

  // THE CASE THE OLD MEASUREMENT COULD NOT SEE.
  it('a loop that paints every OTHER frame is reported as half dropped', () => {
    for (let f = 0; f < 20; f++) tick(f, f % 2 === 0, 16)
    const p = previewPacing(60_000)
    expect(p.due).toBe(20)
    expect(p.painted).toBe(10)
    expect(p.droppedRatio).toBeCloseTo(0.5, 2)
  })

  it('counts a frame as delivered when ANY tick that saw it painted', () => {
    tick(7, false, 8)
    tick(7, false, 8)
    tick(7, true, 8) // late, but it did reach the screen
    const p = previewPacing(60_000)
    expect(p.due).toBe(1)
    expect(p.painted).toBe(1)
  })

  it('names the longest run of frames that never reached the screen', () => {
    tick(0, true, 16)
    for (const f of [1, 2, 3, 4]) tick(f, false, 16) // a four-frame freeze
    tick(5, true, 16)
    tick(6, false, 16)
    tick(7, true, 16)
    expect(previewPacing(60_000).worstHitchFrames).toBe(4)
  })

  it('measures the gap between PAINTS, which is what a freeze looks like', () => {
    tick(0, true, 16)
    tick(1, false, 16)
    tick(2, false, 16)
    tick(3, false, 16)
    tick(4, true, 16)
    tick(5, true, 16)
    const p = previewPacing(60_000)
    // Paints at +0, +64, +80: gaps of 64 and 16.
    expect(p.worstGapMs).toBe(64)
    expect(p.medianGapMs).toBe(64)
  })

  it('only counts what happened inside the window it was asked about', () => {
    tick(0, true, 16)
    tick(1, true, 16)
    clock += 5000 // long gone
    tick(2, true, 16)
    tick(3, true, 16)
    expect(previewPacing(1000).due).toBe(2)
  })

  it('forgets the run when playback starts or stops', () => {
    for (let f = 0; f < 5; f++) tick(f, false, 16)
    expect(previewPacing(60_000).due).toBe(5)
    resetPreviewPacing()
    expect(previewPacing(60_000).ticks).toBe(0)
  })

  it('a playhead that runs backwards (a loop wrap) still counts frames', () => {
    tick(30, true, 16)
    tick(0, true, 16) // wrapped
    tick(1, true, 16)
    const p = previewPacing(60_000)
    expect(p.due).toBe(3)
    expect(p.painted).toBe(3)
    expect(p.droppedRatio).toBe(0)
  })
})

// --- The other half of preview truth: it must predict the EXPORT -----------
//
// The counter above answers "did the picture arrive". This answers "was it the
// picture he will get on export", which is the claim curves rest on: preview.ts
// and exportWorker.ts both reach the bezier through resolveFrame, so there is
// one code path and no second interpolator to drift.
//
// The sweep orders below are the real difference between the two. Export walks
// startS + f/fps strictly forward, once each. Preview scrubs: it revisits, it
// runs backwards, it lands on the same instant after a hundred others. If
// anything on that path ever memoises per clip or per channel, the scrubbed
// value silently stops matching the exported one, and he only finds out after
// the render. Frame-for-frame equality here is EXACT, not close: a resolver
// that is pure has no excuse for a last-bit difference.

let fid = 0
const fixtureId = (p: string): string => `${p}-${fid++}`

const ckf = (t: number, value: number, curve?: Curve): Keyframe => ({
  t,
  value,
  ease: 'linear',
  ...(curve ? { curve } : {}),
})

const asLayer = (op: RenderOp): RenderLayer => {
  expect(op.type).toBe('layer')
  if (op.type !== 'layer') throw new Error('not a layer')
  return op.layer
}

/**
 * One 4s clip whose scale punches on the snap curve and then travels through an
 * OVERSHOOT segment, so the sweep crosses a stretch where y goes past 1 and
 * comes back. A resolver that clamped y would still pass a linear parity check;
 * it cannot pass this one.
 */
function curvedSequence(): Sequence {
  const c: Clip = {
    id: fixtureId('clip'),
    assetId: fixtureId('asset'),
    startS: 0,
    inS: 0,
    outS: 4,
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    keyframes: {
      scale: [ckf(0, 1, MOTION_CURVES.snapIn), ckf(1, 1.2, MOTION_CURVES.overshoot), ckf(3, 1.5)],
      posX: [ckf(0, 0, MOTION_CURVES.overshoot), ckf(2, 100)],
    },
  }
  const t: Track = {
    id: fixtureId('track'),
    kind: 'video',
    name: 'V1',
    height: 64,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [c],
  }
  return {
    id: fixtureId('seq'),
    name: 'Seq',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 4,
    tracks: [t],
    markers: [],
  }
}

/** Scale and position as the renderer would receive them at one instant. */
function framingAt(seq: Sequence, t: number): { scale: number; x: number; y: number } {
  const { transform } = asLayer(resolveFrame(seq, t).ops[0])
  return { scale: transform.scale, x: transform.x, y: transform.y }
}

describe('preview equals export on curved keyframes', () => {
  const seq = curvedSequence()
  const fps = seq.fps
  const frames = Math.round(seq.durationS * fps) - 1
  const frameTimeS = (f: number): number => f / fps

  it('resolves every export frame to the same framing a scrub lands on', () => {
    // Export: strictly forward, each frame once, exactly as exportWorker sweeps.
    const exported = new Map<number, { scale: number; x: number; y: number }>()
    for (let f = 0; f < frames; f++) exported.set(f, framingAt(seq, frameTimeS(f)))

    // Preview: the same instants, reached the way a scrub reaches them.
    const scrub: number[] = []
    for (let f = frames - 1; f >= 0; f--) scrub.push(f)
    for (let f = 0; f < frames; f += 7) scrub.push(f)
    for (let f = 0; f < frames; f++) scrub.push((f * 13) % frames)

    for (const f of scrub) {
      // Exact, not toBeCloseTo: one function, one instant, one answer.
      expect(framingAt(seq, frameTimeS(f))).toEqual(exported.get(f))
    }
  })

  it('carries the overshoot into the exported frame instead of clipping it', () => {
    // The segment leaving t=1 travels 1.2 → 1.5 on the overshoot curve, so
    // somewhere inside it the scale must exceed the 1.5 it is heading for.
    let peak = -Infinity
    for (let f = 0; f < frames; f++) peak = Math.max(peak, framingAt(seq, frameTimeS(f)).scale)
    expect(peak).toBeGreaterThan(1.5)
    // And it comes back: the last keyframe still lands exactly on its value.
    expect(framingAt(seq, 3).scale).toBeCloseTo(1.5, 6)
  })

  it('holds the curved channels steady past the last keyframe, both paths alike', () => {
    // The tail is where a stateful resolver would most easily disagree with
    // itself, because export arrives there once and a scrub arrives repeatedly.
    const tail = framingAt(seq, 3.9)
    expect(framingAt(seq, 0.5)).not.toEqual(tail)
    expect(framingAt(seq, 3.9)).toEqual(tail)
    expect(tail.scale).toBeCloseTo(1.5, 6)
    expect(tail.x).toBeCloseTo(100, 6)
  })
})
