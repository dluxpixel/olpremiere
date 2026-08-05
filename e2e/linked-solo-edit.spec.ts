// Singling out one half of a linked pair means "just this clip".
//
// He reported this twice in one minute on 2026-08-05: "when I select a specific
// clip, it cuts only that clip. That was a very useful feature" and "you added
// that dragging drags both audio and video clips". Trimming had honoured the
// distinction for a while; cut and move never did.
//
// The rule under test, and the reason both halves of it are here: singling a
// clip out changes the verb, and NOT singling one out must leave the pair
// behaviour exactly as it was. He rejected a broader selection-scoped cut in
// July as "way too confusing", so the default has to stay untouched.

import { expect, test } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function clipCounts(page: import('@playwright/test').Page) {
  return {
    video: await page.locator('[data-clip-kind="video"]').count(),
    audio: await page.locator('[data-clip-kind="audio"]').count(),
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await page.getByTestId('asset-card').waitFor()
  // A video WITH audio inserts as a linked pair: video on V1, audio split to A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
})

test('selecting only the video half cuts only the video', async ({ page }) => {
  const vid = page.locator('[data-clip-kind="video"]').first()
  const box = await vid.boundingBox()
  if (!box) throw new Error('no video clip on the timeline')
  // Playhead into the middle of the clip, THEN select the video half, so the
  // selection is the last thing said before the cut.
  await page.mouse.click(box.x + box.width / 2, box.y - 12)
  await vid.click()
  await page.keyboard.press('KeyC')

  const after = await clipCounts(page)
  expect(after.video).toBe(2)
  expect(after.audio).toBe(1) // the partner was NOT cut
})

test('with nothing selected, C still cuts the pair together', async ({ page }) => {
  const vid = page.locator('[data-clip-kind="video"]').first()
  const box = await vid.boundingBox()
  if (!box) throw new Error('no video clip on the timeline')
  await page.mouse.click(box.x + box.width / 2, box.y - 12)
  // Clicking the ruler leaves nothing selected, which is the default case.
  await page.keyboard.press('KeyC')

  const after = await clipCounts(page)
  expect(after.video).toBe(2)
  expect(after.audio).toBe(2)
})

test('dragging a singled-out video half leaves its audio where it was', async ({ page }) => {
  const vid = page.locator('[data-clip-kind="video"]').first()
  const aud = page.locator('[data-clip-kind="audio"]').first()
  const before = await aud.boundingBox()
  const box = await vid.boundingBox()
  if (!box || !before) throw new Error('no linked pair on the timeline')

  await vid.click() // single it out
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()

  const movedVideo = await vid.boundingBox()
  const audioNow = await aud.boundingBox()
  if (!movedVideo || !audioNow) throw new Error('a clip vanished during the drag')
  expect(movedVideo.x).toBeGreaterThan(box.x + 40) // the video really moved
  expect(Math.abs(audioNow.x - before.x)).toBeLessThan(4) // the audio did not
})
