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
  await expect(card).toContainText(/0:0[1-4]\.\d\d/)
  await page.screenshot({ path: `${VERIFY}/imported.png` })
})

test('double-click inserts video on V1 and splits its audio to A1', async ({ page }) => {
  await addClipToTimeline(page)
  await expect(vclip(page)).toHaveCount(1)
  await expect(aclip(page)).toHaveCount(1) // linked audio auto-created
  await expect(page.getByTestId('timecode')).toContainText(/\/ 0:0[1-4]\.\d\d/)
  await page.screenshot({ path: `${VERIFY}/clip-on-timeline.png` })
})

// AMENDED 2026-08-05. His words: "when I drag the video clip, it automatically
// drags the audio clip. Can you make it so the audio and video clips can be
// dragged separately?" Grabbing a clip and moving it in one motion now moves
// THAT clip. Selecting both halves first is the deliberate way to move them
// together, and the test below covers that.
test('move: dragging a clip shifts it, and leaves its linked audio alone', async ({ page }) => {
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

  const audioAfter = (await audio.boundingBox())!
  // The linked audio stayed put: one grab, one clip.
  expect(Math.abs(audioAfter.x - audioBefore.x)).toBeLessThan(4)
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

// Delete takes ONLY the half you picked, since 2026-08-06. His words: "when I
// right-click a video clip and click Delete, it deletes the audio too. When did
// I ever say you could do that?" See e2e/linked-delete.spec.ts for the full set.
test('delete lifts only the video; the audio stays, and undo restores it', async ({ page }) => {
  await addClipToTimeline(page)
  await vclip(page).click()
  await page.keyboard.press('Delete')
  await expect(vclip(page)).toHaveCount(0)
  await expect(aclip(page)).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(vclip(page)).toHaveCount(1)
  await expect(aclip(page)).toHaveCount(1)
})

/** Seconds in the monitor readout "m:ss.cc / m:ss.cc": the playhead (part 0) or the edit length (part 1). */
const readoutS = (tc: string | null, part: 0 | 1 = 0): number =>
  (tc ?? '').split(' / ')[part]!.split(':').reduce((s, p) => s * 60 + Number(p), 0)

// ⛔ THE PAUSE HAS TO LAND WHILE IT IS STILL PLAYING, 2026-10-04. This played
// ONE 1.93 second clip, and a Space that lands after the edit has run out is not
// a pause: at the end, Space plays again from the top (togglePlay, Premiere's
// behaviour, pinned in playbackControl.test.ts). For the first two seconds of
// play the headless browser's main thread sits in 200 to 250 ms native tasks (the
// picture drawn in software), and every call from here waits behind one: the 800
// ms wait took 970, the read 500, the second press 325, so that press landed 2.1
// to 2.4 s after the first, past the end, and restarted the clip. The test read
// the restart as a pause that did not hold. The old test, 20 runs on a busy
// machine: 9 failed; in all 8 failures that logged, the edit had already ended
// when the press landed, and all 11 passes landed while it played. The commit
// before the microphone work, same machine minutes later: 17 of 20 the same way,
// so that work is not the cause. Space started the picture 2.5 to 4.5 ms after the
// key in every run, so the app was right. Four copies make an edit of nearly 8
// seconds, so the pause lands mid-play, and the paused frame must be at or past
// the one read while playing, so a press that restarted the edit says so instead
// of passing as a pause that drifted.
test('playback: Space plays (timecode advances), Space pauses', async ({ page }) => {
  await addClipToTimeline(page)
  // A taken playhead lays each new copy in the next gap, so these build the edit in order.
  for (let n = 2; n <= 4; n++) {
    await page.getByTestId('asset-card').dblclick()
    await expect(vclip(page)).toHaveCount(n)
  }
  await expect.poll(async () => readoutS(await page.getByTestId('timecode').textContent(), 1)).toBeGreaterThan(5)
  await page.keyboard.press('Home')
  await page.keyboard.press(' ')
  await page.waitForTimeout(800)
  const during = await page.getByTestId('timecode').textContent()
  expect(during).not.toContain('0:00.00 ')
  expect(during).toMatch(/^0:0[0-4]\.\d\d/)
  await page.keyboard.press(' ')
  const paused = await page.getByTestId('timecode').textContent()
  expect(readoutS(paused), 'the pause press restarted the edit instead of pausing it').toBeGreaterThanOrEqual(readoutS(during))
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
  await expect(page.getByTestId('timecode')).toContainText('0:05.00')
})

test('clicking ON a clip moves the playhead there; dragging it does not', async ({ page }) => {
  await addClipToTimeline(page)
  const clip = vclip(page)
  const box = (await clip.boundingBox())!

  // CLICK (no movement) in the middle of the clip → the playhead jumps there
  // and the preview shows that spot. Selection still happens.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const clicked = await page.getByTestId('timecode').textContent()
  expect(clicked).not.toContain('0:00.00 ')
  const playhead = (await page.getByTestId('playhead').boundingBox())!
  expect(Math.abs(playhead.x - (box.x + box.width / 2))).toBeLessThan(3)

  // DRAG the clip (real movement) → the playhead must NOT follow the pointer.
  await page.keyboard.press('Home')
  await expect(page.getByTestId('timecode')).toContainText('0:00.00')
  await clip.hover()
  const start = (await clip.boundingBox())!
  await page.mouse.move(start.x + 30, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 150, start.y + start.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByTestId('timecode')).toContainText('0:00.00')
})
