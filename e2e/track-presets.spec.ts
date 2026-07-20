// Named track presets: save the current track setup under a name, then PICK
// it later to reshape the tracks (the bookmark button is a menu, not a single
// anonymous save slot).

import { expect, test, type Page } from '@playwright/test'

/** The active sequence's tracks, straight from the store. */
async function tracks(page: Page) {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; name: string; volumeDb: number }[] }
    }
    return activeSequence(useStore.getState().project).tracks.map((t) => ({
      kind: t.kind,
      name: t.name,
      volumeDb: t.volumeDb,
    }))
  })
}

test('save the track setup as a named preset, then pick it to reshape the tracks', async ({
  page,
}) => {
  await page.goto('/')
  const before = await tracks(page)
  expect(before.length).toBeGreaterThan(0)

  // Name it via the prompt the menu uses.
  page.once('dialog', (d) => void d.accept('Interview'))
  await page.getByTestId('save-track-template').click()
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /save current/i }).click()

  // The saved preset now appears BY NAME in the menu.
  await page.getByTestId('save-track-template').click()
  const menu = page.getByTestId('context-menu')
  await expect(menu.getByRole('menuitem', { name: /Interview/ }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // Change the layout, then apply the preset to put it back.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const timelineMod = '/src/engine/timeline.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { addTrack } = (await import(/* @vite-ignore */ timelineMod)) as {
      addTrack: (s: unknown, kind: 'video' | 'audio') => unknown
    }
    updateActiveSequence('test: add track', (sq) => addTrack(sq, 'audio'))
  })
  expect((await tracks(page)).length).toBe(before.length + 1)

  await page.getByTestId('save-track-template').click()
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /Interview/ }).first().click()
  expect(await tracks(page)).toEqual(before)
})

test('the preset survives a reload and is offered again', async ({ page }) => {
  await page.goto('/')
  page.once('dialog', (d) => void d.accept('Voiceover'))
  await page.getByTestId('save-track-template').click()
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /save current/i }).click()

  await page.reload()
  await page.getByTestId('save-track-template').click()
  await expect(
    page.getByTestId('context-menu').getByRole('menuitem', { name: /Voiceover/ }).first(),
  ).toBeVisible()
})
