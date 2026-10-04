// An effect on several selected pictures lands on ALL of them, by every door. His
// words, 2026-10-04: *"selecting multiple images and putting effects on them that
// actually apply to all of them."*
//
// Three pasted-style PNGs on the timeline, all selected, and each door he has:
// double click in the Effects tab, a drag from the Effects tab onto ONE of them,
// the Inspector's Add effect list, the right-click menu, Paste attributes and a
// Library preset. Each one must reach all three, say how many, and undo in one
// step. The unit tests prove the rules; this proves the doors are wired to them.

import { expect, test, type Page } from '@playwright/test'

const EFFECT_MIME = 'application/x-olpremiere-effect'

/** Import three small PNGs and put each on the timeline, the way a double click in the bin does. */
async function openWithThreePictures(page: Page): Promise<void> {
  await page.goto('/')
  const files: { name: string; mimeType: string; buffer: Buffer }[] = []
  for (const [i, color] of ['#e03030', '#30a030', '#3050e0'].entries()) {
    const bytes = await page.evaluate(async (fill) => {
      const canvas = document.createElement('canvas')
      canvas.width = 96
      canvas.height = 72
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, 96, 72)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, color)
    files.push({ name: `shot ${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(bytes) })
  }
  await page.getByTestId('media-file-input').setInputFiles(files)
  await expect(page.getByTestId('asset-card')).toHaveCount(3, { timeout: 15_000 })
  for (let i = 0; i < 3; i++) await page.getByTestId('asset-card').nth(i).dblclick()
  await expect(page.locator('[data-testid="clip"]')).toHaveCount(3)
  await page.getByRole('tab', { name: 'Effects' }).click()
  await expect(page.getByTestId('effect-item').first()).toBeVisible()
  await selectAll(page)
}

async function selectAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const ids = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips.map((c) => c.id))
    useStore.getState().setUI({ selection: ids })
  })
}

async function select(page: Page, indexes: number[]): Promise<void> {
  await page.evaluate(async (picks) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const ids = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips.map((c) => c.id))
    useStore.getState().setUI({ selection: picks.map((i) => ids[i]) })
  }, indexes)
}

/** The effect types on each image clip, in timeline order (track, then time). */
async function effectsOnPictures(page: Page): Promise<string[][]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { assets: Record<string, { kind: string }> } } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { assetId: string; effects: { type: string }[] }[] }[] }
    }
    const project = useStore.getState().project
    return activeSequence(project)
      .tracks.flatMap((t) => t.clips)
      .filter((c) => project.assets[c.assetId]?.kind === 'image')
      .map((c) => c.effects.map((e) => e.type))
  })
}

async function selectionSize(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { ui: { selection: string[] } } } }
    return useStore.getState().ui.selection.length
  })
}

const toast = (page: Page, text: string) => page.getByTestId('toast').filter({ hasText: text })

test('double clicking an effect in the Effects tab puts it on all three, says so, and undoes in one step', async ({ page }) => {
  await openWithThreePictures(page)
  await page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]').dblclick()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], ['gaussianBlur'], ['gaussianBlur']])
  await expect(toast(page, 'Added Gaussian Blur to 3 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])
})

test('dragging an effect onto ONE of the three selected pictures puts it on all three and keeps them selected', async ({ page }) => {
  await openWithThreePictures(page)
  // The payload comes out of the Effects row's own dragstart, and is dropped on the middle clip.
  await page.evaluate(
    ({ mime }) => {
      const row = document.querySelector('[data-testid="effect-item"][data-payload="saturation"]')!
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      if (dt.getData(mime) !== 'saturation') throw new Error('the Effects row did not put its effect on the drag')
      const clip = document.querySelectorAll('[data-testid="clip"]')[1]!
      const rect = clip.getBoundingClientRect()
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      clip.dispatchEvent(new DragEvent('dragover', opts))
      clip.dispatchEvent(new DragEvent('drop', opts))
    },
    { mime: EFFECT_MIME },
  )
  await expect.poll(() => effectsOnPictures(page)).toEqual([['saturation'], ['saturation'], ['saturation']])
  expect(await selectionSize(page)).toBe(3)
  await expect(toast(page, 'Added Saturation to 3 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])
})

test('the multi selection Inspector Add effect list puts it on all three in one undo step', async ({ page }) => {
  await openWithThreePictures(page)
  await page.getByTestId('multi-add-effect').selectOption('gaussianBlur')
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], ['gaussianBlur'], ['gaussianBlur']])
  await expect(toast(page, 'Added Gaussian Blur to 3 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])
})

test('the Inspector effect search on a lone picture puts it on that picture and no other', async ({ page }) => {
  await openWithThreePictures(page)
  await select(page, [1])
  await page.getByTestId('inspector-add-effect').click()
  await page.getByTestId('add-effect-search').fill('blur')
  await page.locator('[data-testid="add-effect-row"][data-type="gaussianBlur"]').first().click()
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], ['gaussianBlur'], []])
})

test('right-click Remove green screen keys all three selected pictures in one undo step', async ({ page }) => {
  await openWithThreePictures(page)
  await page.locator('[data-testid="clip"]').nth(1).click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Remove green screen · all 3' }).click()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['chromaKey'], ['chromaKey'], ['chromaKey']])
  await expect(toast(page, 'Added Green Screen to 3 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])
})

test('Paste attributes carries the effect onto both other pictures and counts them', async ({ page }) => {
  await openWithThreePictures(page)
  // A blur on the first picture alone, copied from its menu.
  await select(page, [0])
  await page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]').dblclick()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], [], []])
  await page.locator('[data-testid="clip"]').first().click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Copy attributes' }).click()
  // Then the other two selected, pasted from the menu of one of them.
  await select(page, [1, 2])
  await page.locator('[data-testid="clip"]').nth(1).click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Paste attributes to 2' }).click()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], ['gaussianBlur'], ['gaussianBlur']])
  await expect(toast(page, 'Attributes pasted to 2 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], [], []])
})

test('a Library effect preset double clicked with three pictures selected goes on all three', async ({ page }) => {
  await openWithThreePictures(page)
  await select(page, [0])
  await page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]').dblclick()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], [], []])
  // Save that stack as a preset (its own door in the app), then take it back off the first picture.
  await page.evaluate(async () => {
    const libMod = '/src/state/library.ts'
    const { saveSelectionAsPreset } = (await import(/* @vite-ignore */ libMod)) as { saveSelectionAsPreset: () => Promise<void> }
    await saveSelectionAsPreset()
  })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])

  await selectAll(page)
  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('preset-item').first()).toBeVisible()
  await page.getByTestId('preset-item').first().dblclick()
  await expect.poll(() => effectsOnPictures(page)).toEqual([['gaussianBlur'], ['gaussianBlur'], ['gaussianBlur']])
  await expect(toast(page, 'to 3 clips')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => effectsOnPictures(page)).toEqual([[], [], []])
})
