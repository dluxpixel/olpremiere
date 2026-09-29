// His ask, 2026-09-29: *"when there is an effect on everything (for example,
// when there is auto color on everything), and I right-click and select all the
// clips that have auto color, I can change every single one at the same time."*
// Clicked through the way he would: right-click, "Select all with Auto Color",
// change Amount once in the Inspector, every clip follows, one undo.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function amounts(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { effects: { type: string; params: Record<string, number | { value: number }> }[] }[] }[]
      }
    }
    const out: number[] = []
    for (const t of activeSequence(useStore.getState().project).tracks) {
      for (const c of t.clips) {
        const ac = c.effects.find((e) => e.type === 'autoColor')
        if (!ac) continue
        const v = ac.params.amount
        out.push(typeof v === 'number' ? v : v.value)
      }
    }
    return out
  })
}

test('select every clip with Auto Color, change Amount once, all of them follow, one undo', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  for (let i = 0; i < 3; i++) await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(3)

  // Auto Color on every clip, the way he puts it on everything: select all, add it to all.
  await page.locator('[data-clip-kind="video"]').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByTestId('multi-add-effect').selectOption('autoColor')
  await expect.poll(() => amounts(page)).toEqual([0.6, 0.6, 0.6])

  // Start from ONE clip selected, then right-click it.
  await page.locator('[data-clip-kind="video"]').nth(1).click()
  await page.locator('[data-clip-kind="video"]').nth(1).click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Select all with Auto Color' }).click()

  const card = page.locator('[data-testid="shared-effect"][data-effect-type="autoColor"]')
  await expect(card).toBeVisible()
  const field = card.getByTestId('shared-field-amount')
  await field.dblclick()
  await field.fill('0.25')
  await field.press('Enter')
  await expect.poll(() => amounts(page)).toEqual([0.25, 0.25, 0.25])

  // One undo puts every clip back.
  await page.locator('[data-clip-kind="video"]').first().click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => amounts(page)).toEqual([0.6, 0.6, 0.6])
})
