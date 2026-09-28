// Library categories he names. His words, 2026-09-28: *"when I want to save a
// sound effect for Battle Cats, I can."* The unit tests prove the rules; this
// clicks through the menus and the name dialog the way he would, and proves a
// category and what is in it outlive a reload.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function importClip(page: Page): Promise<void> {
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

function categoryRow(page: Page, name: string) {
  return page.getByTestId('library-category').filter({ hasText: name })
}

test('save into a new category he names, and it is still there after a reload', async ({ page }) => {
  await page.goto('/')
  await importClip(page)

  await page.getByTestId('asset-card').first().click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await menu.getByRole('menuitem', { name: 'Save to a category' }).hover()
  await menu.getByRole('menuitem', { name: 'New category...' }).click()
  await page.getByTestId('name-prompt-input').fill('Battle Cats')
  await page.getByTestId('name-prompt-save').click()
  await expect(page.getByTestId('name-prompt')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(categoryRow(page, 'Battle Cats')).toBeVisible()
  await expect(categoryRow(page, 'Battle Cats')).toContainText('1')
  await categoryRow(page, 'Battle Cats').click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)

  await page.reload()
  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(categoryRow(page, 'Battle Cats')).toBeVisible()
  await categoryRow(page, 'Battle Cats').click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)
})

test('removing a category keeps what was in it, under Unsorted', async ({ page }) => {
  await page.goto('/')
  await importClip(page)

  await page.getByTestId('asset-card').first().click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await menu.getByRole('menuitem', { name: 'Save to a category' }).hover()
  await menu.getByRole('menuitem', { name: 'New category...' }).click()
  await page.getByTestId('name-prompt-input').fill('Battle Cats')
  await page.getByTestId('name-prompt-save').click()

  await page.getByRole('tab', { name: 'Library' }).click()
  await categoryRow(page, 'Battle Cats').click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /Remove category/ }).click()

  await expect(categoryRow(page, 'Battle Cats')).toHaveCount(0)
  await categoryRow(page, 'Unsorted').click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)
})

test('a name already taken is refused in the dialog, not silently merged', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Library' }).click()
  await page.getByTestId('library-new-category').click()
  await page.getByTestId('name-prompt-input').fill('Battle Cats')
  await page.getByTestId('name-prompt-save').click()
  await expect(categoryRow(page, 'Battle Cats')).toBeVisible()

  await page.getByTestId('library-new-category').click()
  await page.getByTestId('name-prompt-input').fill('battle cats')
  await page.getByTestId('name-prompt-save').click()
  await expect(page.getByTestId('name-prompt-problem')).not.toBeEmpty()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-category').filter({ hasText: /battle cats/i })).toHaveCount(1)
})
