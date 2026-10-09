// "When I am scrolling with the red bar, the preview is still extremely laggy."
// (his words, 2026-08-12)
//
// The gate's half of the scrub measurement (2026-10-06). scrub-cost.spec.ts times
// scrubbing on his own project, which lives outside the repo, so it is run by hand
// and is not part of the gate. Before that split it WAS in the gate and could not
// fail: its only assertion was true by construction, and its number was the time
// of the screenshots it took to look at the picture. This one runs on the repo's
// own fixture (red for its first second, blue after) with the instrument in
// scrubHop.ts, and every hop has to show THE FRAME ASKED FOR, not merely a change:
// a scrub that never repaints, hangs on a seek, or paints the wrong half is red.
//
// The bound is the instrument's own "never repainted" line (4 s), not a speed
// budget: measured 2026-10-06, a hop here took 2 to 11 ms, 175 ms for the first,
// and the numbers are printed every run so drift is visible. A speed budget
// would be a guess.

// Timing spec: runs in the `timing` project, on a quiet box (see quietBox.ts).
import { expect, test } from './quietBox'
import { HOP_LIMIT_MS, gridShowsAPicture, hop, readGrid } from './scrubHop'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** Alternating halves, never the same instant twice: every hop must repaint. */
const HOPS: [number, 'red' | 'blue'][] = [
  [1.5, 'blue'], [0.3, 'red'], [1.2, 'blue'], [0.7, 'red'], [1.8, 'blue'], [0.1, 'red'],
  [1.4, 'blue'], [0.5, 'red'], [1.9, 'blue'], [0.2, 'red'], [1.1, 'blue'], [0.8, 'red'],
]

test('scrubbing repaints the monitor with the frame asked for, at every hop', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().waitFor({ timeout: 15_000 })

  // Settle on a first frame, so the first hop is a scrub and not the cold open of
  // the file, which is play-latency's question and not this one.
  expect(await hop(page, 0.6, 'red', 15_000), 'the fixture never reached the monitor at all').toBeGreaterThanOrEqual(0)

  // THE INSTRUMENT CHECKS ITSELF. A canvas it cannot read, or reads as black, would
  // make every hop below look like an app that never repaints.
  expect(gridShowsAPicture(await readGrid(page)), 'the program canvas reads as no picture at all').toBe(true)

  const waits: number[] = []
  const missed: string[] = []
  for (const [at, want] of HOPS) {
    const ms = await hop(page, at, want)
    if (ms >= 0) waits.push(Math.round(ms))
    else missed.push(`${at}s (${want})`)
  }
  const sorted = [...waits].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -1
  console.log(
    `[scrub repaint] ${waits.length} of ${HOPS.length} hops showed the frame asked for. ` +
      `median ${median}ms, slowest ${sorted[sorted.length - 1] ?? -1}ms. in order: ${JSON.stringify(waits)}`,
  )
  expect(missed, `hops that did not show the frame asked for within ${HOP_LIMIT_MS / 1000} s`).toEqual([])
})
