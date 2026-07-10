// The global Library: media and effect presets that survive reloads and outlive
// any project. Copy-on-save / copy-on-use: deleting on either side never holes
// the other.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function importClip(page: Page): Promise<void> {
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

/**
 * Flush the debounced project autosave before a reload. Library writes commit
 * immediately, but the PROJECT is saved on a debounce — reloading faster than
 * the debounce would revert the bin and make the test flake.
 */
async function flushProjectSave(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = '/src/state/persistence.ts'
    const { saveNow } = (await import(/* @vite-ignore */ mod)) as { saveNow: () => Promise<void> }
    await saveNow()
  })
}

async function saveFirstAssetToLibrary(page: Page): Promise<void> {
  await page.getByTestId('asset-card').first().click({ button: 'right' })
  await page.getByText('Save to Library').click()
  await expect(page.getByText(/Saved .* to Library/)).toBeVisible()
}

async function selectFirstVideoClip(page: Page): Promise<string> {
  await page.getByTestId('asset-card').first().dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.find((t) => t.kind === 'video')!.clips[0].id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
}

test('media saved to the Library survives a reload AND deletion from the bin', async ({ page }) => {
  await page.goto('/')
  await importClip(page)
  await saveFirstAssetToLibrary(page)

  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)

  // THE point of the feature: a full reload, then it is still there.
  await flushProjectSave(page)
  await page.reload()
  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)

  // Delete the original from the bin; the Library copy must not care.
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByTestId('asset-card').first().click({ button: 'right' })
  await page.getByText('Delete from bin').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('library-card')).toHaveCount(1)

  // Copy-on-use: bring it back into the project and put it on the timeline.
  await page.getByTestId('library-card').dblclick()
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('removing a Library item leaves a project that used it intact', async ({ page }) => {
  await page.goto('/')
  await importClip(page)
  await saveFirstAssetToLibrary(page)
  // Use the library copy in the project first.
  await page.getByRole('tab', { name: 'Library' }).click()
  await page.getByTestId('library-card').dblclick()
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByTestId('asset-card')).toHaveCount(2) // original + from-library

  await page.getByRole('tab', { name: 'Library' }).click()
  await page.getByTestId('library-card').click({ button: 'right' })
  await page.getByText('Remove from Library').click()
  await expect(page.getByTestId('library-empty')).toBeVisible()

  // The project's copy still works: both bin entries survive with usable media.
  await page.getByRole('tab', { name: 'Media' }).click()
  await expect(page.getByTestId('asset-card')).toHaveCount(2)
  await page.getByTestId('asset-card').nth(1).dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('an effect preset saves, survives a reload, and applies to another clip', async ({ page }) => {
  await page.goto('/')
  await importClip(page)
  await selectFirstVideoClip(page)

  // Grade the clip via the Effects browser, then save the stack as a preset.
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="saturation"]').dblclick()
  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  await page.getByTestId('field-saturation').dblclick()
  await page.getByTestId('field-saturation').fill('-1')
  await page.getByTestId('field-saturation').press('Enter')
  await page.getByTestId('save-preset').click()
  await expect(page.getByText(/Saved preset/)).toBeVisible()

  // Reload: the preset must still exist without the project's help.
  await flushProjectSave(page)
  await page.reload()
  await page.getByRole('tab', { name: 'Library' }).click()
  await expect(page.getByTestId('preset-item')).toHaveCount(1)

  // Apply it to a SECOND clip and verify the stack (with the saved value).
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByTestId('asset-card').dblclick() // second clip
  const target = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string; effects: unknown[] }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const clips = seq.tracks.find((t) => t.kind === 'video')!.clips
    const fresh = clips.find((c) => c.effects.length === 0)!
    useStore.getState().setUI({ selection: [fresh.id] })
    return fresh.id
  })

  await page.getByRole('tab', { name: 'Library' }).click()
  await page.getByTestId('preset-item').dblclick()

  const applied = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; effects: { type: string; params: Record<string, unknown> }[] }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
    return clip.effects.map((e) => ({ type: e.type, saturation: e.params.saturation }))
  }, target)

  expect(applied).toEqual([{ type: 'saturation', saturation: -1 }])

  // And applying is one undo step.
  await page.keyboard.press('Control+z')
  const undone = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; effects: unknown[] }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.effects.length
  }, target)
  expect(undone).toBe(0)
})
