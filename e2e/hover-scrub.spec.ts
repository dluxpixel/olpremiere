// Slide the pointer across a media thumbnail and see the frame under it.
//
// Borrowed on 2026-09-15 from what switchers say they miss when a media panel
// cannot do this. The geometry is pinned in src/components/hoverScrub.test.ts;
// a browser is needed for the rest: the <video> mounts only under the pointer,
// it really seeks to the time under the pointer, the badge reads that time, and
// everything is gone again when the pointer leaves.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

test('the thumbnail scrubs under the pointer and puts its poster back when the pointer leaves', async ({ page }) => {
  await boot(page)
  const thumb = page.getByTestId('asset-thumb')
  await expect(page.getByTestId('asset-scrub')).toHaveCount(0)

  const box = (await thumb.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.25, y)
  const video = page.getByTestId('asset-scrub')
  await expect(video).toBeVisible()
  const quarter = Number(await video.getAttribute('data-scrub-t'))
  expect(quarter).toBeGreaterThan(0)

  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 })
  const threeQuarters = Number(await video.getAttribute('data-scrub-t'))
  expect(threeQuarters).toBeGreaterThan(quarter)

  // The decoder really went there, not just the label: the element's own clock
  // lands within a frame of the target once the seek settles.
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(threeQuarters - 0.05)

  // The badge reads the time under the pointer while scrubbing, and the clip's
  // length again once the pointer has left.
  const badge = thumb.locator('span').last()
  const whileScrubbing = await badge.innerText()

  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60)
  await expect(page.getByTestId('asset-scrub')).toHaveCount(0)
  const afterwards = await badge.innerText()
  expect(afterwards).not.toBe(whileScrubbing)
})
