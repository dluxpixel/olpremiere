// TIMING SPECS RUN ON A QUIET BOX, OR SAY WHY THEY COULD NOT (2026-10-06)
//
// The gate on 2026-10-06 went red on play-latency: 1520 ms against a 1500 ms budget,
// with the CPU at 76% because eleven helpers were running. The same spec measured
// 232 and 281 ms on a quiet box and 2164 ms while eleven helpers ran. On 2026-10-04
// nine specs went red under load and were all green alone. A timing spec cannot
// tell "the app got slow" from "the machine is busy", so every one of those reds
// read as an app regression.
//
// Every spec in the `timing` project (playwright.config.ts) imports `test` from
// here instead of from @playwright/test. Before each test this waits, bounded, until
// the whole machine is below BUSY_LIMIT, then lets the test measure exactly as it
// did before. While the test runs it keeps sampling, and if the test FAILS on a busy
// box the failure says so, in the report and in the ship log.
//
// ⛔ IT NEVER CHANGES A VERDICT. Not one budget moved, nothing is skipped, nothing is
// retried. A test that passes on a busy box passed honestly (the budget held even
// under load); a test that fails on one is still red, and now names the likely
// cause instead of blaming Space. Waiting is the only thing it adds.
//
// os.cpus() counts every process on the machine, so it needs no quiet-box baseline
// that would drift with the hardware. Between tests the gate's own browser and dev
// server sit idle, so what it sees is everybody else.

import { test as base, expect } from '@playwright/test'
import os from 'node:os'

/** Above this share of all CPU time busy, a wall clock number says more about the box than the app. */
export const BUSY_LIMIT = 0.5
/** The longest one test waits for the box to settle before it measures anyway. */
const MAX_WAIT_MS = 120_000
/** All the waiting one worker will do in a run, so a box that never settles cannot hang the gate. */
const MAX_TOTAL_WAIT_MS = 600_000
const WINDOW_MS = 1000

type Times = os.CpuInfo['times']
const snapshot = (): Times[] => os.cpus().map((c) => c.times)

/** The share of all CPU time, on every core, that was busy between two snapshots. */
function busyBetween(a: Times[], b: Times[]): number {
  let idle = 0
  let total = 0
  b.forEach((t, i) => {
    const s = a[i]
    if (!s) return
    idle += t.idle - s.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq - (s.user + s.nice + s.sys + s.idle + s.irq)
  })
  return total > 0 ? 1 - idle / total : 0
}

/** How busy the whole machine is over the next `ms`. */
export async function busyShare(ms = WINDOW_MS): Promise<number> {
  const a = snapshot()
  await new Promise((r) => setTimeout(r, ms))
  return busyBetween(a, snapshot())
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

let waitedThisWorker = 0

export const test = base.extend<{ quietBox: void }>({
  quietBox: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      // Quiet once is enough to start; after a busy reading it must be quiet twice
      // in a row, so one lull between two bursts does not count.
      const budget = Math.min(MAX_WAIT_MS, MAX_TOTAL_WAIT_MS - waitedThisWorker)
      const t0 = Date.now()
      let before = await busyShare()
      let need = before < BUSY_LIMIT ? 0 : 2
      while (need > 0 && Date.now() - t0 < budget) {
        before = await busyShare()
        need = before < BUSY_LIMIT ? need - 1 : 2
      }
      const waited = Date.now() - t0
      waitedThisWorker += waited
      const quiet = need === 0
      testInfo.annotations.push({
        type: 'box',
        description: quiet
          ? `${pct(before)} busy when it started${waited > WINDOW_MS * 1.5 ? `, after waiting ${Math.round(waited / 1000)} s for the box to settle` : ''}`
          : `still ${pct(before)} busy after waiting ${Math.round(waited / 1000)} s, measured anyway`,
      })
      if (!quiet) console.log(`[quiet box] ${testInfo.title}: the machine stayed ${pct(before)} busy for ${Math.round(waited / 1000)} s, measuring anyway`)

      // Keep sampling while the test runs, so a failure can say what the box did.
      const during: number[] = []
      let last = snapshot()
      const timer = setInterval(() => {
        const now = snapshot()
        during.push(busyBetween(last, now))
        last = now
      }, WINDOW_MS)

      await use()

      clearInterval(timer)
      during.push(busyBetween(last, snapshot()))
      const mean = during.reduce((s, x) => s + x, 0) / during.length
      const peak = Math.max(...during)
      if (testInfo.status !== testInfo.expectedStatus && (!quiet || mean >= BUSY_LIMIT)) {
        const say =
          `MACHINE BUSY: the box was ${pct(before)} busy when this timing test started and ` +
          `${pct(mean)} on average (peak ${pct(peak)}) while it ran. Re-run it on a quiet box ` +
          `before reading this failure as a regression in the app.`
        testInfo.annotations.push({ type: 'machine busy', description: say })
        console.log(`[quiet box] ${testInfo.title}: ${say}`)
      }
    },
    // ⛔ ITS OWN TIMEOUT, so the wait is never the test's time. Without one a
    // fixture shares the test's 60 s, and a 120 s wait for the box to settle would
    // time the test out before it measured anything. With one, Playwright charges
    // this setup to the fixture alone and the test keeps its full timeout.
    { auto: true, timeout: MAX_WAIT_MS + 30_000 },
  ],
})

export { expect }
