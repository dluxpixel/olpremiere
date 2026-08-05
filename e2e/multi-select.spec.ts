// Multi-select bulk editing: Ctrl+drag rubber-band selects several clips, and
// the Inspector then edits boldness / effects across the WHOLE selection in one
// undo step. Covers the exact flow David asked for.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const VERIFY = '_verify/multi-select'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

/** Add a title via the toolbar button; returns the new clip's id. */
async function addTitle(page: Page): Promise<string> {
  const before = await titleIds(page)
  await page.getByTestId('add-title').click()
  await expect.poll(async () => (await titleIds(page)).length).toBe(before.length + 1)
  const after = await titleIds(page)
  return after.find((id) => !before.includes(id))!
}

async function titleIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; title?: unknown }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).filter((c) => c.title).map((c) => c.id)
  })
}

async function selection(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection
  })
}

async function setSelection(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (sel) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ selection: sel })
  }, ids)
}

async function boldFlags(page: Page): Promise<boolean[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: { bold: boolean } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).filter((c) => c.title).map((c) => c.title!.bold)
  })
}

test('Ctrl+drag rubber-band selects multiple clips', async ({ page }) => {
  await page.goto('/')
  await addTitle(page)
  await addTitle(page)
  expect((await titleIds(page)).length).toBe(2)

  // Clear selection, then Ctrl+drag a box from the blank area below the tracks
  // up over both clips. Starting on empty background (not a clip) is what arms
  // the marquee instead of a clip move.
  await setSelection(page, [])
  const lanesEl = page.getByTestId('timeline-lanes')
  await lanesEl.hover()
  const lanes = await lanesEl.boundingBox()
  const c0 = await page.getByTestId('clip').first().boundingBox()
  if (!lanes || !c0) throw new Error('no timeline geometry')
  // The lanes BOX spans the 10px scrollbar band, and a press landing on that band is
  // rejected in SILENCE (src/components/scrollbarGuard.ts). clientHeight stops at the
  // content area, so this aims 12px clear of the band instead of 2px.
  const contentH = await lanesEl.evaluate((el) => el.clientHeight)

  const startX = lanes.x + 20
  const startY = lanes.y + contentH - 12 // blank area beneath the tracks
  const endX = c0.x + 340 // covers both 5s title clips (≈300px each at 60px/s)
  const endY = c0.y + 4

  await page.keyboard.down('Control')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 })
  await page.mouse.move(endX, endY, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Control')

  await expect.poll(async () => (await selection(page)).length).toBe(2)
})

test('right-drag box-selects clips and does NOT open a context menu', async ({ page }) => {
  await page.goto('/')
  await addTitle(page)
  await addTitle(page)
  await setSelection(page, [])

  const lanesEl = page.getByTestId('timeline-lanes')
  await lanesEl.hover()
  const lanes = await lanesEl.boundingBox()
  const c0 = await page.getByTestId('clip').first().boundingBox()
  if (!lanes || !c0) throw new Error('no timeline geometry')
  // clientHeight excludes the 10px scrollbar band that scrollbarGuard.ts rejects in
  // silence, so measuring off it keeps the press 12px clear instead of 2px.
  const contentH = await lanesEl.evaluate((el) => el.clientHeight)
  const startX = lanes.x + 20
  const startY = lanes.y + contentH - 12
  const endX = c0.x + 340
  const endY = c0.y + 4

  await page.mouse.move(startX, startY)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 })
  await page.mouse.move(endX, endY, { steps: 8 })
  await page.mouse.up({ button: 'right' })

  await expect.poll(async () => (await selection(page)).length).toBe(2)
  // The contextmenu that fires on right-release must have been swallowed.
  const menuOpen = await page.evaluate(async () => {
    const cmMod = '/src/state/contextMenu.ts'
    const { useContextMenu } = (await import(/* @vite-ignore */ cmMod)) as {
      useContextMenu: { getState: () => { open: boolean } }
    }
    return useContextMenu.getState().open
  })
  expect(menuOpen).toBe(false)
})

test('multi-select Inspector edits boldness across the whole selection', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  const b = await addTitle(page)
  await setSelection(page, [a, b])

  // The bulk panel replaces the single-clip Inspector.
  await expect(page.getByTestId('multi-inspector')).toBeVisible()
  await expect(page.getByTestId('panel-right')).toContainText('2 clips selected')

  // Titles ship bold; the bulk toggle turns bold OFF on both at once.
  expect(await boldFlags(page)).toEqual([true, true])
  await page.getByTestId('multi-bold').click()
  expect(await boldFlags(page)).toEqual([false, false])

  // One undo reverts BOTH → proves a single command, not two.
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  expect(await boldFlags(page)).toEqual([true, true])

  await page.getByTestId('panel-right').screenshot({ path: `${VERIFY}/bulk-panel.png` })
})

test('Versatile Bold is offered in the font picker', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  await setSelection(page, [a])
  // Single-clip title controls expose the family dropdown.
  const families = await page
    .getByLabel('Font family')
    .locator('option')
    .allTextContents()
  expect(families).toContain('Versatile Bold')
})
