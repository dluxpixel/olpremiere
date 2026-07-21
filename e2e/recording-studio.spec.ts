// The recording studio: a take is reviewed (kept or discarded), never dropped
// straight into the bin. The panel is movable and exposes input/output devices
// and monitoring. Playwright launches with a fake mic (see playwright.config),
// so a real capture round-trip runs headless.

import { expect, test, type Page } from '@playwright/test'

async function openStudio(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('record-voice').click()
  await expect(page.getByTestId('recording-studio')).toBeVisible()
}

async function binCount(page: Page): Promise<number> {
  return page.getByTestId('asset-card').count()
}

test('record, review, and KEEP puts one asset in the bin', async ({ page }) => {
  await openStudio(page)
  expect(await binCount(page)).toBe(0)

  await page.getByTestId('studio-record').click()
  await expect(page.getByTestId('studio-elapsed')).toBeVisible()
  await page.waitForTimeout(600)
  await page.getByTestId('studio-record').click() // stop

  // The take waits for a decision; nothing in the bin yet.
  await expect(page.getByTestId('studio-take')).toBeVisible()
  expect(await binCount(page)).toBe(0)

  await page.getByTestId('studio-keep').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await expect(page.getByTestId('studio-take')).toHaveCount(0)
})

test('a bad take can be DISCARDED and never reaches the bin', async ({ page }) => {
  await openStudio(page)
  await page.getByTestId('studio-record').click()
  await page.waitForTimeout(400)
  await page.getByTestId('studio-record').click()

  await expect(page.getByTestId('studio-take')).toBeVisible()
  await page.getByTestId('studio-discard').click()
  await expect(page.getByTestId('studio-take')).toHaveCount(0)
  expect(await binCount(page)).toBe(0)
})

test('the panel is movable and exposes input, output, and monitoring', async ({ page }) => {
  await openStudio(page)
  await expect(page.getByTestId('studio-input')).toBeVisible()
  await expect(page.getByTestId('studio-output')).toBeVisible()
  await expect(page.getByTestId('studio-monitor')).toBeVisible()

  const panel = page.getByTestId('recording-studio')
  const before = (await panel.boundingBox())!
  // Grab the header title (not the close button) and drag it down-right.
  const grip = panel.getByText('Record', { exact: true })
  const gb = (await grip.boundingBox())!
  await page.mouse.move(gb.x + 4, gb.y + gb.height / 2)
  await page.mouse.down()
  await page.mouse.move(gb.x + 220, gb.y + 200, { steps: 10 })
  await page.mouse.up()
  const after = (await panel.boundingBox())!
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(80)
  expect(Math.abs(after.y - before.y)).toBeGreaterThan(80)

  // Monitoring toggles and warns about speaker feedback.
  await page.getByTestId('studio-monitor').click()
  await expect(page.getByTestId('studio-monitor')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/headphones/i)).toBeVisible()
})

test('the chosen input persists across a reload', async ({ page }) => {
  await openStudio(page)
  const input = page.getByTestId('studio-input')
  const opts = await input.locator('option').count()
  test.skip(opts < 2, 'the fake device backend exposes only the default input')
  const value = await input.locator('option').nth(1).getAttribute('value')
  await input.selectOption(value!)

  await page.reload()
  await page.getByTestId('record-voice').click()
  await expect(page.getByTestId('studio-input')).toHaveValue(value!)
})

test('closing the studio drops an unreviewed take', async ({ page }) => {
  await openStudio(page)
  await page.getByTestId('studio-record').click()
  await page.waitForTimeout(400)
  await page.getByTestId('studio-record').click()
  await expect(page.getByTestId('studio-take')).toBeVisible()

  await page.getByTestId('studio-close').click()
  await expect(page.getByTestId('recording-studio')).toHaveCount(0)
  // Reopen: the discarded take is gone, the bin is still empty.
  await page.getByTestId('record-voice').click()
  await expect(page.getByTestId('studio-take')).toHaveCount(0)
  expect(await binCount(page)).toBe(0)
})
