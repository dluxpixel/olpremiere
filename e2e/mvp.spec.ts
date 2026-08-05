import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/mvp'

// The fixture is a video WITH audio, so adding it creates a linked pair: a
// video clip on V1 + a split audio clip on A1. Tests target the video clip.
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')
const aclip = (page: Page) => page.locator('[data-clip-kind="audio"]')

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function importClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

async function addClipToTimeline(page: Page): Promise<void> {
  await importClip(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
}

test('import: probing yields a card with name and a sane duration badge', async ({ page }) => {
  await importClip(page)
  const card = page.getByTestId('asset-card')
  await expect(card).toContainText('clip.webm')
  // MediaRecorder timing jitters; accept 1..4s but not 0 and not garbage.
  await expect(card).toContainText(/00:00:0[1-4]:/)
  await page.screenshot({ path: `${VERIFY}/imported.png` })
})

test('double-click inserts video on V1 and splits its audio to A1', async ({ page }) => {
  await addClipToTimeline(page)
  await expect(vclip(page)).toHaveCount(1)
  await expect(aclip(page)).toHaveCount(1) // linked audio auto-created
  await expect(page.getByTestId('timecode')).toContainText(/\/ 00:00:0[1-4]:/)
  await page.screenshot({ path: `${VERIFY}/clip-on-timeline.png` })
})

test('move: dragging a clip shifts its timeline position (linked audio follows)', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = vclip(page)
  const audio = aclip(page)
  // Hover first: that buys the stability and hit-target checks raw page.mouse.* skips, and it
  // can scroll the clip into view, so both boxes are read AFTER it.
  await clip.hover()
  const before = (await clip.boundingBox())!
  const audioBefore = (await audio.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 150, before.y + before.height / 2, { steps: 10 })
  await page.mouse.up()

  // A budget for the commit instead of one read. A drag that never armed still fails here.
  await expect
    .poll(async () => (await clip.boundingBox())!.x - before.x)
    .toBeGreaterThan(120)

  const after = (await clip.boundingBox())!
  const audioAfter = (await audio.boundingBox())!
  // The linked audio clip moved by the same amount.
  expect(Math.abs((audioAfter.x - audioBefore.x) - (after.x - before.x))).toBeLessThan(4)
  await page.keyboard.press('Control+z')
  const undone = (await clip.boundingBox())!
  expect(Math.abs(undone.x - before.x)).toBeLessThan(3)
})

test('C cuts at the playhead; the razor (B) tool cuts on click', async ({ page }) => {
  await addClipToTimeline(page)
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } }) // t = 1s @60px/s
  // C is the one-key cut: it splits the clip under the playhead into two.
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(2)

  await page.keyboard.press('b') // razor / blade tool
  await vclip(page).first().click({ position: { x: 20, y: 20 } })
  await expect(vclip(page)).toHaveCount(3)
  await page.keyboard.press('v')
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/split.png` })
})

test('trim: dragging the out handle shortens the clip', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = vclip(page)
  // The -3 lands INSIDE the 6px out-trim handle, which is the thing under test, so the offset
  // stays and only the box it is computed from is made fresh.
  await clip.hover()
  const before = (await clip.boundingBox())!
  await page.mouse.move(before.x + before.width - 3, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width - 45, before.y + before.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect
    .poll(async () => before.width - (await clip.boundingBox())!.width)
    .toBeGreaterThan(25)
})

test('delete lifts the clip and its linked audio; undo restores both', async ({ page }) => {
  await addClipToTimeline(page)
  await vclip(page).click()
  await page.keyboard.press('Delete')
  await expect(vclip(page)).toHaveCount(0)
  await expect(aclip(page)).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(vclip(page)).toHaveCount(1)
  await expect(aclip(page)).toHaveCount(1)
})

test('playback: Space plays (timecode advances), Space pauses', async ({ page }) => {
  await addClipToTimeline(page)
  await page.keyboard.press('Home')
  await page.keyboard.press(' ')
  await page.waitForTimeout(800)
  const during = await page.getByTestId('timecode').textContent()
  expect(during).not.toContain('00:00:00:00 ')
  expect(during).toMatch(/^00:00:0[0-4]:/)
  await page.keyboard.press(' ')
  const paused = await page.getByTestId('timecode').textContent()
  await page.waitForTimeout(400)
  const still = await page.getByTestId('timecode').textContent()
  expect(still).toBe(paused)
  await page.screenshot({ path: `${VERIFY}/playback.png` })
})

test('clicking an empty track moves the playhead there (Vegas-style)', async ({ page }) => {
  await addClipToTimeline(page)
  // Click empty space on the V2 lane (ruler 28px + V2 lane starts at 28) at
  // x≈300 → t=5s @60px/s. The V2 lane is empty, so the click hits the lane.
  const lanes = page.getByTestId('timeline-lanes')
  const box = (await lanes.boundingBox())!
  await page.mouse.click(box.x + 300, box.y + 60)
  await expect(page.getByTestId('timecode')).toContainText('00:00:05:00')
})

test('clicking ON a clip moves the playhead there; dragging it does not', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = vclip(page)
  const box = (await clip.boundingBox())!

  // CLICK (no movement) in the middle of the clip → the playhead jumps there
  // and the preview shows that spot. Selection still happens.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const clicked = await page.getByTestId('timecode').textContent()
  expect(clicked).not.toContain('00:00:00:00 ')
  const playhead = (await page.getByTestId('playhead').boundingBox())!
  expect(Math.abs(playhead.x - (box.x + box.width / 2))).toBeLessThan(3)

  // DRAG the clip (real movement) → the playhead must NOT follow the pointer.
  await page.keyboard.press('Home')
  await expect(page.getByTestId('timecode')).toContainText('00:00:00:00')
  await clip.hover()
  const start = (await clip.boundingBox())!
  await page.mouse.move(start.x + 30, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 150, start.y + start.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByTestId('timecode')).toContainText('00:00:00:00')
})
