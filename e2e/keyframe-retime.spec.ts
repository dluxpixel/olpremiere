// Retiming keyframes in the Zoom lane on the Motion Rail: drag a diamond along
// the track, or type an exact time in the Time field. "Set the time this
// happens." The lane is one property's own track under its PropRow now, so it
// answers to keyframe-track; the gesture and everything it proves are unchanged.

import { expect, test, type Page } from '@playwright/test'

async function addTitle(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
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
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.title)!.id
  })
}

/** Seed two scale keyframes (t=1, t=3) on the clip and leave the playhead at 0. */
async function seedScaleKeyframes(page: Page, id: string): Promise<void> {
  await page.evaluate(async (clipId) => {
    const storeMod = '/src/state/store.ts'
    const ceMod = '/src/state/clipEdits.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    const ce = (await import(/* @vite-ignore */ ceMod)) as {
      toggleChannelAnimation: (id: string, ch: string) => void
      addKeyframeAtPlayhead: (id: string, ch: string) => void
    }
    useStore.getState().setUI({ selection: [clipId], playheadS: 1 })
    ce.toggleChannelAnimation(clipId, 'scale')
    useStore.getState().setUI({ playheadS: 3 })
    ce.addKeyframeAtPlayhead(clipId, 'scale')
    useStore.getState().setUI({ playheadS: 0 })
  }, id)
}

/** Set UI state from the browser side. The import path lives INSIDE the callback. */
async function setUI(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (patch: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

async function scaleTimes(page: Page): Promise<number[]> {
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
      channelKeyframes: (clip: unknown, ch: string) => { t: number }[]
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)
    return channelKeyframes(clip, 'scale').map((k) => k.t)
  })
}


/**
 * The lanes, the curve editor and the punch buttons are hand controls now: they
 * fold away under the move shelf's 'Tune it by hand' so the panel opens on ten
 * finished moves instead of on a desk of parameters. Everything below is still
 * exactly one click away, and this is that click.
 */
async function openHandControls(page: Page): Promise<void> {
  const toggle = page.getByTestId('tune-by-hand')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

test('dragging a keyframe diamond retimes it', async ({ page }) => {
  const id = await addTitle(page)
  await seedScaleKeyframes(page, id)
  await openHandControls(page)

  await expect(page.locator('[data-testid="keyframe-track"][data-channel="scale"]')).toBeVisible()
  const diamonds = page.getByTestId('keyframe')
  await expect(diamonds).toHaveCount(2)
  expect(await scaleTimes(page)).toEqual([1, 3])

  // Drag the t=3 diamond toward the t=1 diamond → lands near t≈2. Using both
  // diamond boxes makes the target robust to the track's exact geometry.
  // Hover FIRST, then read the boxes. hover() buys the stability and hit-target
  // checks raw page.mouse.* skips, and it can scroll the lane, which moves both
  // diamonds; a midX measured before it is exactly the stale target we avoid.
  const drag = diamonds.nth(1)
  await drag.hover()
  const d1 = await diamonds.nth(0).boundingBox()
  const d3 = await drag.boundingBox()
  if (!d1 || !d3) throw new Error('no geometry')
  const midX = (d1.x + d1.width / 2 + d3.x + d3.width / 2) / 2
  const y = d3.y + d3.height / 2

  await page.mouse.move(d3.x + d3.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(midX, y, { steps: 10 })
  await page.mouse.up()

  const after = await scaleTimes(page)
  // The first keyframe stays at 1; the second moved earlier (but past the first).
  expect(after[0]).toBe(1)
  expect(after[1]).toBeGreaterThan(1)
  expect(after[1]).toBeLessThan(3)
})

test('typing in the Time field sets an exact keyframe time', async ({ page }) => {
  const id = await addTitle(page)
  await seedScaleKeyframes(page, id)
  await openHandControls(page)

  // Select the second diamond to reveal the Time field.
  await page.getByTestId('keyframe').nth(1).click()
  const field = page.getByTestId('keyframe-time')
  await expect(field).toBeVisible()

  await field.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')

  expect(await scaleTimes(page)).toEqual([1, 2])
})

/**
 * ⛔ HIS SNAPPING SWITCH REACHES THE DIAMONDS NOW, and until 2026-08-17 the motion
 * rail was the only surface in the app that ignored it. The timeline, its toolbar
 * and the monitor overlay all read `ui.snapping`; a dragged diamond got the frame
 * grid and nothing else, on a switch he had already pressed. → D116
 *
 * The pull radius is 8px, the same as the timeline's, so the target below is aimed
 * a few pixels off the playhead: far enough that no frame snap would land on it,
 * close enough to be inside the magnet.
 */
test('a dragged diamond is pulled to the playhead while snapping is on', async ({ page }) => {
  const id = await addTitle(page)
  await seedScaleKeyframes(page, id)
  await openHandControls(page)

  const diamonds = page.getByTestId('keyframe')
  await expect(diamonds).toHaveCount(2)
  expect(await scaleTimes(page)).toEqual([1, 3])

  // Park the playhead at 2s, halfway between the two diamonds.
  await setUI(page, { playheadS: 2 })

  // The rail's own scale, read off the two diamonds: they are exactly 2s apart.
  const drag = diamonds.nth(1)
  await drag.hover()
  const d1 = await diamonds.nth(0).boundingBox()
  const d3 = await drag.boundingBox()
  if (!d1 || !d3) throw new Error('no geometry')
  const x1 = d1.x + d1.width / 2
  const x3 = d3.x + d3.width / 2
  const pxPerS = (x3 - x1) / 2
  const y = d3.y + d3.height / 2
  // 4px past the playhead: inside the 8px magnet, and more than a frame away from
  // it, so a landing exactly on 2 can only be the pull.
  const target = x1 + pxPerS + 4

  await page.mouse.move(x3, y)
  await page.mouse.down()
  await page.mouse.move(target, y, { steps: 10 })
  await page.mouse.up()

  const snapped = await scaleTimes(page)
  expect(snapped[0]).toBe(1)
  expect(snapped[1]).toBeCloseTo(2, 6)
})

/** And the switch is a switch: off, the same drag lands where he actually let go. */
test('with snapping off the same drag lands where he dropped it', async ({ page }) => {
  const id = await addTitle(page)
  await seedScaleKeyframes(page, id)
  await openHandControls(page)

  await setUI(page, { playheadS: 2, snapping: false })

  const diamonds = page.getByTestId('keyframe')
  const drag = diamonds.nth(1)
  await drag.hover()
  const d1 = await diamonds.nth(0).boundingBox()
  const d3 = await drag.boundingBox()
  if (!d1 || !d3) throw new Error('no geometry')
  const x1 = d1.x + d1.width / 2
  const x3 = d3.x + d3.width / 2
  const pxPerS = (x3 - x1) / 2
  const y = d3.y + d3.height / 2

  await page.mouse.move(x3, y)
  await page.mouse.down()
  await page.mouse.move(x1 + pxPerS + 4, y, { steps: 10 })
  await page.mouse.up()

  const landed = await scaleTimes(page)
  // Past the playhead by about the 4px he dragged it, not sitting on top of it.
  expect(landed[1]).toBeGreaterThan(2)
})
