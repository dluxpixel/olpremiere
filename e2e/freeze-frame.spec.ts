// Freeze frame, end to end: F holds the frame under the playhead, F again lets
// it run, and the timeline says which clips are holding.
//
// The arithmetic and the cut-a-freeze case are unit tested in
// src/state/freezeFrame.test.ts. This covers the wiring: the key, the badge, and
// that the RENDERER really stops advancing.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** The source second the resolver samples at sequence time `t`. */
async function sourceAt(page: Page, t: number): Promise<number> {
  return page.evaluate(async (tt) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const resolveMod = '/src/engine/render/resolve.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => unknown
    }
    const { resolveFrame } = (await import(/* @vite-ignore */ resolveMod)) as {
      resolveFrame: (s: unknown, t: number) => { ops: { type: string; layer?: { sourceTimeS: number } }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const op = resolveFrame(seq, tt).ops.find((o) => o.type === 'layer')
    return op?.layer?.sourceTimeS ?? NaN
  }, t)
}

async function clipOnTimeline(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click()
}

test('F holds the frame, and F again gives the footage back', async ({ page }) => {
  await clipOnTimeline(page)
  // Running: the source advances with the timeline.
  const runningEarly = await sourceAt(page, 0.2)
  const runningLate = await sourceAt(page, 1.2)
  expect(runningLate).toBeGreaterThan(runningEarly)

  await page.keyboard.press('f')
  await expect(page.getByTestId('clip-frozen-badge')).toBeVisible()

  // Held: the same source second whatever the timeline is doing.
  const heldEarly = await sourceAt(page, 0.2)
  const heldLate = await sourceAt(page, 1.2)
  expect(heldLate).toBeCloseTo(heldEarly, 6)

  await page.keyboard.press('f')
  await expect(page.getByTestId('clip-frozen-badge')).toHaveCount(0)
  expect(await sourceAt(page, 1.2)).toBeGreaterThan(await sourceAt(page, 0.2))
})

test('undo lets it run again', async ({ page }) => {
  await clipOnTimeline(page)
  await page.keyboard.press('f')
  await expect(page.getByTestId('clip-frozen-badge')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('clip-frozen-badge')).toHaveCount(0)
})
