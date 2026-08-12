// His words, 2026-08-12: "when I'm making a right-click drag up on the preview
// down there, the clips also go up so I can see what I'm selecting when I have a
// lot of V1s and audio lines."
//
// Edge scrolling during a drag existed and was SIDEWAYS ONLY, so on a tall stack
// of tracks he was drawing a selection box around lanes he could not see.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

const lanes = (page: Page) => page.getByTestId('timeline-lanes')

/** Enough tracks that the lanes must scroll vertically to show them all. */
async function tallStack(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    updateActiveSequence('test: many tracks', (s) => {
      const sq = s as { tracks: { id: string; kind: string; name: string }[] }
      const extra = Array.from({ length: 10 }, (_, i) => ({
        ...sq.tracks.find((t) => t.kind === 'video')!,
        id: `extra-${i}`,
        name: `V${i + 5}`,
        clips: [],
      }))
      return { ...sq, tracks: [...sq.tracks, ...extra] }
    })
  })
}

test('a selection box dragged past the bottom scrolls the lanes to show what it is catching', async ({ page }) => {
  await tallStack(page)

  const el = lanes(page)
  await expect(el).toBeVisible()
  // The premise: there is somewhere to scroll TO. Without this the test could
  // pass by the lanes simply never moving.
  const scrollable = await el.evaluate((n) => n.scrollHeight - n.clientHeight)
  expect(scrollable, 'the lanes are taller than their viewport').toBeGreaterThan(20)

  // ⛔ THE SELECT TOOL, AND THIS IS NOT A DETAIL. The marquee gesture lives in
  // beginEmptyScrub, which runs only for tool === 'select'. Without this the box
  // never starts, the test fails for a reason nowhere near scrolling, and an hour
  // goes into the wrong place. It cost one already.
  await page.keyboard.press('v')
  const box = (await el.boundingBox())!
  const before = await el.evaluate((n) => n.scrollTop)

  // Start a marquee in empty space and drag it hard into the bottom edge, then
  // hold there: the scroll is a rAF loop, so the pointer has to STAY in the zone.
  await page.mouse.move(box.x + box.width * 0.6, box.y + 30)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height - 4, { steps: 10 })
  await expect.poll(async () => el.evaluate((n) => n.scrollTop), { timeout: 5_000 }).toBeGreaterThan(before + 10)
  await page.mouse.up()
  await page.keyboard.up('Shift')
})
