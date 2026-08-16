// The inspector's Add effect menu: it opens, it searches by what an effect
// DOES, and the keyboard alone can apply one.
//
// ⛔ THE FIRST VERSION OF THIS MENU WAS REVERTED because it did not open
// reliably: four runs, four different tests red. So the first test here is not
// about features at all. It opens and shuts the menu ten times in a row and
// fails on the first miss, because "it opened when I tried it" was exactly the
// evidence that was not good enough last time.

import { expect, test, type Page } from '@playwright/test'

import { addEffect } from './addEffect'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function selectedClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click()
  await expect(page.getByTestId('inspector-add-effect')).toBeVisible()
}

test('it opens on the first click, ten times out of ten', async ({ page }) => {
  await selectedClip(page)
  const button = page.getByTestId('inspector-add-effect')
  const menu = page.getByTestId('add-effect-menu')

  for (let i = 0; i < 10; i++) {
    await button.click()
    // No retry loop and no soft wait: it either came up on that click or the
    // control is not ready to be handed over.
    await expect(menu, `open attempt ${i + 1}`).toBeVisible({ timeout: 2_000 })
    await expect(page.getByTestId('add-effect-search')).toBeFocused()
    await button.click()
    await expect(menu, `close attempt ${i + 1}`).toBeHidden({ timeout: 2_000 })
  }
})

test('it finds an effect by what it does, not by its name', async ({ page }) => {
  await selectedClip(page)
  await page.getByTestId('inspector-add-effect').click()
  // "bloom" is nowhere in the word Glow. The description is in the haystack, and
  // that is the entire point of the search box.
  await page.getByTestId('add-effect-search').fill('bloom')
  const rows = page.getByTestId('add-effect-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-type', 'glow')

  await rows.first().click()
  await expect(page.getByTestId('add-effect-menu')).toBeHidden()
  await expect(page.locator('[data-testid="effect-card"][data-effect-type="glow"]')).toHaveCount(1)
})

test('a query that matches nothing says so instead of showing everything', async ({ page }) => {
  await selectedClip(page)
  await page.getByTestId('inspector-add-effect').click()
  await page.getByTestId('add-effect-search').fill('zzzzzznotaneffect')
  await expect(page.getByTestId('add-effect-row')).toHaveCount(0)
  await expect(page.getByText('Nothing matches that.')).toBeVisible()
})

test('the keyboard alone adds an effect', async ({ page }) => {
  await selectedClip(page)
  await page.getByTestId('inspector-add-effect').click()

  // The whole list, so there is a second row for the arrow to reach. A narrow
  // query can come back with one match and then the arrow has nowhere to go.
  const rows = page.getByTestId('add-effect-row')
  await expect(rows.first()).toHaveAttribute('data-highlighted', 'true')
  await page.keyboard.press('ArrowDown')
  const second = rows.nth(1)
  await expect(second).toHaveAttribute('data-highlighted', 'true')
  const wanted = await second.getAttribute('data-type')

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('add-effect-menu')).toBeHidden()
  await expect(page.locator(`[data-testid="effect-card"][data-effect-type="${wanted}"]`)).toHaveCount(1)
})

test('Escape and a click outside both leave the stack alone', async ({ page }) => {
  await selectedClip(page)
  const menu = page.getByTestId('add-effect-menu')

  await page.getByTestId('inspector-add-effect').click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByTestId('effect-card')).toHaveCount(0)

  await page.getByTestId('inspector-add-effect').click()
  await expect(menu).toBeVisible()
  await page.getByTestId('add-effect-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(menu).toBeHidden()
  await expect(page.getByTestId('effect-card')).toHaveCount(0)
})

test('the search box is empty again the next time it opens', async ({ page }) => {
  await selectedClip(page)
  await addEffect(page, 'glow')
  await page.getByTestId('inspector-add-effect').click()
  // A stale query would show him a filtered list he never asked for, which is
  // the same menu appearing to have lost half its effects.
  await expect(page.getByTestId('add-effect-search')).toHaveValue('')
})
