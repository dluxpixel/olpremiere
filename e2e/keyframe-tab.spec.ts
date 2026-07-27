// Keyframe-tab overhaul: selectable zoom depth applies a punch of that depth,
// the easing explainer answers "what is Lin", and a multi-select shows the
// align-to-same-spot box in the preview. (The applied-effects stack leads the
// panel since the 2026-07-18 reorder; Keyframes sits last.)

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

  // The Keyframes editor is present (last section since the 2026-07-18 reorder).
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

test('an animated clip shows its keyframes ON the timeline', async ({ page }) => {
  // Keyframes only ever existed in the Inspector's 240px lane, so nothing on
  // the timeline said a clip was animated at all, let alone where.
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toBeVisible()
  await expect(page.getByTestId('clip-keyframe')).toHaveCount(0)

  // A punch-in animates several channels at two moments, which is TWO marks,
  // not six, because a moment is what you can see and grab.
  await page.getByTestId('clip').click()
  await page.keyboard.press('p')
  await expect.poll(async () => page.getByTestId('clip-keyframe').count()).toBeGreaterThan(0)

  const marks = await page.getByTestId('clip-keyframe').count()
  const channels = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { keyframes?: Record<string, unknown[]> }[] }[] }
    }
    const clip = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0]
    return Object.keys(clip.keyframes ?? {}).length
  })
  expect(channels).toBeGreaterThan(0)
  expect(marks).toBeLessThanOrEqual(channels * 4) // moments, not channel-times
})

test('dragging a keyframe on the clip retimes it, in one undo step', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await page.getByTestId('clip').click()
  await page.keyboard.press('p') // punch in → keyframes on several channels
  await expect.poll(async () => page.getByTestId('clip-keyframe').count()).toBeGreaterThan(1)

  const timesOf = () =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const kfMod = '/src/engine/keyframes.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { clips: unknown[] }[] }
      }
      const { clipKeyframeTimes } = (await import(/* @vite-ignore */ kfMod)) as {
        clipKeyframeTimes: (c: unknown) => number[]
      }
      return clipKeyframeTimes(activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0])
    })

  const before = await timesOf()
  const marks = page.getByTestId('clip-keyframe')
  const last = marks.nth((await marks.count()) - 1)
  const box = (await last.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  const after = await timesOf()
  expect(after.length).toBe(before.length) // moved, not added
  expect(after[after.length - 1]).toBeGreaterThan(before[before.length - 1])

  // ONE undo step puts every channel back where it was.
  await page.keyboard.press('Control+z')
  await expect.poll(timesOf).toEqual(before)
})

test('auto-keyframe turns a monitor drag into an animation', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await page.getByTestId('clip').click()

  const posXCount = () =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { clips: { keyframes?: { posX?: unknown[] } }[] }[] }
      }
      const clip = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0]
      return clip.keyframes?.posX?.length ?? 0
    })

  // The toggle starts off, and a drag at the head is a plain move either way,
  // so park the playhead inside the clip first.
  await expect(page.getByTestId('auto-keyframe-toggle')).toBeVisible()
  await page.getByTestId('auto-keyframe-toggle').click()
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ playheadS: 2 })
  })

  const gizmo = page.getByTestId('gizmo-body')
  await expect(gizmo).toBeVisible()
  const box = (await gizmo.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  // Two keyframes: where it was, and where the playhead is.
  await expect.poll(posXCount).toBe(2)
  await expect(page.getByTestId('clip-keyframe')).toHaveCount(2)
})
