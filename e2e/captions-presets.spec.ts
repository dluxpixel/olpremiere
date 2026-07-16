// Caption/text presets: bulk outline, apply a style preset to a selection, the
// Captions-dialog style picker, and the timeline label mirroring lowercase (B3).

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

async function setUI(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (x: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

async function titles(page: Page): Promise<{ textCase?: string; outline?: { widthPx: number } }[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: { textCase?: string; outline?: { widthPx: number } } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).filter((c) => c.title).map((c) => c.title!)
  })
}

test('bulk outline toggle sets an outline on every selected caption', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  const b = await addTitle(page)
  await setUI(page, { selection: [a, b] })

  await page.getByTestId('multi-outline-toggle').check()
  const t = await titles(page)
  expect(t.every((x) => !!x.outline)).toBe(true)
})

test('applying a style preset styles the whole selection', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  const b = await addTitle(page)
  await setUI(page, { selection: [a, b] })

  // Built-in "Jettism caption" (id builtin-jettism) = lowercase + fat outline.
  await page.getByTestId('multi-preset-apply').selectOption('builtin-jettism')
  await expect.poll(async () => (await titles(page)).every((x) => x.textCase === 'lower')).toBe(true)
  expect((await titles(page)).every((x) => (x.outline?.widthPx ?? 0) > 0)).toBe(true)
})

test('the Captions dialog offers a style-preset picker', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('open-captions').click()
  await expect(page.getByTestId('captions-dialog')).toBeVisible()
  await expect(page.getByTestId('captions-preset')).toBeVisible()
  // The Jettism house style is an option.
  const opts = await page.getByTestId('captions-preset').locator('option').allTextContents()
  expect(opts).toContain('Jettism caption')
})

test('lowercase toggle is mirrored in the timeline clip label (B3)', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  // Give it distinctive UPPERCASE text.
  await page.evaluate(async (clipId) => {
    const taMod = '/src/state/titleActions.ts'
    const { updateTitle } = (await import(/* @vite-ignore */ taMod)) as {
      updateTitle: (id: string, patch: Record<string, unknown>) => void
    }
    updateTitle(clipId, { text: 'HELLO' })
  }, id)
  await setUI(page, { selection: [id] })
  await page.getByTestId('title-case-lower').click()
  // The timeline chip label now reads lowercase.
  await expect(page.getByTestId('clip')).toContainText('hello')
})
