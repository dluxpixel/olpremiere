// UX batch: repeatable field scrubbing, click-collapses-multi-selection, and
// the editable clip Start timecode. (Roll/slide gestures wire fully-unit-tested
// engine fns; modifier precedence is covered by the existing slip/stretch specs.)

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function importAndAdd(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

async function selectionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection
  })
}

test('drag-scrubbing a numeric field works twice in a row (was one-shot)', async ({ page }) => {
  await importAndAdd(page)
  await page.locator('[data-clip-kind="video"]').click()
  const field = page.getByTestId('field-audio-gain')
  await expect(field).toBeVisible()

  const drag = async (dx: number) => {
    // Audio sits below the fold since the effects-first reorder, so the mouse
    // must drag REAL on-screen coordinates, not a clipped bounding box.
    await field.scrollIntoViewIfNeeded()
    const box = (await field.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
  }

  await drag(60)
  const afterFirst = Number(await field.inputValue())
  expect(afterFirst).toBeGreaterThan(0)

  // The regression this guards: the SECOND drag on the same field used to
  // no-op because focus had locked the field into text-edit mode.
  await drag(-120)
  const afterSecond = Number(await field.inputValue())
  expect(afterSecond).toBeLessThan(afterFirst)
})

test('clicking one clip of a multi-selection collapses the selection to it', async ({ page }) => {
  await importAndAdd(page)
  // Split the clip so the timeline has two video clips, then select both.
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } }) // t = 1s @60px/s
  await page.keyboard.press('c')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const ids = seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips.map((c) => c.id))
    useStore.getState().setUI({ selection: ids })
  })
  expect((await selectionIds(page)).length).toBe(2)

  // A plain click (no drag) on the FIRST clip narrows the selection to it.
  const first = page.locator('[data-clip-kind="video"]').first()
  await first.click({ position: { x: 20, y: 10 } })
  const after = await selectionIds(page)
  expect(after.length).toBe(1)
})

test('typing an exact Start time in the Inspector moves the clip', async ({ page }) => {
  await importAndAdd(page)
  await page.locator('[data-clip-kind="video"]').click()
  await page.locator('summary', { hasText: 'Details' }).click()
  await page.getByTestId('clip-start-timecode').click()
  const input = page.getByTestId('clip-start-timecode-input')
  await input.fill('00:00:02:00')
  await input.press('Enter')
  await expect(page.getByTestId('clip-start-timecode')).toContainText('00:00:02:00')
  const startS = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { startS: number }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips)[0].startS
  })
  expect(startS).toBeCloseTo(2, 5)
})
