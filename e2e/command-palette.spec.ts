import { expect, test, type Page } from '@playwright/test'

// Spec 3.3: command palette on Ctrl/Cmd+K. Fuzzy-searchable list of every
// keymap command with its shortcut, keyboard-navigable, and running the
// highlighted command for real (asserted through the store's bound UI).

async function openPalette(page: Page): Promise<void> {
  await page.goto('/')
  // Click a neutral panel first: moves focus off any field AND lets the
  // keymap's mount effect install before we press (mirrors safety.spec.ts).
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
}

test('Ctrl+K opens the palette listing commands with shortcuts, Escape closes', async ({ page }) => {
  await openPalette(page)
  const palette = page.getByTestId('command-palette')

  // Generated from the live keymap: commands appear with their combo labels.
  await expect(palette.getByRole('option', { name: /Play \/ Pause/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /Play \/ Pause/ })).toContainText('Space')
  await expect(palette.getByRole('option', { name: /Split at playhead/ })).toBeVisible()
  // Domain group headers show in the browse (empty query) view.
  await expect(palette.getByText('Transport', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
})

test('typing narrows the list by fuzzy match', async ({ page }) => {
  await openPalette(page)
  const options = page.getByTestId('command-palette').getByRole('option')
  const all = await options.count()
  expect(all).toBeGreaterThan(20)

  await page.getByTestId('palette-input').fill('snap')
  await expect(options.first()).toContainText('Toggle snapping')
  const narrowed = await options.count()
  expect(narrowed).toBeGreaterThan(0)
  expect(narrowed).toBeLessThan(all)
})

test('Enter runs the highlighted command (store effect: snapping toggles off)', async ({ page }) => {
  await openPalette(page)
  const snap = page.getByTestId('snap-toggle')
  await expect(snap).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('palette-input').fill('toggle snapping')
  await page.keyboard.press('Enter')

  // The palette closes and the command really ran against the store.
  await expect(page.getByTestId('command-palette')).toBeHidden()
  await expect(snap).not.toHaveAttribute('aria-pressed', 'true')
})

test('arrow keys move the highlight and Enter runs the highlighted row', async ({ page }) => {
  await openPalette(page)
  const options = page.getByTestId('command-palette').getByRole('option')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(options.first()).toHaveAttribute('aria-selected', 'false')

  // Typing resets the highlight to the top hit; Enter runs it.
  await page.getByTestId('palette-input').fill('razor')
  await expect(options.first()).toContainText('Razor')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-palette')).toBeHidden()
  // The razor tool is now active in the toolbar (store-bound aria-pressed).
  await expect(page.getByRole('button', { name: 'Razor (blade) tool' })).toHaveAttribute('aria-pressed', 'true')
})

test('Ctrl+K no longer splits: with a palette open it toggles closed', async ({ page }) => {
  await openPalette(page)
  // Pressing the combo again (focus sits in the palette input) closes it
  // instead of running the old redundant split alias.
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('command-palette')).toBeHidden()
})
