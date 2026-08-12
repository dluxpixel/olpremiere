// The number on "Caption every clip" has to be what it will actually caption.
//
// Dropping a video with sound makes a LINKED PAIR: a video clip on V1 and an
// audio clip on A1, sharing one assetId and both reporting hasAudio. That is how
// nearly every clip in a real edit arrives.
//
// The button's count kept its own copy of the rule and filtered on the ASSET, so
// it counted both halves of one take. The door that does the work filters on
// clipEmitsAudio and hears the take once. **The button offered roughly double
// the work it would do**, and got further from the truth the more clips he had.
// That is finding 9's shape exactly, one room over: finding 9 was the same copy
// of the same rule doubling the captions themselves.
//
// This reads the sentence on screen rather than calling the function, because
// the number he SEES is the thing that was wrong.

import { expect, test } from '@playwright/test'

test('the count on "Caption every clip" matches what it will caption, on a linked pair', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // A video WITH audio drops as a linked pair: video on V1, audio on A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)

  await page.getByTestId('open-captions').click()
  const dialog = page.getByTestId('captions-dialog')
  await expect(dialog).toBeVisible()

  // ONE take on the timeline, so the sentence has to say one. It used to say 2.
  await expect(dialog).toContainText('all 1 with sound')
  await expect(dialog.getByTestId('captions-auto-all')).toBeEnabled()
})
