// The right-click menu on TEXT, after the 2026-07-28 cut.
//
// His words, looking at a caption's menu: "there is an entrance and a transition
// in the text tab. This is a lot of bloat." A caption was being offered
// Transition in, Transition out, Fade in + out, Entrance, Exit AND Animation:
// six rows for one idea, plus Punch in and Motion, which move footage a title
// does not have. And the one thing he actually wanted, saving the look he had
// just built, only appeared when several clips were selected.

import { expect, test, type Page } from '@playwright/test'

async function addTitle(page: Page): Promise<void> {
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip').first()).toBeVisible()
}

/**
 * Top-level menu labels, normalised. The rendered text carries the shortcut and
 * a "▸" for submenus ("CopyCtrl+C", "Entrance▸"), so compare on the label alone.
 */
async function menuLabels(page: Page): Promise<string[]> {
  const items = await page.getByTestId('context-menu').getByRole('menuitem').allTextContents()
  return items.map((t) => t.replace('▸', '').trim())
}
const has = (labels: string[], label: string): boolean => labels.some((l) => l.startsWith(label))

test('a text clip is not offered transitions, motion, or a third way to fade', async ({ page }) => {
  await page.goto('/')
  await addTitle(page)
  await page.getByTestId('clip').first().click({ button: 'right' })
  const labels = await menuLabels(page)

  // Gone: Entrance/Exit already do this, and better.
  expect(has(labels, 'Transition in')).toBe(false)
  expect(has(labels, 'Transition out')).toBe(false)
  // Gone: "Fade in + out" is Entrance ▸ Fade in plus Exit ▸ Fade out, both of
  // which are the first item in the list right beneath it.
  expect(has(labels, 'Fade in + out')).toBe(false)
  // Gone: these move FOOTAGE. A caption has none.
  expect(has(labels, 'Punch in at playhead')).toBe(false)
  expect(has(labels, 'Motion')).toBe(false)

  // Still there: the ones that actually do something to text.
  expect(has(labels, 'Entrance')).toBe(true)
  expect(has(labels, 'Exit')).toBe(true)
  expect(has(labels, 'Animation')).toBe(true)
  expect(has(labels, 'Split into word captions')).toBe(true)
  expect(has(labels, 'Style preset')).toBe(true)
})

test('right-clicking ONE caption can save its look as the caption style', async ({ page }) => {
  await page.goto('/')
  await addTitle(page)
  await page.getByTestId('clip').first().click({ button: 'right' })

  const menu = page.getByTestId('context-menu')
  await menu.getByRole('menuitem', { name: /^Style preset/ }).hover()
  await menu.getByRole('menuitem', { name: /Save as the caption style/ }).click()

  // It is saved AND it is now the style every new caption gets, which is the
  // whole point: "a preset that I can then use on the auto captions".
  const saved = await page.evaluate(async () => {
    const mod = '/src/state/textPresets.ts'
    const { useTextPresets, getCaptionPresetId } = (await import(/* @vite-ignore */ mod)) as {
      useTextPresets: { getState: () => { saved: { id: string; style: Record<string, unknown> }[] } }
      getCaptionPresetId: () => string
    }
    const list = useTextPresets.getState().saved
    return {
      count: list.length,
      currentIsSaved: list.some((p) => p.id === getCaptionPresetId()),
      style: list.at(-1)?.style,
    }
  })
  expect(saved.count).toBe(1)
  expect(saved.currentIsSaved).toBe(true)
  // "It will save location, font, boldness, and stuff like that."
  expect(saved.style).toHaveProperty('fontFamily')
  expect(saved.style).toHaveProperty('fontSizePx')
  expect(saved.style).toHaveProperty('bold')
  expect(saved.style).toHaveProperty('offsetYPx')
})
