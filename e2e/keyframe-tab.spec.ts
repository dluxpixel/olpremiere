// Keyframe-tab overhaul: selectable zoom depth applies a punch of that depth,
// the easing explainer answers "what is Lin", and a multi-select shows the
// align-to-same-spot box in the preview. (There is no standalone Keyframes
// section any more: every animated property carries its own lane on the Motion
// Rail, directly under the row that names it, and easing belongs to the SEGMENT
// between two diamonds, so the explainer lives in the curve editor.)

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

/** Every Zoom keyframe's named ease, and whether a hand-shaped curve overrides it. */
async function scaleKfEases(page: Page): Promise<{ ease: string; curve: boolean }[]> {
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
      channelKeyframes: (clip: unknown, ch: string) => { ease: string; curve?: number[] }[]
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)
    return channelKeyframes(clip, 'scale').map((k) => ({ ease: k.ease, curve: k.curve !== undefined }))
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

test('selecting a zoom depth applies a punch of that depth', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await setUI(page, { selection: [id], playheadS: 2 })
  await openHandControls(page)

  // Pick "Deep" (1.4×), then Apply → the scale keyframes peak near 1.4.
  await page.getByTestId('punch-preset-deep').click()
  await expect(page.getByTestId('punch-depth-readout')).toHaveText('140%')
  await page.getByTestId('punch-apply').click()
  expect(await scaleKfMax(page)).toBeCloseTo(1.4, 2)

  // And the punch is visible and editable as keyframes: the Zoom lane under the
  // Scale row carries the diamonds it just wrote. That is where the standalone
  // Keyframes section went - one lane per animated property, under the row that
  // names it, instead of one section listing every channel.
  const zoomLane = page.locator('[data-testid="keyframe-track"][data-channel="scale"]')
  await expect(zoomLane).toBeVisible()
  await expect(zoomLane.getByTestId('keyframe').first()).toBeVisible()
})

test('the easing explainer answers "what is Lin"', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)

  // Punch in at 2s and out at 4s: four Zoom diamonds, with a long hold between
  // the second and the third that is wide enough to click without zooming the
  // rail first. A 5-frame rise on its own is two pixels on a fitted 5s clip.
  await setUI(page, { selection: [id], playheadS: 2 })
  await openHandControls(page)
  await page.getByTestId('punch-apply').click()
  await setUI(page, { selection: [id], playheadS: 4 })
  await page.getByTestId('punch-out').click()

  const diamonds = page.locator('[data-testid="keyframe-track"][data-channel="scale"]').getByTestId('keyframe')
  await expect(diamonds).toHaveCount(4)

  // Easing belongs to the SEGMENT between two diamonds now, never to a diamond,
  // so the segment is what he clicks. Hover FIRST, then read the boxes: hover
  // runs the actionability and hit-target checks raw page.mouse.* skips, and it
  // can scroll the lane, which would stale a midpoint measured before it.
  await diamonds.nth(1).hover()
  const a = await diamonds.nth(1).boundingBox()
  const b = await diamonds.nth(2).boundingBox()
  if (!a || !b) throw new Error('no geometry')
  await page.mouse.click((a.x + a.width / 2 + b.x + b.width / 2) / 2, a.y + a.height / 2)

  const editor = page.getByTestId('curve-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText(/Ease|Linear|Hold/)
  // ...and it answers in plain language, which is what "what is Lin" asks. The
  // hold he just clicked runs Lin, so the explainer says what Lin does.
  await expect(page.getByTestId('ease-explainer')).toHaveText(/^Linear: constant speed/)

  // Every named shape is still reachable from here, Hold included. Hold is a
  // step, no bezier can express a step, so the six curve chips cannot stand in
  // for it: losing this row would lose the shape outright.
  await page.getByTestId('ease-hold').click()
  await expect(page.getByTestId('ease-explainer')).toHaveText(/^Hold: freeze on this value/)
  expect((await scaleKfEases(page))[1]).toEqual({ ease: 'hold', curve: false })
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
  // Hover before reading the box: it runs the actionability and hit-target checks
  // raw page.mouse.* skips, and it can scroll, which would stale the box.
  await last.hover()
  const box = (await last.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 40, cy, { steps: 8 })
  await page.mouse.up()

  const after = await timesOf()
  expect(after.length).toBe(before.length) // moved, not added
  expect(after[after.length - 1]).toBeGreaterThan(before[before.length - 1])

  // ONE undo step puts every channel back where it was.
  await page.keyboard.press('Control+z')
  await expect.poll(timesOf).toEqual(before)
})

test('arming from the gizmo badge turns a monitor drag into an animation', async ({ page }) => {
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

  // Park the playhead inside the clip FIRST: arming keyframes the framing where
  // the playhead is, and a lone keyframe at the head of the clip is just a moved
  // base, so a drag there is a plain move either way.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ playheadS: 2 })
  })

  // The badge on the picture is the arming control; there is no global toggle in
  // the transport bar any more, and armed is the clip's own fact.
  await expect(page.getByTestId('gizmo-motion-badge')).toBeVisible()
  await page.getByTestId('gizmo-motion-badge').click()

  const gizmo = page.getByTestId('gizmo-body')
  await expect(gizmo).toBeVisible()
  // hover() first, so the box below is read after anything it scrolls.
  await gizmo.hover()
  const box = (await gizmo.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 80, cy, { steps: 8 })
  await page.mouse.up()

  // Two keyframes: where it was, and where the playhead is.
  await expect.poll(posXCount).toBe(2)
  await expect(page.getByTestId('clip-keyframe')).toHaveCount(2)

  // And the one the drag landed carries the snap curve, not linear. Linear is
  // the opt-out here, which is most of the visible quality gap against the phone
  // editors: a linear move reads as machinery, a curved one reads as an edit.
  const lastCurve = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { keyframes?: { posX?: { curve?: number[] }[] } }[] }[]
      }
    }
    const clip = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0]
    const kfs = clip.keyframes?.posX ?? []
    return kfs[kfs.length - 1]?.curve ?? null
  })
  expect(lastCurve).toEqual([0.16, 1, 0.3, 1])
})
