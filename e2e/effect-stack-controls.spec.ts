// Fold a card, turn the whole look off, and reset the lot. The state behind all
// three is unit tested in src/state/effectStack.test.ts; what this covers is the
// wiring, which is where a header button that reads the wrong clip would hide.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function clipWithTwoEffects(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click()
  await page.getByTestId('inspector-add-effect').selectOption('gaussianBlur')
  await page.getByTestId('inspector-add-effect').selectOption('glow')
  await expect(page.getByTestId('effect-card')).toHaveCount(2)
}

test('folding a card hides its controls and keeps the effect', async ({ page }) => {
  await clipWithTwoEffects(page)
  const first = page.getByTestId('effect-card').first()
  await expect(first.getByTestId('effect-ease')).toBeVisible()

  await first.getByTestId('effect-fold').click()
  await expect(first.getByTestId('effect-ease')).toBeHidden()
  // Folded is a VIEW state: the effect itself is untouched and still on.
  await expect(page.getByTestId('effect-card')).toHaveCount(2)
  await expect(first).toHaveAttribute('data-folded', 'true')

  await first.getByTestId('effect-fold').click()
  await expect(first.getByTestId('effect-ease')).toBeVisible()
})

test('fold every effect from the header, then open them again', async ({ page }) => {
  await clipWithTwoEffects(page)
  await page.getByTestId('fold-all-effects').click()
  await expect(page.locator('[data-testid="effect-card"][data-folded="true"]')).toHaveCount(2)
  await page.getByTestId('fold-all-effects').click()
  await expect(page.locator('[data-testid="effect-card"][data-folded="true"]')).toHaveCount(0)
})

test('one button turns the whole look off and back on', async ({ page }) => {
  await clipWithTwoEffects(page)
  // Nothing is off, so no card wears the Off word.
  await expect(page.getByTestId('effect-off-chip')).toHaveCount(0)

  await page.getByTestId('bypass-all-effects').click()
  await expect(page.getByTestId('effect-off-chip')).toHaveCount(2)

  // And the word is itself the switch: clicking one brings that effect back.
  await page.getByTestId('effect-off-chip').first().click()
  await expect(page.getByTestId('effect-off-chip')).toHaveCount(1)

  // From MIXED, the button's job is still to turn the look off: any one still
  // live means there is a look to compare against. It takes the second press to
  // bring the whole stack back, and that is the behaviour to keep.
  await page.getByTestId('bypass-all-effects').click()
  await expect(page.getByTestId('effect-off-chip')).toHaveCount(2)
  await page.getByTestId('bypass-all-effects').click()
  await expect(page.getByTestId('effect-off-chip')).toHaveCount(0)
})

test('the effect he just added rides at the top of the add list', async ({ page }) => {
  await clipWithTwoEffects(page)
  // Recent is remembered across clips and sessions, so the group is there and
  // the last one applied is its first entry.
  const firstRecent = page.locator('[data-testid="inspector-add-effect"] optgroup[label="Recent"] option').first()
  await expect(firstRecent).toHaveAttribute('value', 'glow')
})
