// Voiceover recorder: records the (fake) mic and lands the take in the bin as
// an audio asset via the normal import pipeline. Runs headless because
// playwright.config launches Chromium with a fake mic + auto-granted permission.

import { expect, test } from '@playwright/test'

test('recording the mic adds an audio clip to the bin', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')

  const record = page.getByTestId('record-voice')
  await expect(record).toBeVisible()

  // Start: the elapsed readout appears while recording.
  await record.click()
  await expect(page.getByTestId('record-elapsed')).toBeVisible()

  // Capture roughly a second of audio, then stop.
  await page.waitForTimeout(1200)
  await record.click()
  await expect(page.getByTestId('record-elapsed')).toHaveCount(0)

  // The take is imported as an audio asset (probe + persist + add to bin).
  await expect(page.getByTestId('asset-card')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByText(/Voice recording 1/)).toBeVisible()

  // And it behaves like any audio asset: double-click drops it on an audio track.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
})

test('the mic picker lists input devices and remembers the choice', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')

  // Open the picker beside the record button.
  await page.getByTestId('record-device').click()
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()

  // System default is always offered; Chromium's fake device adds ≥1 real input.
  await expect(menu.getByRole('menuitem', { name: /System default/ })).toBeVisible()
  const items = menu.getByRole('menuitem')
  expect(await items.count()).toBeGreaterThan(1)

  // Pick the first real device; the menu closes.
  await items.nth(1).click()
  await expect(menu).toHaveCount(0)

  // Reopen: exactly one item now carries the ✓ (the remembered device).
  await page.getByTestId('record-device').click()
  await expect(
    page.getByTestId('context-menu').getByRole('menuitem').filter({ hasText: '✓' }),
  ).toHaveCount(1)

  // Toggle "Reduce background noise" on; reopening shows a second ✓ (device + it).
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /Reduce background noise/ }).click()
  await page.getByTestId('record-device').click()
  await expect(
    page.getByTestId('context-menu').getByRole('menuitem').filter({ hasText: '✓' }),
  ).toHaveCount(2)
})
