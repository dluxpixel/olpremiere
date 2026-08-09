// The permanent action box under every bin item: Save (to the Library) and a
// Remove that takes two clicks.
//
// The arming is what breaks silently, so all four of its rules are pinned here
// against the real DOM: one click never removes, two clicks do, the arm goes
// cold on its own, and it goes cold on Escape or on losing focus. The state
// machine itself is unit tested in src/components/armedDelete.test.ts; this
// file is about the WIRING (which button, which action, which key).

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** Comfortably past ARM_WINDOW_MS in src/components/armedDelete.ts. */
const PAST_THE_ARM_WINDOW_MS = 4_500

async function importClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

test('the action box is on every bin item, with no hover and nothing selected', async ({ page }) => {
  await importClip(page)
  // Permanent is the whole point: this must be true of a panel nobody has
  // touched since the import.
  await expect(page.getByTestId('asset-actions')).toBeVisible()
  await expect(page.getByTestId('asset-save-to-library')).toBeVisible()
  await expect(page.getByTestId('asset-remove')).toHaveText('Remove')
})

test('one click does not remove the asset, and the second one does', async ({ page }) => {
  await importClip(page)
  const remove = page.getByTestId('asset-remove')

  await remove.click()
  await expect(remove).toHaveText('Confirm')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)

  await remove.click()
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  // Same removal as every other path, so it still carries its Undo.
  await expect(page.getByText(/Removed clip\.webm/)).toBeVisible()
})

test('the removal takes its clips with it, in one undo step', async ({ page }) => {
  await importClip(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  const remove = page.getByTestId('asset-remove')
  await remove.click()
  await remove.click()
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)

  // One Ctrl+Z brings back the bin item AND the clip.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('an armed remove disarms itself when the second click never comes', async ({ page }) => {
  await importClip(page)
  const remove = page.getByTestId('asset-remove')

  await remove.click()
  await expect(remove).toHaveText('Confirm')

  await page.waitForTimeout(PAST_THE_ARM_WINDOW_MS)
  await expect(remove).toHaveText('Remove')

  // And the click that lands afterwards only arms again. It must not delete.
  await remove.click()
  await expect(remove).toHaveText('Confirm')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
})

test('Escape disarms an armed remove', async ({ page }) => {
  await importClip(page)
  const remove = page.getByTestId('asset-remove')

  await remove.click()
  await expect(remove).toHaveText('Confirm')
  await page.keyboard.press('Escape')
  await expect(remove).toHaveText('Remove')

  await remove.click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
})

test('leaving the button disarms an armed remove', async ({ page }) => {
  await importClip(page)
  const remove = page.getByTestId('asset-remove')

  await remove.click()
  await expect(remove).toHaveText('Confirm')

  // Focus goes somewhere else in the panel. An armed delete must never be left
  // sitting on screen waiting for a click that was aimed at something else.
  await page.getByTestId('open-captions').focus()
  await expect(remove).toHaveText('Remove')
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
})

test('the box is reachable by keyboard, and Enter there does not touch the timeline', async ({ page }) => {
  await importClip(page)
  const remove = page.getByTestId('asset-remove')

  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(remove).toHaveText('Confirm')
  // The card's own Enter drops the asset at the playhead. A keypress meant for
  // the button must not fall through to it.
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)
  await expect(page.getByTestId('asset-card')).toHaveCount(1)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
})

test('Save puts the media in the Library, and the button then says it is there', async ({ page }) => {
  await importClip(page)
  const save = page.getByTestId('asset-save-to-library')

  await save.click()
  await expect(page.getByText(/Saved .* to Library/)).toBeVisible()
  // Saving the same media twice is a no-op, so the button stops offering it.
  await expect(save).toBeDisabled()

  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)
})

test('the Library copy survives removing the original from the bin', async ({ page }) => {
  await importClip(page)
  await page.getByTestId('asset-save-to-library').click()
  await expect(page.getByText(/Saved .* to Library/)).toBeVisible()

  const remove = page.getByTestId('asset-remove')
  await remove.click()
  await remove.click()
  await expect(page.getByTestId('asset-card')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)
})
