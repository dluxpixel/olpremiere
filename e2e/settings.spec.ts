// Settings: one home for every persistent preference, and the theme switch.

import { expect, test, type Page } from '@playwright/test'

async function openSettings(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
}

test('the gear opens Settings; Escape closes it', async ({ page }) => {
  await openSettings(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
})

test('light mode repaints the app and survives a reload; dark restores', async ({ page }) => {
  await openSettings(page)
  const ground = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="topbar"]')!).backgroundColor)
  const darkGround = await ground()

  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const lightGround = await ground()
  expect(lightGround).not.toBe(darkGround)
  // Parchment, not near-black: the ground must actually be light.
  const [r, g, b] = lightGround.match(/\d+/g)!.map(Number)
  expect((r + g + b) / 3).toBeGreaterThan(180)

  // Persisted: a reload comes back light without touching the dialog.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  // And back: dark removes the attribute entirely (dark is the token default).
  await page.getByTestId('settings-open').click()
  await page.getByTestId('theme-dark').click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light')
  expect(await ground()).toBe(darkGround)
})

test('settings write through to the real preferences they consolidate', async ({ page }) => {
  await openSettings(page)

  // Snapping mirrors the timeline toolbar toggle (same store field).
  const snapState = () =>
    page.evaluate(async () => {
      const mod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ mod)) as {
        useStore: { getState: () => { ui: { snapping: boolean } } }
      }
      return useStore.getState().ui.snapping
    })
  const before = await snapState()
  await page.getByTestId('settings-snapping').click()
  expect(await snapState()).toBe(!before)

  // Caption language persists to the same key the Captions dialog reads.
  await page.getByTestId('settings-language').selectOption('cs')
  expect(await page.evaluate(() => localStorage.getItem('olpremiere:captions:lang'))).toBe('cs')

  // Preview quality persists — and it is ONE setting: the monitor's own picker
  // and this one are two surfaces on it, so they can never disagree.
  await page.getByTestId('settings-quality').selectOption('0.5')
  expect(await page.evaluate(() => localStorage.getItem('olpremiere:settings:preview-quality'))).toBe('0.5')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByLabel('Preview quality')).toHaveValue('0.5')

  // ...and back the other way.
  await page.getByLabel('Preview quality').selectOption('0.25')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-quality')).toHaveValue('0.25')
})
