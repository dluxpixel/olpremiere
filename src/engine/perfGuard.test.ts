// Perf guard (spec section 4): a regression tripwire for the two hot paths a
// drag or scrub hammers on a big timeline.
//
//   resolveFrame       runs once per rAF during playback and scrubbing, and
//                      once per frame in export. At 60fps the WHOLE frame has
//                      16.7ms; the resolver must be a rounding error in it.
//   collectSnapPoints  runs on every pointer-move of a snapped drag or trim
//                      (Timeline.tsx snapping helpers), so it shares the same
//                      16.7ms with React work and paint.
//
// Methodology: build a 200-clip sequence (160 video clips across 4 tracks with
// keyframes, effects, transitions and fades sprinkled in, plus 40 audio clips
// and 12 markers), warm the JIT, then time several rounds and take the BEST
// round's per-call average. Best-of-rounds filters scheduler and GC noise; a
// real algorithmic regression (say the resolver's binary search reverting to a
// linear scan of a quadratic) inflates every round, so the tripwire still
// fires.
//
// Budgets are RELATIVE to a calibration workload measured in the same process
// moments earlier - see the Budgets block below for why absolute milliseconds
// could not work here. For scale, the absolute cost when measured idle is
// roughly 0.005 ms and 0.015 ms per call: both together are well under 0.2
// percent of a 16.7 ms frame.
//
// If this test trips, something made a per-frame path about half again slower.
// Fix the regression; only re-measure and raise a budget if the hot path took
// on genuinely new required work (and document the new measurement here).

import { describe, expect, it } from 'vitest'
import { collectSnapPoints } from './timeline'
import { resolveFrame } from './render/resolve'
import {
  defaultTransform,
  type Clip,
  type EffectInstance,
  type Keyframe,
  type Marker,
  type Sequence,
  type Track,
} from './types'

// --- Budgets ---------------------------------------------------------------
//
// Expressed as a MULTIPLE of a calibration workload measured in the same
// process moments earlier, not as an absolute millisecond figure.
//
// Absolute budgets do not survive a parallel test runner. Vitest runs 70 files
// across worker processes, so this file benches while the machine is saturated;
// best-of-N rounds does not save you when all N rounds are slow. The result was
// a guard that went red on unrelated code and green on a re-run (three of each
// in one session), which is worse than no guard, because a gate that cries wolf
// is a gate people stop reading.
//
// A ratio cancels the machine and the load: both numbers are measured under the
// same conditions, so only the RELATIVE cost of the code under test remains.

// Measured on this machine across six runs, idle and with all 71 files running:
// resolveFrame 0.24-0.31x, collectSnapPoints 0.53-0.74x. The budgets sit at
// roughly 1.7x the worst observed, which is the same headroom the absolute
// budgets they replace were chosen with, so a real regression of half again
// still trips it, and ordinary noise never does.
const RESOLVE_FRAME_BUDGET_X = 0.55
const SNAP_POINTS_BUDGET_X = 1.2

// --- Fixture: a 200-clip sequence ------------------------------------------

let uid = 0
const id = (p: string): string => `${p}-${uid++}`

const kf = (t: number, value: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({
  t,
  value,
  ease,
})

function clip(over: Partial<Clip>): Clip {
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

/** A non-neutral effect (amount off its 0 default), so resolve cannot skip it. */
const gradeEffect = (): EffectInstance => ({
  id: id('fx'),
  type: 'autoColor',
  params: { amount: 0.6 },
  enabled: true,
})

/**
 * One lane of back-to-back 2s clips. Every 3rd clip animates scale + opacity,
 * every 4th carries a grade, every 10th opens with a cross dissolve from its
 * neighbour, every 7th has fade handles: the mix a real edit accumulates, so
 * the resolver exercises its keyframe, effect and transition branches instead
 * of the all-defaults fast path.
 */
function videoLane(name: string, clipCount: number): Track {
  const clips: Clip[] = []
  for (let i = 0; i < clipCount; i++) {
    clips.push(
      clip({
        startS: i * 2,
        ...(i % 3 === 0
          ? {
              keyframes: {
                scale: [kf(0, 1), kf(1, 1.2, 'easeInOut'), kf(2, 1)],
                opacity: [kf(0, 0), kf(0.4, 1)],
              },
            }
          : {}),
        ...(i % 4 === 0 ? { effects: [gradeEffect()] } : {}),
        ...(i % 10 === 5 ? { transitionIn: { type: 'crossDissolve', durationS: 0.5 } } : {}),
        ...(i % 7 === 0 ? { fadeInS: 0.25, fadeOutS: 0.25 } : {}),
      }),
    )
  }
  return {
    id: id('track'),
    kind: 'video',
    name,
    height: 64,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips,
  }
}

/** Audio lanes only feed collectSnapPoints here, so plain spaced clips do. */
function audioLane(name: string, clipCount: number): Track {
  const clips: Clip[] = []
  for (let i = 0; i < clipCount; i++) clips.push(clip({ startS: i * 4, outS: 3 }))
  return {
    id: id('track'),
    kind: 'audio',
    name,
    height: 48,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips,
  }
}

function bigSequence(): Sequence {
  // 4 video tracks x 40 clips + 2 audio tracks x 20 clips = 200 clips.
  const tracks = [
    videoLane('V1', 40),
    videoLane('V2', 40),
    videoLane('V3', 40),
    videoLane('V4', 40),
    audioLane('A1', 20),
    audioLane('A2', 20),
  ]
  const markers: Marker[] = []
  for (let i = 0; i < 12; i++) {
    markers.push({ id: id('marker'), t: i * 6.5, label: `M${i}`, color: '#ffa946' })
  }
  return {
    id: id('seq'),
    name: 'Perf guard',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 80,
    tracks,
    markers,
  }
}

// --- Timing ----------------------------------------------------------------

/**
 * Per-call average of the BEST of `rounds` rounds, ms. The first rounds double
 * as JIT warmup; taking the minimum discards GC pauses and scheduler noise
 * while a genuine slowdown still shows in every round.
 */
function bench(fn: () => void, iterations: number, rounds: number): number {
  let best = Infinity
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    best = Math.min(best, (performance.now() - t0) / iterations)
  }
  return best
}

// Results feed this sink so the benched calls can never be dead-code
// eliminated, and the assertions on it double-check the fixture is real.
let sink = 0

/**
 * The yardstick: a fixed unit of work benched exactly like the code under test,
 * so dividing by it cancels the CPU and whatever else the machine is doing.
 *
 * It has to have the same CHARACTER as what it measures, or it cancels nothing.
 * A tight arithmetic loop was tried first and was useless here: it lives in L1
 * and barely moved under a saturated machine (0.00273 → 0.00284 ms) while
 * collectSnapPoints (which allocates, walks objects and sorts) went up half
 * again. So the calibration allocates, walks and sorts too.
 */
function calibrationMs(): number {
  return bench(
    () => {
      const xs: { t: number }[] = []
      for (let i = 0; i < 200; i++) xs.push({ t: (i * 37) % 200 })
      xs.sort((a, b) => a.t - b.t)
      let acc = 0
      for (const x of xs) acc += x.t
      sink += acc
    },
    200,
    7,
  )
}

describe('perf guard: 200-clip sequence', () => {
  const seq = bigSequence()

  it('fixture really holds 200 clips and resolves layers', () => {
    const clipCount = seq.tracks.reduce((n, t) => n + t.clips.length, 0)
    expect(clipCount).toBe(200)
    // Mid-timeline, all four video lanes are showing something.
    expect(resolveFrame(seq, 41.2).ops.length).toBe(4)
  })

  it(`resolveFrame stays under ${RESOLVE_FRAME_BUDGET_X}x the calibration while scrubbing`, () => {
    // A scrub visits scattered times, not one hot frame: stride 0.73s lands on
    // clip bodies, transition windows, fades and gaps all over the sequence.
    const times: number[] = []
    for (let i = 0; i < 512; i++) times.push((i * 0.73) % seq.durationS)
    let cursor = 0
    const perCallMs = bench(
      () => {
        sink += resolveFrame(seq, times[cursor++ % times.length]).ops.length
      },
      2000,
      7,
    )
    expect(sink).toBeGreaterThan(0)
    const cal = calibrationMs()
    expect(perCallMs / cal).toBeLessThan(RESOLVE_FRAME_BUDGET_X)
  })

  it(`collectSnapPoints stays under ${SNAP_POINTS_BUDGET_X}x the calibration while dragging`, () => {
    // Shaped like Timeline.tsx's snapped drag: exclude the dragged clip's
    // group and include the playhead, every pointer-move.
    const dragged = seq.tracks[1].clips[20]
    const perCallMs = bench(
      () => {
        sink += collectSnapPoints(seq, {
          excludeClipIds: [dragged.id],
          playheadS: 41.2,
        }).length
      },
      1000,
      7,
    )
    expect(sink).toBeGreaterThan(0)
    const cal = calibrationMs()
    expect(perCallMs / cal).toBeLessThan(SNAP_POINTS_BUDGET_X)
  })
})
