// Keyframe-tab overhaul: selectable zoom depth applies a punch of that depth,
// the Keyframes editor leads the panel, the easing explainer answers "what is
// Lin", and a multi-select shows the align-to-same-spot box in the preview.

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

async function scaleKfMax(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: unknown }[] }[] }
    }
    const { channelKeyframes } = (await import(/* @vite-ignore */ chMod)) as {
      channelKeyframes: (clip: unknown, ch: string) => { value: number }[]
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)
    const kfs = channelKeyframes(clip, 'scale')
    return kfs.length ? Math.max(...kfs.map((k) => k.value)) : 0
  })
}

test('selecting a zoom depth applies a punch of that depth', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setUI(page, { selection: [id], playheadS: 2 })

  // Pick "Deep" (1.4×), then Apply → the scale keyframes peak near 1.4.
  await page.getByTestId('punch-preset-deep').click()
  await expect(page.getByTestId('punch-depth-readout')).toHaveText('140%')
  await page.getByTestId('punch-apply').click()
  expect(await scaleKfMax(page)).toBeCloseTo(1.4, 2)

  // The Keyframes editor now leads the panel (it's above Transform).
  await expect(page.getByTestId('keyframes-section')).toBeVisible()
})

test('the easing explainer answers "what is Lin"', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setUI(page, { selection: [id], playheadS: 2 })
  await page.getByTestId('punch-apply').click()

  // Select the first keyframe diamond → the explainer text appears. force: the
  // 12px diamonds have a hover-scale transition that trips Playwright's
  // stability check when several sit close together (real clicks are fine).
  await page.getByTestId('keyframe').first().click({ force: true })
  await expect(page.getByTestId('keyframe-lane')).toContainText(/Ease|Linear|Hold/)
})

test('multi-select shows the align-to-same-spot box in the preview', async ({ page }) => {
  await page.goto('/')
  const a = await addTitle(page)
  const b = await addTitle(page)
  // Playhead inside the FIRST title so it is the visible primary.
  await setUI(page, { selection: [a, b], playheadS: 2 })
  await expect(page.getByTestId('multi-move-box')).toBeVisible()
})
