import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/mvp'

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
  await expect(page.getByTestId('clip')).toBeVisible()
}

test('import: probing yields a card with name and a sane duration badge', async ({ page }) => {
  await importClip(page)
  const card = page.getByTestId('asset-card')
  await expect(card).toContainText('clip.webm')
  // MediaRecorder timing jitters; accept 1..4s but not 0 and not garbage.
  await expect(card).toContainText(/00:00:0[1-4]:/)
  await page.screenshot({ path: `${VERIFY}/imported.png` })
})

test('double-click inserts onto V1 and the sequence duration updates', async ({ page }) => {
  await addClipToTimeline(page)
  await expect(page.getByTestId('timecode')).toContainText(/\/ 00:00:0[1-4]:/)
  await page.screenshot({ path: `${VERIFY}/clip-on-timeline.png` })
})

test('move: dragging a clip shifts its timeline position', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = page.getByTestId('clip')
  const before = (await clip.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 150, before.y + before.height / 2, {
    steps: 10,
  })
  await page.mouse.up()
  const after = (await clip.boundingBox())!
  expect(after.x - before.x).toBeGreaterThan(120)
  // Undo returns it home.
  await page.keyboard.press('Control+z')
  const undone = (await clip.boundingBox())!
  expect(Math.abs(undone.x - before.x)).toBeLessThan(3)
})

test('split: Ctrl+K at the playhead makes two clips; razor makes three', async ({ page }) => {
  await addClipToTimeline(page)
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } }) // t = 1s @60px/s
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('clip')).toHaveCount(2)

  await page.keyboard.press('c') // razor
  await page.getByTestId('clip').first().click({ position: { x: 20, y: 20 } })
  await expect(page.getByTestId('clip')).toHaveCount(3)
  await page.keyboard.press('v')
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/split.png` })
})

test('trim: dragging the out handle shortens the clip', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = page.getByTestId('clip')
  const before = (await clip.boundingBox())!
  await page.mouse.move(before.x + before.width - 3, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width - 45, before.y + before.height / 2, { steps: 8 })
  await page.mouse.up()
  const after = (await clip.boundingBox())!
  expect(before.width - after.width).toBeGreaterThan(25)
})

test('delete lifts the clip; undo restores it', async ({ page }) => {
  await addClipToTimeline(page)
  await page.getByTestId('clip').click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('clip')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('clip')).toHaveCount(1)
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
