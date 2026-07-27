// The boot screen — the loading card and the melon it opens into.
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
  // The editor has NOT mounted yet — the card is the whole screen.
  await expect(page.getByTestId('panel-left')).toHaveCount(0)

  // Six rows on the web build; the update row is desktop-only.
  await expect(card.locator('li[data-step]')).toHaveCount(6)
  await expect(card.locator('li[data-step="updates"]')).toHaveCount(0)

  // `settings` is already done on the first paint, because that work really does
  // run before React mounts. A decorative list could not be true this early.
  await expect(card.locator('li[data-step="settings"]')).toHaveAttribute('data-state', 'done')

  const bar = card.getByRole('progressbar')
  const pct = Number(await bar.getAttribute('aria-valuenow'))
  expect(pct).toBeGreaterThan(0)
  await expect(page.getByTestId('boot-status-line')).not.toBeEmpty()

  // Every row lands, so the bar reaches 100 — on real work, with the card frozen.
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
  // And it never opens the editor by itself — that click is the audio gesture.
  await expect(page.getByTestId('panel-left')).toHaveCount(0)
})
