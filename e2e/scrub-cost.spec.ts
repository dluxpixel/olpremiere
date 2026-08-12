// MEASUREMENT, not a guard. His words, 2026-08-12: "When I am scrolling with the
// red bar, the preview is still extremely laggy."
//
// ⛔ Nothing measured this before. `recordPreviewTick` is called only when
// `playing` is true (Monitor.tsx), so every pacing and health number the app
// keeps describes PLAYBACK and says nothing at all about scrubbing.
//
// This times the thing he actually feels: move the playhead, then wait for the
// picture to change. Run it against his own project, which is what makes the
// number mean anything.
//
//   npx playwright test e2e/scrub-cost.spec.ts --reporter=line

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const HIS_PROJECT = 'C:/Users/skyle/Desktop/MY EDIT - 44 clips - 22 July.olstudio'

/**
 * A fingerprint of what the monitor is SHOWING. Taken as a screenshot on purpose:
 * the preview renders through WebGL, so asking the canvas for a 2d context hands
 * back null and every frame looks identical. That mistake made the first run of
 * this report 12 frames that never arrived, which was the measurement broken and
 * not the app.
 */
async function frameSig(page: Page): Promise<string> {
  const buf = await page.locator('canvas').first().screenshot()
  let h = 0
  for (let i = 0; i < buf.length; i += 101) h = (h * 31 + buf[i]) >>> 0
  return String(h)
}

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

  const setPlayhead = (t: number) =>
    page.evaluate(async (at) => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { setUI: (u: { playheadS: number }) => void } }
      }
      useStore.getState().setUI({ playheadS: at })
    }, t)

  // Settle on a first frame so the first hop is measured like the rest.
  await setPlayhead(2)
  await page.waitForTimeout(2500)

  const waits: number[] = []
  let missed = 0
  for (let i = 0; i < 12; i++) {
    const before = await frameSig(page)
    const t0 = Date.now()
    await setPlayhead(4 + i * 1.7)
    let changed = false
    while (Date.now() - t0 < 4000) {
      if ((await frameSig(page)) !== before) {
        changed = true
        break
      }
    }
    if (changed) waits.push(Date.now() - t0)
    else missed++
  }

  waits.sort((a, b) => a - b)
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : -1
  console.log(
    `[scrub] ${waits.length} hops measured, ${missed} never repainted within 4s. ` +
      `median ${median}ms, fastest ${waits[0] ?? -1}ms, slowest ${waits[waits.length - 1] ?? -1}ms. ` +
      `all: ${JSON.stringify(waits)}`,
  )
  expect(waits.length + missed).toBe(12)
})
