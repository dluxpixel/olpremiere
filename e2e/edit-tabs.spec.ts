import { expect, test, type Page } from '@playwright/test'

// Edit tabs. His words, 2026-10-03: *"make it so I can copy things from edit to
// edit like if im editing something different ... make it so it has to load when
// I click each one"*. He picked tabs across the top, only the one he is on loaded.
//
// Driven the way he would: three edits opened as tabs, an edit made in one, a copy
// carried across a switch and pasted with its media, the undo of each tab still
// its own, a tab closed and opened again, and a restart that comes back to the
// same tabs.

const tabs = (page: Page) => page.getByTestId('edit-tab')
const tab = (page: Page, name: string) => page.locator(`[data-testid="edit-tab"][data-name="${name}"]`)
const openTab = (page: Page) => page.locator('[data-testid="edit-tab"][data-open="true"]')
const clips = (page: Page) => page.locator('[data-clip-kind]')

async function names(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-name') ?? ''))
}

async function rename(page: Page, name: string): Promise<void> {
  const field = page.getByTestId('project-name')
  await field.fill(name)
  await field.press('Enter')
  await expect(openTab(page)).toHaveAttribute('data-name', name)
}

/** A new edit from the strip's own + button, named. */
async function newEdit(page: Page, name: string): Promise<void> {
  await page.getByTestId('edit-tabs-add').click()
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
  await rename(page, name)
}

/** Click a tab and wait for its edit to be the one on screen. */
async function switchTo(page: Page, name: string): Promise<void> {
  await tab(page, name).click()
  await expect(openTab(page)).toHaveAttribute('data-name', name)
  await expect(page.getByTestId('project-name')).toHaveValue(name)
}

test('three edits as tabs: copy across, undo per tab, close, reopen, restart', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await expect(tabs(page)).toHaveCount(1)

  // Green: his footage as a linked pair, and a title over it.
  await rename(page, 'Green')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.keyboard.press('t')
  await expect(clips(page)).toHaveCount(3)

  await newEdit(page, 'mc night')
  await newEdit(page, 'BC')
  await expect.poll(() => names(page)).toEqual(['Green', 'mc night', 'BC'])
  // Only the open one is loaded: BC has none of Green's clips or media.
  await expect(clips(page)).toHaveCount(0)
  await expect(page.getByTestId('asset-card')).toHaveCount(0)

  // Copy all of Green, carry it to mc night, paste.
  await switchTo(page, 'Green')
  await expect(clips(page)).toHaveCount(3)
  await page.locator('[data-clip-kind="video"]').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await switchTo(page, 'mc night')
  await expect(clips(page)).toHaveCount(0)
  await page.keyboard.press('Control+v')
  await expect(clips(page)).toHaveCount(3)
  // The media came with the clips: the bin has the footage, nothing reads missing.
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)

  // An edit in mc night, then straight to BC before the autosave could run.
  await page.keyboard.press('m')
  await expect(page.getByTestId('marker')).toHaveCount(1)
  await switchTo(page, 'BC')
  await expect(page.getByTestId('marker')).toHaveCount(0)

  // Back to mc night: the marker was saved on the way out, and its own undo
  // history came back with it, newest first.
  await switchTo(page, 'mc night')
  await expect(page.getByTestId('marker')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('marker')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(clips(page)).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(clips(page)).toHaveCount(3)
  await expect(page.getByTestId('marker')).toHaveCount(1)

  // Close the open tab: it saves, and the tab to its right comes up.
  await openTab(page).getByTestId('edit-tab-close').click()
  await expect.poll(() => names(page)).toEqual(['Green', 'BC'])
  await expect(openTab(page)).toHaveAttribute('data-name', 'BC')

  // Open it again from Projects: a tab again, everything in it.
  await page.getByTestId('open-projects').click()
  await page.locator('[data-testid="project-row"]', { hasText: 'mc night' }).getByTestId('project-open').click()
  await expect(openTab(page)).toHaveAttribute('data-name', 'mc night')
  await expect.poll(() => names(page)).toEqual(['Green', 'BC', 'mc night'])
  await expect(clips(page)).toHaveCount(3)
  await expect(page.getByTestId('marker')).toHaveCount(1)

  // Opening an edit that already has a tab focuses that tab.
  await page.getByTestId('open-projects').click()
  await page.locator('[data-testid="project-row"]', { hasText: 'Green' }).getByTestId('project-open').click()
  await expect.poll(() => names(page)).toEqual(['Green', 'BC', 'mc night'])
  await expect(openTab(page)).toHaveAttribute('data-name', 'Green')

  // A restart comes back to the same tabs, on the one he was on.
  await page.reload()
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await expect.poll(() => names(page)).toEqual(['Green', 'BC', 'mc night'])
  await expect(openTab(page)).toHaveAttribute('data-name', 'Green')
  await expect(clips(page)).toHaveCount(3)

  // The middle button closes a tab, like every other tab he uses.
  await tab(page, 'BC').click({ button: 'middle' })
  await expect.poll(() => names(page)).toEqual(['Green', 'mc night'])
  await expect(openTab(page)).toHaveAttribute('data-name', 'Green')
})

test('the open tab shows a dot while its edit is not saved yet, and the last tab cannot close', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  // One tab: nothing to close it into.
  await expect(page.getByTestId('edit-tab-close')).toHaveCount(0)
  await page.keyboard.press('m')
  await expect(openTab(page).getByTestId('edit-tab-unsaved')).toBeVisible()
  await expect(openTab(page).getByTestId('edit-tab-unsaved')).toHaveCount(0, { timeout: 10_000 })
})
