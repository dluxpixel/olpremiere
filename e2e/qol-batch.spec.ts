// QoL batch verification: caps toggle (fix Whisper ALL-CAPS), arrow-key nudge on
// numeric fields, per-section channel reset, and delete-keyframe in the lane.

import { expect, test, type Page } from '@playwright/test'

async function addTitle(page: Page): Promise<string> {
  const before = await titleIds(page)
  await page.getByTestId('add-title').click()
  await expect.poll(async () => (await titleIds(page)).length).toBe(before.length + 1)
  return (await titleIds(page)).find((id) => !before.includes(id))!
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

async function setSelection(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (sel) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ selection: sel })
  }, ids)
}

async function firstTitle(page: Page): Promise<{ textCase?: string; fontSizePx: number }> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: { textCase?: string; fontSizePx: number } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.title)!.title!
  })
}

test('bulk lowercase fixes Whisper ALL-CAPS across the selection', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  const b = await addTitle(page)
  await setSelection(page, [a, b])

  await page.getByTestId('multi-case-lower').click()
  const cases = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: { textCase?: string } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).filter((c) => c.title).map((c) => c.title!.textCase)
  })
  expect(cases).toEqual(['lower', 'lower'])
})

test('single title has UPPER/lower toggles', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setSelection(page, [id])
  await page.getByTestId('title-case-upper').click()
  expect((await firstTitle(page)).textCase).toBe('upper')
  // Clicking the active one again clears it (back to as-typed).
  await page.getByTestId('title-case-upper').click()
  expect((await firstTitle(page)).textCase).toBeUndefined()
})

test('Arrow keys nudge a focused numeric field', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setSelection(page, [id])
  const before = (await firstTitle(page)).fontSizePx
  const field = page.getByTestId('title-fontsize')
  await field.click()
  await page.keyboard.press('ArrowUp')
  expect((await firstTitle(page)).fontSizePx).toBe(before + 1)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  expect((await firstTitle(page)).fontSizePx).toBe(before - 1)
})

test('per-section reset button clears Transform channels', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setSelection(page, [id])
  // Push scale off default via the store helper.
  await page.evaluate(async (clipId) => {
    const ceMod = '/src/state/clipEdits.ts'
    const ce = (await import(/* @vite-ignore */ ceMod)) as { setChannel: (id: string, ch: string, v: number) => void }
    ce.setChannel(clipId, 'scale', 2.5)
  }, id)
  const scaleOf = async () =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { clips: { transform: { scale: number } }[] }[] }
      }
      const seq = activeSequence(useStore.getState().project)
      return seq.tracks.flatMap((t) => t.clips)[0].transform.scale
    })
  expect(await scaleOf()).toBeCloseTo(2.5, 3)
  await page.getByTestId('reset-section-transform').click()
  expect(await scaleOf()).toBeCloseTo(1, 3)
})
