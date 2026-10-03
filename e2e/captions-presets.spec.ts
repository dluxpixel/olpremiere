// Caption/text presets: bulk outline, apply a caption style to a selection, the
// Captions tab style picker, and the timeline label mirroring lowercase (B3).

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

  // Built-in caption style "Yellow punch" (id builtin-yellow-pop) = UPPERCASE + fat outline.
  await page.getByTestId('multi-preset-apply').selectOption('builtin-yellow-pop')
  await expect.poll(async () => (await titles(page)).every((x) => x.textCase === 'upper')).toBe(true)
  expect((await titles(page)).every((x) => (x.outline?.widthPx ?? 0) > 0)).toBe(true)
})

// The trap this guards: the house caption style is measured and scales with the
// sequence, but every caption door ALSO passes the remembered style preset, and
// a preset's values are absolute and win. So a preset chosen as the default can
// silently undo the measurement, and no unit test on the style function would
// ever see it. This drives the same call the dialog and the right-click make.
test('a fresh caption run lands the MEASURED house style, with no preset over it', async ({ page }) => {
  await page.goto('/')
  const def = await page.evaluate(async () => {
    const capMod = '/src/state/captionActions.ts'
    const preMod = '/src/state/captionStyles.ts'
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { addCaptionsFromWords } = (await import(/* @vite-ignore */ capMod)) as {
      addCaptionsFromWords: (w: unknown[], o: Record<string, unknown>) => void
    }
    const { defaultCaptionStyle } = (await import(/* @vite-ignore */ preMod)) as {
      defaultCaptionStyle: () => unknown
    }
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { height: number; tracks: { clips: { title?: unknown }[] }[] }
    }
    addCaptionsFromWords([{ text: 'TNT', startS: 0, endS: 0.4 }], { style: defaultCaptionStyle() })
    const seq = activeSequence(useStore.getState().project)
    const title = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)?.title
    return { height: seq.height, title } as { height: number; title: Record<string, unknown> }
  })

  expect(def.title.fontFamily).toContain('Montserrat')
  expect(def.title.text).toBe('TNT') // house case keeps an acronym, a preset's blanket lowercase would not
  expect(def.title.vAlign).toBe('middle')
  expect(def.title.offsetYPx).toBe(0) // dead centre, not the old lower third
  expect(def.title.appearance).toBeUndefined() // hard cut
  // Size and outline scale off the sequence, which a preset's absolute px cannot.
  expect(def.title.fontSizePx).toBe(Math.round((105 / 1920) * def.height))
  expect((def.title.outline as { widthPx: number }).widthPx).toBe(Math.round((15 / 1920) * def.height))
})

test('the Captions tab offers the caption style picker', async ({ page }) => {
  await page.goto('/')
  // The Media tab's Captions button still takes him to his captions.
  await page.getByTestId('open-captions').click()
  await expect(page.getByTestId('captions-tab')).toBeVisible()
  await expect(page.getByTestId('captions-default-style')).toBeVisible()
  // The measured house style is the default, and the others are there.
  await expect(page.getByTestId('captions-default-style')).toHaveValue('house')
  const opts = await page.getByTestId('captions-default-style').locator('option').allTextContents()
  expect(opts).toEqual(expect.arrayContaining(['House style', 'Yellow punch', 'Subtitles']))
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
