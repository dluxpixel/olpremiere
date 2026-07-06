import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase8'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function importAndAdd(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

test('keyboard help overlay lists shortcuts and closes on Escape', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('help-open').click()
  const help = page.getByTestId('keyboard-help')
  await expect(help).toBeVisible()
  await expect(help).toContainText('Play / Pause')
  await expect(help).toContainText('Split clip at playhead')
  await expect(help).toContainText('Ripple delete')
  await page.screenshot({ path: `${VERIFY}/keyboard-help.png` })
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  // The `?` shortcut opens it too.
  await page.keyboard.press('Shift+/')
  await expect(page.getByTestId('keyboard-help')).toBeVisible()
})

test('crash recovery: a reload restores the autosaved project', async ({ page }) => {
  await importAndAdd(page)
  // Let the debounced autosave (~1s) flush to IndexedDB.
  await page.waitForTimeout(1500)
  await page.reload()
  // Asset + clip come back from IndexedDB with no user action.
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('unsupported files surface an honest error toast', async ({ page }) => {
  await page.goto('/')
  const bad = `${VERIFY}/notmedia.txt`
  fs.writeFileSync(bad, 'this is not a media file')
  await page.getByTestId('media-file-input').setInputFiles(bad)
  await expect(page.getByTestId('toast')).toContainText(/unsupported|import failed/i, { timeout: 15_000 })
})
