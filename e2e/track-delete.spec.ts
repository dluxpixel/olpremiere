// Right-click a track header to delete the track. His ask, 2026-07-29:
// "when you right-click these audio and video tracks, you can right-click to
// delete them".
//
// The unit tests cover the rules; this covers the thing that cannot be unit
// tested and is the whole point of the feature: that the RIGHT-CLICK on the
// header actually opens a menu with a delete in it, and that clicking it works.

import { expect, test, type Page } from '@playwright/test'
import { parkModules, type ParkedWindow } from './storeWrites'

async function addTracks(page: Page, n: number): Promise<void> {
  await parkModules(page, ['/src/state/store.ts', '/src/engine/timeline.ts'])
  await page.evaluate((count) => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const storeMod = '/src/state/store.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { updateActiveSequence } = mods[storeMod] as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { addTrack } = mods[tlMod] as {
      addTrack: (seq: unknown, kind: 'video' | 'audio') => unknown
    }
    for (let i = 0; i < count; i++) updateActiveSequence('add v', (s) => addTrack(s, 'video'))
  }, n)
}

async function trackNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { name: string }[] }
    }
    return activeSequence(useStore.getState().project).tracks.map((t) => t.name)
  })
}

test('right-clicking a track header offers a delete, and it removes the track', async ({ page }) => {
  await page.goto('/')
  await addTracks(page, 2)
  const before = await trackNames(page)
  const doomed = before.find((n) => n === 'V3') ?? before[before.length - 1]

  await page.getByTestId(`track-header-${doomed}`).click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()

  const item = menu.getByRole('menuitem', { name: new RegExp(`Delete ${doomed}`) })
  await expect(item).toBeVisible()
  await item.click()

  await expect.poll(async () => (await trackNames(page)).includes(doomed)).toBe(false)
  expect(await trackNames(page)).toHaveLength(before.length - 1)
})

test('the delete refuses the last video track rather than leaving nowhere to drop a clip', async ({ page }) => {
  await page.goto('/')
  // Whatever the starting layout is, delete video tracks until one is left.
  await parkModules(page, ['/src/state/store.ts', '/src/engine/types.ts', '/src/state/trackEdits.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const teMod = '/src/state/trackEdits.ts'
    const { useStore } = mods[storeMod] as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence, videoTracks } = mods[typesMod] as {
      activeSequence: (p: unknown) => unknown
      videoTracks: (s: unknown) => { id: string }[]
    }
    const { deleteTrack } = mods[teMod] as { deleteTrack: (id: string) => void }
    const vids = () => videoTracks(activeSequence(useStore.getState().project))
    while (vids().length > 1) deleteTrack(vids()[vids().length - 1].id)
  })

  const last = (await trackNames(page)).find((n) => n.startsWith('V'))!
  await page.getByTestId(`track-header-${last}`).click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: new RegExp(`Delete ${last}`) }).click()

  // Still there, and the app said why rather than silently doing nothing.
  expect(await trackNames(page)).toContain(last)
  await expect(page.getByText(/Cannot delete the last video track/i)).toBeVisible()
})
