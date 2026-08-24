// His words, 2026-08-24: "This bar is also still broken. Make the play button
// centered. Lift the video to the center in 16:9 and in 9:16."
//
// The bar was already right. Measured against his own screenshot, the Play
// button sits on 540 of 1080, to the pixel. What was wrong is the PICTURE: the
// master meter is a column in the same row as the video, so 58px of meter plus
// the row's 8px gap came off the RIGHT of the picture's box and nothing off the
// left, and the picture was centred 33px LEFT of the panel. Two things that both
// looked centred on their own were 33px apart, which is what he was looking at.
//
// ⛔ THE ASSERTION IS THAT THE TWO CENTRES AGREE, not that either one is at any
// particular coordinate. A test that pinned the canvas to a number would have to
// be rewritten every time the meter, the panel split or the window size moved,
// and it would still pass on the day the bar and the picture drift apart
// together, which is the only failure that matters here.
//
// Both formats, because he named both, and because they fail differently: in
// 16:9 the picture is usually width-limited so a 33px shift is a small nudge, and
// in 9:16 it is a narrow strip where the same 33px is glaring.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** Centre x of an element, or null when it is not laid out. */
async function centreX(page: Page, testId: string): Promise<number | null> {
  const box = await page.getByTestId(testId).boundingBox()
  return box ? box.x + box.width / 2 : null
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

test('the picture and the play button sit on the same centre, in 16:9 and in 9:16', async ({
  page,
}) => {
  await boot(page)

  for (const format of ['16:9', '9:16'] as const) {
    await page.getByTestId('format-select').selectOption(format)
    // The canvas is sized imperatively in the draw loop, so give the rAF that
    // follows the format switch a frame to land before measuring.
    await expect
      .poll(async () => {
        const picture = await centreX(page, 'program-canvas')
        const play = await centreX(page, 'play-toggle')
        if (picture === null || play === null) return null
        return Math.abs(picture - play)
      })
      // One pixel of slack: fitCanvasBox floors the canvas to whole DEVICE
      // pixels, so on a fractional dpr the CSS box can land half a pixel off
      // centre. 33 could never hide inside that.
      .toBeLessThanOrEqual(1)
  }
})

test('the mirror is exactly as wide as the meter it stands in for', async ({ page }) => {
  await boot(page)
  // If these two ever disagree the picture goes off centre by half the
  // difference, silently, and the test above is the only thing that would say
  // so. This one names the cause instead of the symptom.
  const meter = await page.getByTestId('master-meter').boundingBox()
  const mirror = await page.getByTestId('meter-mirror').boundingBox()
  expect(meter).not.toBeNull()
  expect(mirror).not.toBeNull()
  expect(mirror!.width).toBeCloseTo(meter!.width, 1)
})

test('the meter still has its own column and never sits over the picture', async ({ page }) => {
  await boot(page)
  // The tempting way to win the 58px back is to float the meter over the video.
  // Monitor.tsx says it never does that, and out of flow is the mistake that was
  // photographed on the transport bar itself on 2026-08-19.
  const picture = (await page.getByTestId('program-canvas').boundingBox())!
  const meter = (await page.getByTestId('master-meter').boundingBox())!
  expect(meter.x).toBeGreaterThanOrEqual(picture.x + picture.width - 1)
})
