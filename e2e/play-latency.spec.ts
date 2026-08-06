// "I click space or click the play button. It just doesn't work, or it's really
// late." (2026-08-06)
//
// play() used to await scheduleAudio, which decodes EVERY audible clip before
// it resolves. Warm, that is instant, which is why the existing playback spec
// never caught it. COLD - a file just imported, a project just opened - Space
// sat there decoding whole files before a single frame moved.
//
// So this presses Space at the coldest moment there is: immediately after the
// clip lands, with no settling wait at all.

import { expect, test, type Page } from '@playwright/test'

async function playhead(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
    return useStore.getState().ui.playheadS
  })
}

test('Space starts the picture promptly even on a stone-cold clip', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().waitFor({ timeout: 15_000 })

  // No settle. This is the moment he complains about.
  await page.getByTestId('timeline').click({ position: { x: 4, y: 4 } }).catch(() => {})
  const t0 = Date.now()
  await page.keyboard.press(' ')

  // The picture must be moving well inside a second.
  await expect
    .poll(async () => await playhead(page), { timeout: 2500, intervals: [50, 50, 100] })
    .toBeGreaterThan(0)
  const latency = Date.now() - t0
  expect(latency).toBeLessThan(1500)

  await page.keyboard.press(' ')
})

test('the play BUTTON behaves the same as Space', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().waitFor({ timeout: 15_000 })

  await page.getByTestId('play-toggle').click()
  await expect
    .poll(async () => await playhead(page), { timeout: 2500, intervals: [50, 50, 100] })
    .toBeGreaterThan(0)
  await page.getByTestId('play-toggle').click()
})
