// MEASUREMENT, not a guard, and NOT part of the gate. His words, 2026-08-12: "When I
// am scrolling with the red bar, the preview is still extremely laggy."
//
// ⛔ Nothing measured this before. `recordPreviewTick` is called only when
// `playing` is true (Monitor.tsx), so every pacing and health number the app
// keeps describes PLAYBACK and says nothing at all about scrubbing.
//
// This times the thing he actually feels: move the playhead, then wait for the
// picture to change. Run it against his own project, which is what makes the
// number mean anything. It lives in the `measure` project (playwright.config.ts),
// which exists only when OLP_MEASURE is set:
//
//   PowerShell:  $env:OLP_MEASURE='1'; npx playwright test --project=measure
//
// The gate's half, on the repo's own fixture, is scrub-repaint.spec.ts.
//
// ⛔ THE FIRST INSTRUMENT MEASURED ITSELF (rebuilt 2026-10-06). It fingerprinted
// the monitor with an element SCREENSHOT per poll. Every ship since September
// printed lines like "0 never repainted within 4s. median 8209ms": a hop that
// repainted inside 4 s cannot take 8 s, so the number was screenshot latency, not
// scrub latency. Its number moved from 954 ms (Aug 20) to 5,333 ms (Sep 23) and
// nobody could say whether the app or the instrument had changed. Its only
// assertion was `waits.length + missed === 12`, which the loop made true by
// construction, it depended on a 1.38 GB file outside the repo, and on 2026-10-06
// it failed the gate on a canvas detached mid-screenshot.
//
// Now the whole hop is timed INSIDE the page: set the playhead, then read a 4x4
// grid of the program canvas every animation frame (preserveDrawingBuffer is on,
// the way transition-stale-frame reads it) until the picture differs. No round
// trip per poll, so the number is the app's. And it can fail: a hop that never
// repaints is a red, and so is an instrument that cannot see a picture at all.

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import { HOP_LIMIT_MS, gridShowsAPicture, hop, readGrid } from './scrubHop'

const HIS_PROJECT = 'C:/Users/skyle/Desktop/MY EDIT - 44 clips - 22 July.olstudio'
const HOPS = 12

test('how long the picture takes to catch up while scrubbing his project', async ({ page }) => {
  test.skip(!fs.existsSync(HIS_PROJECT), 'his project file is not on this machine')
  test.setTimeout(300_000)

  await page.goto('/')
  await page.getByTestId('open-project-input').setInputFiles(HIS_PROJECT)
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const storeMod = '/src/state/store.ts'
          const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
            useStore: { getState: () => { project: { sequences: Record<string, unknown> } } }
          }
          return Object.keys(useStore.getState().project.sequences).length
        }),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0)

  // Settle on a first frame so the first hop is measured like the rest.
  await hop(page, 2)
  await page.waitForTimeout(2500)

  // THE INSTRUMENT CHECKS ITSELF FIRST. A read that comes back empty or black is a
  // broken measurement (the WebGL 2d-context mistake reported 12 frames that never
  // arrived), not a slow app.
  expect(gridShowsAPicture(await readGrid(page)), 'the program canvas reads as no picture at all').toBe(true)

  const waits: number[] = []
  let missed = 0
  for (let i = 0; i < HOPS; i++) {
    const ms = await hop(page, 4 + i * 1.7)
    if (ms >= 0) waits.push(Math.round(ms))
    else missed++
  }

  const sorted = [...waits].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -1
  console.log(
    `[scrub] ${waits.length} hops measured, ${missed} never repainted within ${HOP_LIMIT_MS / 1000}s. ` +
      `median ${median}ms, fastest ${sorted[0] ?? -1}ms, slowest ${sorted[sorted.length - 1] ?? -1}ms. ` +
      `in order: ${JSON.stringify(waits)}`,
  )
  // Every hop lands on a different part of the edit, so every hop must repaint.
  expect(missed, `hops that never repainted within ${HOP_LIMIT_MS / 1000} s`).toBe(0)
})
