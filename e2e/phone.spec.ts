// THE EDITOR ON A PHONE (2026-09-23). His words: "I am on the bus for 2 hours a
// day, and I'm thinking: what if I edit videos on my phone?"
//
// The whole bus edit, driven with a finger at iPhone size: the phone layout
// appears (and never on the desktop), media goes on the timeline with a tap, a
// tapped clip drags while a swipe over any other clip only scrolls, split and
// delete are buttons, and the export is handed to the share sheet so it lands
// in Photos. Chromium stands in for Safari here; the share sheet and the
// missing save dialog are Safari's, so both are set up the way an iPhone has
// them.

import { expect, test, type CDPSession, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const IPHONE = {
  viewport: { width: 393, height: 659 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
}

async function addClip(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('phone-shell')).toBeVisible()
  await page.getByTestId('phone-tab-media').tap()
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-add').tap()
  await expect(page.getByTestId('phone-tab-timeline')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** A one finger drag, sent as real touch input so the browser decides pan versus drag itself. */
async function fingerDrag(cdp: CDPSession, x0: number, y0: number, dx: number): Promise<void> {
  const at = (x: number) => [{ x, y: y0, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0) })
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x0 + (dx * i) / 12) })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const clipLeft = (page: Page, kind: 'video' | 'audio') =>
  page.locator(`[data-clip-kind="${kind}"]`).first().evaluate((e) => e.getBoundingClientRect().left)

test.describe('on a phone', () => {
  test.use(IPHONE)

  test('the phone layout fits the screen with the export in reach', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('phone-shell')).toBeVisible()
    await expect(page.getByTestId('splitter-left')).toHaveCount(0)
    const fit = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      screen: innerWidth,
      exportRight: document.querySelector('[data-testid="export-open"]')!.getBoundingClientRect().right,
    }))
    expect(fit.page).toBeLessThanOrEqual(fit.screen)
    expect(fit.exportRight).toBeLessThanOrEqual(fit.screen)
  })

  test('Add puts the clip on the timeline and shows it', async ({ page }) => {
    await addClip(page)
  })

  test('a tapped clip drags with a finger, a swipe over any other clip only scrolls', async ({ page, context }) => {
    await addClip(page)
    const cdp = await context.newCDPSession(page)

    // The audio half is NOT selected: a swipe across it must leave it exactly
    // where it was. This is the pointercancel the browser sends when it takes
    // the finger to scroll, and a commit there would nudge the clip.
    const audio = (await page.locator('[data-clip-kind="audio"]').first().boundingBox())!
    const audioBefore = await clipLeft(page, 'audio')
    await fingerDrag(cdp, audio.x + audio.width / 2, audio.y + audio.height / 2, 90)
    await page.waitForTimeout(300)
    expect(await clipLeft(page, 'audio')).toBe(audioBefore)

    // Tap the video half to select it, then the same finger drag moves it.
    const video = (await page.locator('[data-clip-kind="video"]').first().boundingBox())!
    await page.touchscreen.tap(video.x + video.width / 2, video.y + video.height / 2)
    const before = await clipLeft(page, 'video')
    await fingerDrag(cdp, video.x + video.width / 2, video.y + video.height / 2, 90)
    await expect.poll(() => clipLeft(page, 'video')).toBeGreaterThan(before + 40)
  })

  test('split and delete are buttons, because a phone has no keys', async ({ page }) => {
    await addClip(page)
    const ruler = (await page.getByTestId('ruler').boundingBox())!
    const video = (await page.locator('[data-clip-kind="video"]').first().boundingBox())!
    await page.touchscreen.tap(video.x + video.width / 2, ruler.y + ruler.height / 2)
    await page.getByTestId('phone-split').tap()
    await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

    const first = (await page.locator('[data-clip-kind="video"]').first().boundingBox())!
    await page.touchscreen.tap(first.x + first.width / 2, first.y + first.height / 2)
    await page.getByTestId('phone-delete').tap()
    await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  })

  test('the export goes to the share sheet, so it can be saved to Photos', async ({ page, context }) => {
    await context.addInitScript(() => {
      // An iPhone has no save dialog, and it has a share sheet.
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
      navigator.canShare = () => true
      navigator.share = async (data?: ShareData) => {
        const f = data!.files![0]!
        ;(window as { __shared?: unknown }).__shared = { name: f.name, size: f.size, type: f.type }
      }
    })
    await addClip(page)
    await page.getByTestId('export-open').tap()
    await expect(page.getByTestId('export-share')).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('export-share').tap()
    await expect
      .poll(() => page.evaluate(() => (window as { __shared?: { size: number; type: string } }).__shared))
      .toMatchObject({ type: 'video/mp4' })
    const shared = await page.evaluate(() => (window as unknown as { __shared: { size: number } }).__shared)
    expect(shared.size).toBeGreaterThan(10_000)
  })
})

test('the desktop never gets the phone layout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('splitter-left')).toBeVisible()
  await expect(page.getByTestId('phone-shell')).toHaveCount(0)
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('asset-add')).toBeHidden()
})
