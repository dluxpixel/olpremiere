// TWO deletes, not three: Delete is selection-scoped (the audio half of a
// linked pair goes alone; a video clip takes its pair), Ripple delete stays.
// The enumerated "Delete audio only (keep video)" / "Delete video only" menu
// items are gone — this spec pins their replacement.

import { expect, test, type Page } from '@playwright/test'

async function bootPair(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  // A video WITH audio drops as a linked pair: video on V1, audio on A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
}

test('the clip menu offers exactly TWO deletes; on the audio half it reads "Delete audio"', async ({
  page,
}) => {
  await bootPair(page)
  await page.locator('[data-clip-kind="audio"]').click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu.getByRole('menuitem', { name: /delete/i })).toHaveCount(2)
  await expect(menu.getByRole('menuitem', { name: 'Delete audio' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Ripple delete/ })).toBeVisible()

  // "Delete audio" removes just the audio; the video survives.
  await menu.getByRole('menuitem', { name: 'Delete audio' }).click()
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('Del on a selected audio half deletes only it; on the video it takes the pair', async ({
  page,
}) => {
  await bootPair(page)
  // Select the AUDIO half → Del removes only the audio.
  await page.locator('[data-clip-kind="audio"]').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Undo restores the pair; Del on the VIDEO clip removes both halves.
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click({ position: { x: 20, y: 10 } })
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
})
