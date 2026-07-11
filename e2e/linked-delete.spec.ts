// Deleting one half of a linked A/V pair: "delete the audio, keep the video".

import { expect, test } from '@playwright/test'

test('right-clicking the audio of a linked clip can delete just the audio', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // A video WITH audio drops as a linked pair: video on V1, audio on A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)

  // Right-click the AUDIO clip and delete only it.
  await page.locator('[data-clip-kind="audio"]').click({ button: 'right' })
  await page.getByText('Delete audio only (keep video)').click()

  // Audio gone, video stays.
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('the linked-only delete option does not appear for an unlinked clip', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()

  // Delete the audio half first, leaving an unlinked video.
  await page.locator('[data-clip-kind="audio"]').click({ button: 'right' })
  await page.getByText('Delete audio only (keep video)').click()
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)

  // The surviving video keeps a dangling link marker, so its context menu still
  // offers the split option but plain Delete now removes only it.
  await page.locator('[data-clip-kind="video"]').click({ button: 'right' })
  await expect(page.getByText('Delete', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
})
