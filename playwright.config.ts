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

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Media decode/encode tests are CPU-bound; parallel workers starve each
  // other's probe/encode deadlines and flake.
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  expect: {
    // Playwright's own default, stated on purpose. See note 3 above.
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://localhost:5178',
    headless: true,
    viewport: { width: 1600, height: 900 },
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
  },
})
