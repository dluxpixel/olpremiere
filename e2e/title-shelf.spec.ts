// Ready made titles: one off the shelf lands on the timeline styled and moving.
//
// Borrowed on 2026-09-15 from the one thing Premiere users say they miss after
// switching, its shelf of drop in graphics. The looks themselves are pinned in
// src/state/titleShelf.test.ts; a browser shows the two roads onto the
// timeline: a double click adds at the playhead, a drag lands at the drop time.

import { expect, test, type Page } from '@playwright/test'

interface TitleRow {
  startS: number
  text: string
  channels: number
}

async function titles(page: Page): Promise<TitleRow[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { startS: number; title?: { text: string }; keyframes?: Record<string, unknown> }[] }[]
      }
    }
    return activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .filter((c) => c.title)
      .map((c) => ({ startS: c.startS, text: c.title!.text, channels: Object.keys(c.keyframes ?? {}).length }))
  })
}

test('a double click adds the title at the playhead, styled and animated', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Effects' }).click()
  const row = page.locator('[data-testid="title-item"][data-payload="lower-third"]')
  await expect(row).toBeVisible()
  await row.dblclick()
  const [t] = await titles(page)
  expect(t.text).toBe('Name')
  expect(t.startS).toBe(0)
  expect(t.channels).toBeGreaterThan(0)
  await expect(page.locator('[data-clip-kind="title"]')).toHaveCount(1)
})

test('a drag lands the title where it was dropped', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Effects' }).click()
  const row = page.locator('[data-testid="title-item"][data-payload="headline-pop"]')
  const lanes = page.getByTestId('timeline-lanes')
  const box = (await lanes.boundingBox())!
  // 120 px in at the default 60 px per second is two seconds, on the top lane.
  await row.dragTo(lanes, { targetPosition: { x: 120, y: 20 } })
  const [t] = await titles(page)
  expect(t.text).toBe('Your headline')
  expect(t.startS).toBeGreaterThan(1)
  expect(t.startS).toBeLessThan(3)
  expect(box.width).toBeGreaterThan(120)
})
