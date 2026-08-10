// The cap that dropped a third of his frames, pinned as arithmetic.
//
// This is a SIMULATION of the draw loop's pacing gate, not of the draw: real
// rAF ticks arrive at the display interval with a few tenths of a millisecond of
// jitter, and the whole bug lives in how a fixed 16.667 ms deadline compares
// against a 16.667 ms tick. Feeding a jittered tick stream through both rules
// reproduces it without a browser, and the numbers below land on the ones the
// GPU harness measured (_verify/preview-fps-control.mjs: 40.8 Hz painted on a
// 60 fps timeline, 31.7% of its frames never delivered).

import { describe, expect, it } from 'vitest'
import { drawIsDue, previewFrameMs } from './previewCap'

const MAX_PREVIEW_FPS = 60

/** The rule as it shipped: a hard deadline, no allowance for an early tick. */
const shippedRule = (sinceMs: number, frameMs: number): boolean => sinceMs >= frameMs

/**
 * Deterministic sub-millisecond jitter, so a run is reproducible but no tick
 * lands exactly on its nominal time. Amplitude is in ms, applied to the tick's
 * ABSOLUTE time so the mean interval stays the display interval.
 *
 * A HASH, not a counter stepped by a constant: an evenly drifting offset makes
 * every interval the same length as the last and the beat never appears, which
 * is the difference between this file reproducing the bug and flattering it.
 */
const jitter = (i: number, ampMs: number): number => {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 2 * ampMs
}

function displayTicks(hz: number, seconds: number, ampMs = 0.3): number[] {
  const step = 1000 / hz
  const out: number[] = []
  for (let i = 0; i * step < seconds * 1000; i++) out.push(i * step + jitter(i, ampMs))
  return out
}

/** Run a tick stream through a pacing rule. Returns paints/second and the worst gap. */
function play(
  ticks: number[],
  frameMs: number,
  rule: (sinceMs: number, frameMs: number, tickMs: number) => boolean,
): { paintHz: number; worstGapMs: number } {
  let lastDraw = -Infinity
  let lastTick = 0
  let paints = 0
  let worstGapMs = 0
  for (const t of ticks) {
    const tickMs = lastTick > 0 ? t - lastTick : 0
    lastTick = t
    if (!rule(t - lastDraw, frameMs, tickMs)) continue
    if (Number.isFinite(lastDraw)) worstGapMs = Math.max(worstGapMs, t - lastDraw)
    lastDraw = t
    paints++
  }
  const spanS = (ticks[ticks.length - 1] - ticks[0]) / 1000
  return { paintHz: spanS > 0 ? paints / spanS : 0, worstGapMs }
}

describe('previewFrameMs: 60 is a floor, not a ceiling', () => {
  it('holds the 60 fps floor for every timeline slower than it', () => {
    expect(previewFrameMs(MAX_PREVIEW_FPS, 30)).toBeCloseTo(1000 / 60, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, 24)).toBeCloseTo(1000 / 60, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, 60)).toBeCloseTo(1000 / 60, 10)
  })

  it('raises the ceiling to the timeline when the timeline is faster', () => {
    // A ceiling under the rate the sequence needs is not a cap, it is a dropped
    // frame by arithmetic. This is the same bug as the beat below, arriving via
    // a faster camera instead of via jitter.
    expect(previewFrameMs(MAX_PREVIEW_FPS, 120)).toBeCloseTo(1000 / 120, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, 240)).toBeCloseTo(1000 / 240, 10)
  })

  it('leaves the floor standing for a sequence with no usable frame rate', () => {
    expect(previewFrameMs(MAX_PREVIEW_FPS, 0)).toBeCloseTo(1000 / 60, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, -30)).toBeCloseTo(1000 / 60, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, Number.NaN)).toBeCloseTo(1000 / 60, 10)
    expect(previewFrameMs(MAX_PREVIEW_FPS, Number.POSITIVE_INFINITY)).toBeCloseTo(1000 / 60, 10)
  })
})

describe('drawIsDue: a tick a hair early is still this frame', () => {
  const frameMs = 1000 / 60

  it('THE SCAR: 16.5 ms after the last paint, on a 16.67 ms display, is due', () => {
    // The shipped rule said no, so the frame was skipped and the next tick came
    // 33 ms later. On a 30 fps sequence that is free; on a 60 fps sequence that
    // is the frame, gone.
    expect(shippedRule(16.5, frameMs)).toBe(false)
    expect(drawIsDue(16.5, frameMs, 16.67)).toBe(true)
  })

  it('paints the first frame, with no previous paint or tick to compare against', () => {
    expect(drawIsDue(Number.POSITIVE_INFINITY, frameMs, 0)).toBe(true)
  })

  it('still refuses a tick that is genuinely early, which is the whole point of a cap', () => {
    // 240 Hz: three ticks in four must still fail, or the cap has been deleted
    // rather than fixed.
    expect(drawIsDue(4.17, frameMs, 4.17)).toBe(false)
    expect(drawIsDue(8.33, frameMs, 4.17)).toBe(false)
    expect(drawIsDue(12.5, frameMs, 4.17)).toBe(false)
    expect(drawIsDue(16.67, frameMs, 4.17)).toBe(true)
  })

  it('cannot be switched off by a backgrounded tab returning with a huge tick', () => {
    // Slack is clamped to half the INTERVAL, so a 1000 ms gap between ticks
    // still buys at most 8.3 ms of earliness.
    expect(drawIsDue(4, frameMs, 1000)).toBe(false)
    expect(drawIsDue(8.4, frameMs, 1000)).toBe(true)
  })

  it('asks the question exactly when there is no tick interval yet', () => {
    expect(drawIsDue(16.5, frameMs, 0)).toBe(false)
    expect(drawIsDue(16.7, frameMs, 0)).toBe(true)
  })
})

describe('what the two rules deliver on a real display', () => {
  const frame60 = previewFrameMs(MAX_PREVIEW_FPS, 60)

  it('SHIPPED: a 60 Hz display on a 60 fps timeline painted about 40 Hz, not 60', () => {
    const { paintHz, worstGapMs } = play(displayTicks(60, 8), frame60, shippedRule)
    // The GPU harness measured 40.8 Hz painted and a 33 ms median gap; the gate
    // arithmetic alone lands on 38 Hz and a 34 ms worst gap. That is what says
    // the cap is the cause and not the shaders: no GPU is involved here at all.
    expect(paintHz).toBeGreaterThan(34)
    expect(paintHz).toBeLessThan(44)
    expect(worstGapMs).toBeGreaterThan(30)
  })

  it('FIXED: the same display and timeline paints every frame', () => {
    const { paintHz, worstGapMs } = play(displayTicks(60, 8), frame60, drawIsDue)
    expect(paintHz).toBeGreaterThan(58)
    expect(worstGapMs).toBeLessThan(20)
  })

  it('FIXED: a 240 Hz display is still capped near 60, which is why the cap exists', () => {
    const { paintHz } = play(displayTicks(240, 8), frame60, drawIsDue)
    expect(paintHz).toBeGreaterThan(55)
    expect(paintHz).toBeLessThan(65)
  })

  it('FIXED: a 144 Hz display lands on the nearest tick to 60, which is 72', () => {
    // 144 does not divide by 60, so the honest answers are 72 and 48. Painting
    // on the NEARER tick is the one that never leaves a frame undelivered.
    const { paintHz } = play(displayTicks(144, 8), frame60, drawIsDue)
    expect(paintHz).toBeGreaterThan(66)
    expect(paintHz).toBeLessThan(78)
  })

  it('FIXED: a 120 fps timeline on a 240 Hz display gets all 120', () => {
    const { paintHz } = play(displayTicks(240, 8), previewFrameMs(MAX_PREVIEW_FPS, 120), drawIsDue)
    expect(paintHz).toBeGreaterThan(112)
    expect(paintHz).toBeLessThan(128)
  })

  it('leaves the stalled-frame trickle a trickle', () => {
    // Monitor drops to a 250 ms poll once a frame has been pending far longer
    // than any decode should take. Half a 16 ms tick of slack must not turn that
    // back into a redraw loop.
    const { paintHz } = play(displayTicks(60, 8), 250, drawIsDue)
    expect(paintHz).toBeGreaterThan(3.5)
    expect(paintHz).toBeLessThan(4.5)
  })
})
