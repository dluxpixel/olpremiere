// The boot screen: the loading card and the melon it opens into.
//
// Under automation the boot is skipped so every other spec can drive the editor
// directly; that skip has never had a test, and a regression in it would fail all
// of the other spec files at once with no clue why. The first test here is that
// canary. The rest opt in with `?boot=`, the only way a driven browser can see the
// boot screen at all.

import { expect, test } from '@playwright/test'

test('a normal automated run still skips straight to the editor', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await expect(page.getByTestId('boot-loading-card')).toHaveCount(0)
  await expect(page.getByTestId('boot-splash')).toHaveCount(0)
})

test('the loading card reports the real startup work, not a timer', async ({ page }) => {
  await page.goto('/?boot=hold')
  const card = page.getByTestId('boot-loading-card')
  await expect(card).toBeVisible()
  // The editor has NOT mounted yet, so the card is the whole screen.
  await expect(page.getByTestId('panel-left')).toHaveCount(0)

  // Ten rows on the web build; the update row is desktop-only. Was six until
  // 2026-08-05, when the three WARM-UP rows landed and then the preview-copy
  // row joined them: the splash now pays the bills the app used to defer to his
  // first play, his first caption run and his first cut-heavy playback.
  await expect(card.locator('li[data-step]')).toHaveCount(10)
  await expect(card.locator('li[data-step="updates"]')).toHaveCount(0)
  for (const id of ['warmVideo', 'warmAudio', 'captions']) {
    await expect(card.locator(`li[data-step="${id}"]`)).toHaveCount(1)
  }

  // `settings` is already done on the first paint, because that work really does
  // run before React mounts. A decorative list could not be true this early.
  await expect(card.locator('li[data-step="settings"]')).toHaveAttribute('data-state', 'done')

  const bar = card.getByRole('progressbar')
  const pct = Number(await bar.getAttribute('aria-valuenow'))
  expect(pct).toBeGreaterThan(0)
  await expect(page.getByTestId('boot-status-line')).not.toBeEmpty()

  // Every row lands, so the bar reaches 100 on real work, with the card frozen.
  await expect
    .poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 15_000 })
    .toBe(100)
})

test('the melon opens the editor', async ({ page }) => {
  await page.goto('/?boot=melon')
  const melon = page.getByRole('button', { name: 'Launch OL Premiere' })
  await expect(melon).toBeVisible()
  await expect(melon).toBeFocused() // Enter/Space works without reaching for the mouse
  await expect(page.getByTestId('boot-loading-card')).toHaveCount(0)

  await melon.click()
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await expect(page.getByTestId('boot-splash')).toHaveCount(0)
})

test('the card gives way to the melon on its own', async ({ page }) => {
  await page.goto('/?boot=show')
  await expect(page.getByTestId('boot-loading-card')).toBeVisible()
  // No click, no nudge: the real gate closes and the melon takes the screen.
  await expect(page.getByRole('button', { name: 'Launch OL Premiere' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('boot-loading-card')).toHaveCount(0)
  // And it never opens the editor by itself. That click is the audio gesture.
  await expect(page.getByTestId('panel-left')).toHaveCount(0)
})

test('the warm-up rows do real work, and the app opens even if they do not finish', async ({ page }) => {
  // His ask, 2026-08-05: make the loading actually worth it. The rows below are
  // the answer, so they get checked the same way every other row is: by landing.
  await page.goto('/?boot=show')
  const card = page.getByTestId('boot-loading-card')
  await expect(card).toBeVisible()

  // Both gating warm-up rows must SETTLE. If one hung, the card would sit here
  // and this poll would time out, which is exactly the failure worth catching.
  for (const id of ['warmVideo', 'warmAudio']) {
    await expect
      .poll(async () => card.locator(`li[data-step="${id}"]`).getAttribute('data-state'), { timeout: 15_000 })
      .toMatch(/done|failed/)
  }

  // And the editor opens regardless of the caption model, which is the whole
  // reason that row is optional: it can still be downloading right now.
  const melon = page.getByRole('button', { name: 'Launch OL Premiere' })
  await expect(melon).toBeVisible({ timeout: 15_000 })
  await melon.click()
  await expect(page.getByTestId('panel-left')).toBeVisible()
})
