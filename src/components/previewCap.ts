// The preview redraw cap, and the two things it got wrong.
//
// Monitor's draw loop refuses to paint twice inside one cap interval, so a
// 144/240 Hz display does not composite 2-4x more often than anything changed.
// That ceiling is right. How it was compared was not, and MEASURED on his RTX
// 4060 it cost him about a third of every 60 fps timeline he has ever played
// (_verify/preview-fps-control.mjs, one long clip, no effects, no transitions:
// 30 fps sequence 0.6% dropped, 60 fps sequence 31.7% dropped, median paint gap
// 33 ms on a timeline whose frames come due every 16.7 ms).
//
// Same harness, same GPU, with what is below: 60 fps sequence 31.7% -> 0.0%
// dropped, 40.8 -> 60.1 Hz painted, 33 -> 17 ms median gap, and the 30 fps
// sequence unmoved at 30.3 Hz, which is the check that this raised the ceiling
// for the timeline that needed it and not the redraw rate in general.
// _verify/preview-cap-ab.mjs, which A/B'd this cap against a cap of 240: the
// shipped arm went 22.3% -> 0.0% on a bare clip and 29.2% -> 0.0% on his real
// stack (24 cuts, the Jettism look, a cross dissolve at every cut), so it now
// measures the same as the raised cap and there is nothing left to raise.
//
// 1. THE BEAT. The ceiling was a fixed 60, so the interval was 16.667 ms, and on
//    a 60 Hz display the rAF ticks arrive 16.67 ms apart WITH JITTER. A tick
//    landing a hair early failed `since < 16.667`, that frame was skipped, and
//    the next tick came 33 ms later. The loop beat against its own cap. It is
//    invisible on a 30 fps sequence, where the skipped tick leaves the SAME
//    frame index due and it paints next tick; on a 60 fps sequence the skipped
//    tick IS a lost timeline frame. Fix: a tick may run early by up to half the
//    interval it actually observed between ticks. Half a tick is the honest
//    rounding: painting on the tick NEAREST the deadline, rather than only ever
//    on the first one past it. The ceiling still holds on a fast display, where
//    half a tick is small (2.1 ms at 240 Hz) and three ticks in four still fail.
//
// 2. THE FIXED 60. A ceiling below the rate the timeline needs is not a cap, it
//    is a dropped frame by arithmetic. 60 is a FLOOR now: a 120 fps sequence
//    raises it to 120. (His camera is 60 and the sequence adopts it, so 60 is
//    what was measured; the max() is there so the same bug cannot come back one
//    faster camera later.)
//
// This is a PREVIEW DELIVERY decision only. It changes when a frame is painted,
// never what is in it: nothing here reaches the renderer, so preview and export
// stay the pixel-identical pair glRenderer.ts exists to keep them.

/**
 * The shortest gap allowed between two preview paints, in ms.
 *
 * `capFps` is the floor (Monitor's MAX_PREVIEW_FPS) and `seqFps` raises it when
 * the timeline runs faster than the floor. A non-positive or non-finite seqFps
 * (an empty or half-built sequence) simply leaves the floor standing.
 */
export function previewFrameMs(capFps: number, seqFps: number): number {
  const wanted = Number.isFinite(seqFps) && seqFps > 0 ? seqFps : 0
  const fps = Math.max(capFps, wanted)
  return fps > 0 ? 1000 / fps : 0
}

/**
 * Is a paint due on this tick? `sinceLastDrawMs` is now minus the last paint
 * (Infinity before the first one), `tickMs` the gap since the previous rAF tick
 * (0 when there is no previous tick yet, which just asks the question exactly).
 *
 * The slack is half the OBSERVED tick, clamped to half the interval so a
 * backgrounded tab returning with a 1000 ms gap cannot turn the cap off.
 */
export function drawIsDue(sinceLastDrawMs: number, frameMs: number, tickMs: number): boolean {
  const observed = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 0
  const slack = Math.min(observed, frameMs) / 2
  return sinceLastDrawMs >= frameMs - slack
}
