// Retiming keyframes in the Keyframes lane: drag a diamond along the track, or
// type an exact time in the Time field. "Set the time this happens."

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

test('dragging a keyframe diamond retimes it', async ({ page }) => {
  const id = await addTitle(page)
  await seedScaleKeyframes(page, id)

  await expect(page.getByTestId('keyframe-lane')).toBeVisible()
  const diamonds = page.getByTestId('keyframe')
  await expect(diamonds).toHaveCount(2)
  expect(await scaleTimes(page)).toEqual([1, 3])

  // Drag the t=3 diamond toward the t=1 diamond → lands near t≈2. Using both
  // diamond boxes makes the target robust to the track's exact geometry.
  const d1 = await diamonds.nth(0).boundingBox()
  const d3 = await diamonds.nth(1).boundingBox()
  if (!d1 || !d3) throw new Error('no geometry')
  const midX = (d1.x + d1.width / 2 + d3.x + d3.width / 2) / 2
  const y = d3.y + d3.height / 2

  await diamonds.nth(1).hover()
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
