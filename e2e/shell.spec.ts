import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const VERIFY_DIR = '_verify/shell'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY_DIR, { recursive: true })
})

test('shell renders the four regions at the design spec', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('topbar')).toBeVisible()
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await expect(page.getByTestId('monitor')).toBeVisible()
  await expect(page.getByTestId('panel-right')).toBeVisible()
  await expect(page.getByTestId('timeline')).toBeVisible()

  const topbar = (await page.getByTestId('topbar').boundingBox())!
  expect(topbar.height).toBe(48)
  const left = (await page.getByTestId('panel-left').boundingBox())!
  expect(left.width).toBe(280)
  const right = (await page.getByTestId('panel-right').boundingBox())!
  expect(right.width).toBe(300)

  await page.screenshot({ path: `${VERIFY_DIR}/app.png` })
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY_DIR}/timeline.png` })
})

test('splitters resize panels and sizes persist across reload', async ({ page }) => {
  await page.goto('/')
  const before = (await page.getByTestId('panel-left').boundingBox())!.width

  // Hover first: that is what buys Playwright's stability and hit-target checks, which raw
  // page.mouse.* skips entirely. Then re-read the box, because hover() can scroll the element
  // into view and a box read before it is exactly the stale box we are trying to avoid.
  const splitterEl = page.getByTestId('splitter-left')
  await splitterEl.hover()
  const splitter = (await splitterEl.boundingBox())!
  const y = splitter.y + splitter.height / 2
  // Press the CENTRE, not splitter.x. That was the element's left edge, a zero pixel margin, the
  // tightest aim in the suite, and a miss here is silent: the drag simply never arms.
  const x = splitter.x + splitter.width / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 80, y, { steps: 8 })
  await page.mouse.up()

  // Give the commit a budget instead of reading once. This asserts a settled end state, not
  // whether the gesture fired, so polling cannot mask a dead drag: a drag that never armed still
  // fails here, it just stops failing for the unrelated reason that we looked too early.
  await expect
    .poll(async () => (await page.getByTestId('panel-left').boundingBox())!.width)
    .toBeGreaterThan(before + 80 - 5)

  // Read the settled width only AFTER the poll has confirmed the drag committed. Reading it
  // before was the second half of the same bug: the persistence check downstream compared against
  // a number that may have been sampled mid-gesture.
  const after = (await page.getByTestId('panel-left').boundingBox())!.width

  await page.reload()
  const persisted = (await page.getByTestId('panel-left').boundingBox())!.width
  expect(Math.abs(persisted - after)).toBeLessThan(3)
  await page.screenshot({ path: `${VERIFY_DIR}/resized.png` })
})

test('project rename is undoable and autosaves to IndexedDB', async ({ page }) => {
  await page.goto('/')
  const name = page.getByTestId('project-name')
  await expect(name).toHaveValue('Untitled Project')

  await name.fill('My First Cut')
  await name.press('Enter')
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/, { timeout: 6000 })

  // Undo via keyboard, redo via the top-bar button.
  await page.keyboard.press('Control+z')
  await expect(name).toHaveValue('Untitled Project')
  await page.getByTestId('redo').click()
  await expect(name).toHaveValue('My First Cut')

  // Autosave the redone state, then confirm it survives a reload.
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/, { timeout: 6000 })
  await page.reload()
  await expect(page.getByTestId('project-name')).toHaveValue('My First Cut')
})

test('ruler scrub moves the playhead and updates the timecode', async ({ page }) => {
  await page.goto('/')
  // Default zoom is 60 px/s → x=300 is t=5s.
  await page.getByTestId('ruler').click({ position: { x: 300, y: 10 } })
  await expect(page.getByTestId('timecode')).toContainText('00:00:05:00')

  const playhead = (await page.getByTestId('playhead').boundingBox())!
  const lanes = (await page.getByTestId('timeline-lanes').boundingBox())!
  expect(Math.abs(playhead.x - (lanes.x + 300))).toBeLessThan(2)
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY_DIR}/playhead.png` })
})

test('keyboard: snapping toggle, tools, zoom', async ({ page }) => {
  await page.goto('/')
  const snap = page.getByTestId('snap-toggle')
  await expect(snap).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('s')
  await expect(snap).not.toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('s')
  await expect(snap).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('b')
  await expect(page.getByRole('button', { name: 'Razor (blade) tool' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('v')
  await expect(page.getByRole('button', { name: 'Selection tool' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Zoom is ANCHORED on the playhead: '=' raises px/s while the playhead's
  // screen position holds still (the old behavior drifted the view toward 0).
  await page.getByTestId('ruler').click({ position: { x: 300, y: 10 } })
  const zoom = page.locator('[aria-label="Timeline zoom"]')
  const zBefore = Number(await zoom.inputValue())
  const before = (await page.getByTestId('playhead').boundingBox())!.x
  await page.keyboard.press('=')
  expect(Number(await zoom.inputValue())).toBeGreaterThan(zBefore)
  const after = (await page.getByTestId('playhead').boundingBox())!.x
  expect(Math.abs(after - before)).toBeLessThan(2)
})
