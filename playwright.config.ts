import { readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// THE GATE MUST OWN WHAT IT TESTS, AND IT MUST LEAVE EVIDENCE (2026-08-04)
//
// Two full runs each passed 190 and failed 2, a DIFFERENT 2 each time, all four drag or pointer
// tests, all four green in isolation. A third run then passed 192/192 and OVERWROTE test-results/,
// so the identity of those four failures is gone for good. Nothing was recorded, because trace,
// video and screenshot were all off. That is the real bug: a gate that cannot say why it failed is
// a gate that can only be re-rolled, not fixed.
//
// Three things were wrong, and are fixed below.
//
// 1. IT DID NOT OWN ITS SERVER. `reuseExistingServer: true` on port 5177 meant the suite silently
//    ADOPTED whatever was already listening, and 5177 is the dev server he actually works in. So
//    the gate could be judging a hot-patched server instead of the repo on disk. Worse, saving a
//    file mid-run broadcasts an HMR update or a full reload over the websocket to the test's own
//    page, which destroys the geometry a drag test has already measured. He works from localhost,
//    so he is maximally exposed to this. The gate now runs on its OWN port and refuses to adopt
//    anything, so his 5177 session and a gate run can coexist without touching each other.
//
// 2. THERE WAS NO EVIDENCE. trace, video and screenshot all defaulted off. Retained on failure
//    now. Costs nothing on a green run, and is the only reason the next failure will be explicable.
//
// 3. THE ASSERTION TIMEOUT WAS AN ACCIDENT NOBODY CHOSE. There was no `expect` block at all, so
//    every assertion ran on Playwright's 5,000 ms default while the notes recorded it as 30,000.
//    The 30,000 below is, and always was, the webServer START timeout. It is written out
//    explicitly now so the number is a decision rather than a default, and so nobody reads the
//    wrong one again. It is deliberately NOT raised: a wider budget would hide a real regression
//    in drag commit latency.
//
// DELIBERATELY NOT ADDED: `retries`. This suite is the first step of `npm run patch` and there is
// no CI behind it. Retrying an unexplained flake turns his only safety net into a reporter, which
// is the exact failure shape that has already cost him four separate mechanisms. Retries become
// defensible only once a trace names the mechanism and the mechanism is fixed.
//
// 2026-10-12, ONE NARROW EXCEPTION, THE RELEASE SET. His word: "make a system for when we do
// release new updates. It doesn't take half as long. It doesn't even take a third of that long",
// and "Let's work around the rules so that we test less also". The `release` project (below)
// retries a failed test ONCE, alone. A test that passes on its second try is reported as flaky
// in the ship log (Playwright's own summary names it), so it can still be found and fixed. The
// full suite (`npm run verify`) still never retries: the rule above stands for it, word for word.

// THE SUITE IS SPLIT INTO PROJECTS, AND WHAT EACH ONE IS FOR (2026-10-06)
//
// smoke   boot.spec.ts, first and on its own. Every other project depends on it, so a
//         change that stops the editor mounting is red in under a minute instead of
//         409 tests each waiting 60 s (about 6.8 hours) on an input that never appears.
// ui      everything that drives the interface and does not time itself against the
//         wall clock.
// timing  the specs whose verdict is a wall clock number or real time playback. Each
//         imports `test` from quietBox.ts, which waits for the machine to settle
//         before measuring and names a busy box in any failure. No budget moved.
// measure NOT part of the gate, and only defined when OLP_MEASURE is set. scrub-cost
//         times scrubbing on his own 1.38 GB project; it depends on a file outside the
//         repo and took 3 to 10 minutes. The gate's half is scrub-repaint, on the
//         repo's own fixture. Run this one by hand on a quiet box:
//           PowerShell:  $env:OLP_MEASURE='1'; npx playwright test --project=measure
// release ONLY when OLP_RELEASE is set, and then it is the only project (2026-10-12). `npm run
//         patch` sets it for its one browser step: boot (the editor mounts), mvp (the core edit
//         flow), export, and export-shapes (every frame shape exports done and keeps pace with
//         9:16, about 30 s; added 2026-10-16 after a Phone export crawled at a sixth of the
//         speed), about 2 min of tests against about 26 min for the whole suite. It
//         retries a failed test once (see the note under "DELIBERATELY NOT ADDED"). Without
//         OLP_RELEASE the projects above are exactly what they were, so `npm run verify` and a
//         plain `npx playwright test` run the whole suite and nothing runs twice. The speed
//         tests (timing) no longer block anything: in the full gate they only warn.
//
// ⛔ ONE WORKER FOR EVERYTHING, STILL. The ui half is the candidate for 3 workers (his
// "4 at once max" rule), but pointer specs do real geometry and that has to be MEASURED
// (three green full runs on a quiet box) before it is trusted, and it has not been.
// When it is: give `ui` its own `workers`, and give `timing` `dependencies: ['ui']` so
// a timing spec never shares the machine with ui workers.

/** Wall clock or real time playback specs. Each must use quietBox.ts (checked below). */
const TIMING = [
  'play-latency.spec.ts',
  'play-cost.spec.ts',
  'edit-cost-at-scale.spec.ts',
  'usage-log.spec.ts',
  'transition-stale-frame.spec.ts',
  'workarea.spec.ts',
  'scrub-repaint.spec.ts',
]
const SMOKE = ['boot.spec.ts']
const MEASURE = ['scrub-cost.spec.ts']
/** What a release is gated on: the editor mounts, the core edit flow, export, and every frame shape. About 2 min. */
const RELEASE = ['boot.spec.ts', 'mvp.spec.ts', 'export.spec.ts', 'export-shapes.spec.ts']
const glob = (names: string[]): string[] => names.map((n) => `**/e2e/${n}`)

// A timing spec that forgot quietBox would measure on a busy box and blame the app.
// Refuse to start rather than run it unprotected.
for (const name of TIMING) {
  const src = readFileSync(new URL(`./e2e/${name}`, import.meta.url), 'utf8')
  if (!/from '\.\/quietBox'/.test(src)) {
    throw new Error(`e2e/${name} is a timing spec and must import { test } from './quietBox'`)
  }
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Media decode/encode tests are CPU-bound; parallel workers starve each
  // other's probe/encode deadlines and flake. See the note on projects above.
  workers: 1,
  // A stray `test.only` would run that one test and exit 0: a green gate on one test.
  forbidOnly: true,
  // Enough failures to see a pattern, without running a broken build for hours.
  maxFailures: 15,
  globalSetup: './e2e/global-setup.ts',
  expect: {
    // Playwright's own default, stated on purpose. See note 3 above.
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://localhost:5178',
    headless: true,
    viewport: { width: 1600, height: 900 },
    // EVERY SPEC OWNS ITS CLIPBOARD (2026-10-06). The headless clipboard outlives the
    // page, and a spec without write permission copied clips that never reached it,
    // then pasted whatever an earlier spec had left there (phase3 met paste-picture's
    // picture in the 2026-09-28 gate). Granted here, every spec's own copy writes,
    // on every port. The refused write path is unit tested (state/clipboard.test.ts).
    permissions: ['clipboard-read', 'clipboard-write'],
    // Keep the evidence for whatever fails, and nothing for whatever passes.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // A fake mic + auto-granted permission so the voiceover recorder path is
        // testable headless; harmless to specs that never touch the mic.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  projects: process.env.OLP_RELEASE
    ? [{ name: 'release', testMatch: glob(RELEASE), retries: 1 }]
    : [
        { name: 'smoke', testMatch: glob(SMOKE) },
        { name: 'ui', testIgnore: glob([...SMOKE, ...TIMING, ...MEASURE]), dependencies: ['smoke'] },
        { name: 'timing', testMatch: glob(TIMING), dependencies: ['smoke'] },
        ...(process.env.OLP_MEASURE ? [{ name: 'measure', testMatch: glob(MEASURE), timeout: 300_000 }] : []),
      ],
  webServer: {
    // 5178, NOT 5177. 5177 is his working dev server, and the ad-hoc probes in _verify/ point at
    // it on purpose. The gate gets its own port so it can never adopt his session, reload it, or
    // be reloaded by it.
    command: 'npm run dev -- --port 5178 --strictPort',
    port: 5178,
    // Never adopt a stranger. With --strictPort, anything already sitting on 5178 makes the run
    // fail loudly instead of quietly testing something else.
    reuseExistingServer: false,
    timeout: 30_000,
    // Vite's own words go into the run's output, so "optimized dependencies changed,
    // reloading" (a full page reload in the middle of a test) is in the ship log
    // instead of nowhere.
    stdout: 'pipe',
    // Its own dependency cache, so the gate never shares node_modules/.vite with his
    // 5177 dev server (vite.config.ts reads this).
    env: { OLP_VITE_CACHE: 'node_modules/.vite-gate' },
  },
})
