import { expect, test, type Page } from '@playwright/test'

// THE ROUNDER-CORNERS PASS, CHECKED ON SCREEN (2026-10-03). His words: "make every GUI more
// rounded to make the corners a little bit more rounded everywhere, but also double-check that
// the GUI doesn't overlap and everything works correctly."
//
// radiusScale.test.ts holds the scale and bans a hard-coded corner in the source. What it cannot
// say is whether the scale REACHES the screen, and the walk-through at 1600x900 and 1280x720 that
// came with the change found two things that were wrong on a short or narrow window, both older
// than the new corners: a tooltip on a button at the edge of the inspector was cut in half by the
// panel, and the clip right-click menu was taller than a 720px window, so its last row (Delete)
// sat where nothing could reach it.

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function clipOnTimeline(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

const radiusOf = (page: Page, testId: string): Promise<number> =>
  page.getByTestId(testId).first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))

for (const size of [
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size })

    test('a tooltip on a button at the inspector edge stays inside the inspector', async ({ page }) => {
      await clipOnTimeline(page)
      await page.locator('[data-clip-kind="video"]').first().click()
      const panel = (await page.getByTestId('panel-right').boundingBox())!

      // The stopwatch is the first thing in its row, flush with the panel's left edge: its
      // tooltip used to be centred on it and run out past the edge, where the panel cut it.
      await page.getByTestId('volume-stopwatch').hover()
      const tip = page.locator('[role="tooltip"]:visible')
      await expect(tip).toHaveCount(1)
      await expect
        .poll(async () => {
          const box = (await tip.boundingBox())!
          return box.x >= panel.x && box.x + box.width <= panel.x + panel.width
        })
        .toBe(true)

      // And the other edge: the reset button is the last thing in its row.
      await page.getByRole('button', { name: 'Reset volume to 0 dB' }).hover()
      await expect(tip).toHaveCount(1)
      await expect
        .poll(async () => {
          const box = (await tip.boundingBox())!
          return box.x >= panel.x && box.x + box.width <= panel.x + panel.width
        })
        .toBe(true)
    })

    test('the right-click menu on a clip fits the window, Delete included', async ({ page }) => {
      await clipOnTimeline(page)
      await page.locator('[data-clip-kind="video"]').first().click({ button: 'right' })
      const menu = page.getByTestId('context-menu')
      await expect(menu).toBeVisible()
      const box = (await menu.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
      // Every row can be reached: on a short window the menu scrolls inside the window (it gained rows
      // with the stopwatch-time cut work, so 720px no longer holds all of it), and the last row, Delete
      // included, comes into view and can be clicked.
      const rows = menu.getByRole('menuitem')
      await rows.last().scrollIntoViewIfNeeded()
      const last = (await rows.last().boundingBox())!
      expect(last.y + last.height).toBeLessThanOrEqual(size.height)
    })
  })
}

test('on a window too short even for that, the menu scrolls instead of running off, and a flyout still opens beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 })
  await clipOnTimeline(page)
  await page.locator('[data-clip-kind="video"]').first().click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(520)
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  // Reaching the last row means scrolling the menu, which must not shut it: any scroll
  // used to close a menu, on the grounds that the point it hangs from had moved.
  await page.waitForTimeout(400)
  await menu.getByRole('menuitem').last().scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  await expect(menu).toBeVisible()
  const last = (await menu.getByRole('menuitem').last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(520)

  // A flyout opens beside its row, whole, though its parent is a scroller now.
  await menu.locator('[aria-haspopup]').first().hover()
  const flyout = page.getByRole('menu').nth(1)
  await expect(flyout).toBeVisible()
  const f = (await flyout.boundingBox())!
  expect(f.x).toBeGreaterThanOrEqual(0)
  expect(f.x + f.width).toBeLessThanOrEqual(1280)
  expect(f.y).toBeGreaterThanOrEqual(0)
  expect(f.y + f.height).toBeLessThanOrEqual(520)
})

test('the new scale reaches the screen: dialog 12, menu 8, button 6, clip 4', async ({ page }) => {
  await clipOnTimeline(page)

  // A clip. It is wide enough here to take the clip radius, not the narrow one.
  const clip = page.locator('[data-clip-kind="video"]').first()
  expect(await clip.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(4)

  // A button.
  expect(await radiusOf(page, 'open-projects')).toBe(6)

  // A menu.
  await clip.click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  expect(await radiusOf(page, 'context-menu')).toBe(8)
  await page.keyboard.press('Escape')

  // A dialog. The open project is written to storage first, so it has a row to measure.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const persistMod = '/src/state/persistence.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { saveProject } = (await import(/* @vite-ignore */ persistMod)) as { saveProject: (p: unknown) => Promise<void> }
    await saveProject(useStore.getState().project)
  })
  await page.getByTestId('open-projects').click()
  await expect(page.getByTestId('projects-dialog')).toBeVisible()
  expect(await radiusOf(page, 'projects-dialog')).toBe(12)
  // A row inside it is rounder than a button but never as round as the dialog around it.
  const row = await radiusOf(page, 'project-row')
  expect(row).toBe(8)
  expect(row).toBeLessThan(await radiusOf(page, 'projects-dialog'))
})

test('a one-frame sliver of a clip keeps crisp ends instead of rounding into a pill', async ({ page }) => {
  await clipOnTimeline(page)
  const ruler = page.getByTestId('ruler')
  // Two cuts a few pixels apart leave a clip about 6px wide between them.
  await ruler.click({ position: { x: 30, y: 10 } })
  await page.keyboard.press('c')
  await ruler.click({ position: { x: 36, y: 10 } })
  await page.keyboard.press('c')
  const widths = await page
    .locator('[data-clip-kind="video"]')
    .evaluateAll((els) => els.map((el) => ({ w: el.getBoundingClientRect().width, r: parseFloat(getComputedStyle(el).borderTopLeftRadius) })))
  const sliver = widths.find((c) => c.w < 16)
  expect(sliver, 'the two cuts should have left a narrow clip').toBeDefined()
  expect(sliver!.r).toBe(2)
  const wide = widths.find((c) => c.w >= 16)
  expect(wide!.r).toBe(4)
})
