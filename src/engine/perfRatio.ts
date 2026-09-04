// The yardstick every performance budget in this repo is measured against.
//
// ⛔ ABSOLUTE MILLISECOND BUDGETS DO NOT SURVIVE THE SHIP GATE, AND THIS FILE
// EXISTS BECAUSE THAT LESSON WAS LEARNED TWICE AND APPLIED ONCE.
//
// `perfGuard.test.ts` moved to ratios on 2026-08-15 after two ships were thrown
// away by budgets that were green on a quiet machine and red with
// electron-builder packaging beside the tests. Its note says so at length. The
// gap-closing budget in `timeline.test.ts` read that note, decided best-of-N was
// "the cheaper half of it and enough here", and then threw away two more gates
// on 2026-08-28 and 2026-08-31: 29.7 ms against a 20 ms budget under load, and
// three green runs in a row the moment the machine was idle.
//
// Best-of-N does not save you when every round is slow. A ratio does, because
// both numbers are measured under the same conditions and the machine cancels.
//
// So the harness lives here now and both tests import it. It is pure, it has no
// imports of its own, and nothing in the app calls it: it is a test harness that
// happens to live outside a `.test.ts` so that two test files can share it
// rather than keeping two copies that drift.

let sink = 0

/**
 * The yardstick workload: allocate, sort and sum. Chosen because it exercises
 * the allocator, a comparison sort and a tight loop, which is the same mix the
 * code under test pays for, so the ratio stays meaningful rather than measuring
 * pure arithmetic against pointer-chasing.
 *
 * ⚠️ NEVER CHANGE THIS WITHOUT RE-MEASURING EVERY BUDGET THAT DIVIDES BY IT.
 * The budgets are multiples of this exact work; a faster or slower yardstick
 * moves all of them at once.
 */
export function calibrationWork(): void {
  const xs: { t: number }[] = []
  for (let i = 0; i < 200; i++) xs.push({ t: (i * 37) % 200 })
  xs.sort((a, b) => a.t - b.t)
  let acc = 0
  for (const x of xs) acc += x.t
  sink += acc
}

/** Keeps the optimiser from deleting the yardstick as dead code. */
export const calibrationSink = (): number => sink

const CAL_ITERATIONS = 200

/** One round of the yardstick, per call, ms. */
export function calibrationRoundMs(): number {
  const t0 = performance.now()
  for (let i = 0; i < CAL_ITERATIONS; i++) calibrationWork()
  return (performance.now() - t0) / CAL_ITERATIONS
}

/**
 * The work measured AGAINST the yardstick, both timed in the SAME window.
 *
 * ⛔ THIS USED TO BE TWO SEPARATE BENCHES DIVIDED AFTERWARDS, AND IT THREW AWAY
 * TWO SHIPS ON 2026-08-15. The workload was benched, then the calibration was
 * benched, and each took the best of its own rounds. On an idle machine that is
 * fine. Inside the ship gate the load swings hard enough that the two bests can
 * land in different weather: `collectSnapPoints` read 1.4997x against a 1.2x
 * budget while the same commit passed three times running on a quiet machine.
 *
 * ⛔ AND THE ANSWER WAS NOT A LOOSER BUDGET. What changed is that each ROUND now
 * times the work and the yardstick back to back and forms its own ratio, and the
 * best of those ratios is the answer. A genuine slowdown still shows in every
 * round, so it still fires; load that arrives between two measurements no longer
 * counts as one.
 */
export function benchRatio(
  fn: () => void,
  iterations: number,
  rounds: number,
): { ratio: number; perCallMs: number } {
  let ratio = Infinity
  let perCallMs = Infinity
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    const workMs = (performance.now() - t0) / iterations
    const calMs = calibrationRoundMs()
    if (calMs > 0) ratio = Math.min(ratio, workMs / calMs)
    perCallMs = Math.min(perCallMs, workMs)
  }
  return { ratio, perCallMs }
}
