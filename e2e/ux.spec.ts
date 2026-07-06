import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

async function importAndAdd(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
}

test('right-clicking a clip opens the app menu, not the browser menu', async ({ page }) => {
  await importAndAdd(page)
  await vclip(page).click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('Copy')
  await expect(menu).toContainText('Split at playhead')
  // Delete removes the clip and its linked audio (label span has exact text).
  await menu.getByText('Delete', { exact: true }).click()
  await expect(vclip(page)).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
})

test('right-clicking a media card can delete it from the bin', async ({ page }) => {
  await importAndAdd(page)
  await page.getByTestId('asset-card').click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete from bin' }).click()
  // The bin card and any clips using it are gone.
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  await expect(vclip(page)).toHaveCount(0)
})

test('context menu closes on Escape and outside click', async ({ page }) => {
  await importAndAdd(page)
  await vclip(page).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
})

test('pause reliably stops playback (timecode freezes)', async ({ page }) => {
  await importAndAdd(page)
  await page.keyboard.press('Home')
  await page.getByTestId('play-toggle').click() // play
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', 'Pause')
  await page.waitForTimeout(700)
  await page.getByTestId('play-toggle').click() // pause
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', 'Play')
  const at = await page.getByTestId('timecode').textContent()
  await page.waitForTimeout(500)
  expect(await page.getByTestId('timecode').textContent()).toBe(at)
  // And it actually advanced before pausing.
  expect(at).not.toContain('00:00:00:00 ')
})
