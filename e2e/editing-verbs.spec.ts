// Keyboard editing verbs from the QoL batch: top-and-tail (Q/W), frame nudge
// (Alt+arrows), move-to-track (Alt+up/down), select-all (Ctrl+A), and
// enable/disable (Shift+E).

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

/** Read the active sequence's clips as {id,trackKind,startS,inS,outS,enabled}. */
async function clips(page: Page) {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { id: string; startS: number; inS: number; outS: number; enabled: boolean }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, trackKind: t.kind })))
  })
}

async function setUI(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (patch: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

const select = (page: Page, id: string) => setUI(page, { selection: [id] })
const setPlayhead = (page: Page, tS: number) => setUI(page, { playheadS: tS })

test('Q trims the clip head to the playhead and ripples the tail left', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  const before = (await clips(page)).find((c) => c.trackKind === 'video')!
  expect(before.startS).toBe(0)

  await setPlayhead(page, 0.5)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } }) // ensure keymap installed + focus off inputs
  await page.keyboard.press('q')

  const after = (await clips(page)).find((c) => c.trackKind === 'video')!
  // Head trimmed: source in advanced, clip shifted back to the playhead's old spot (ripple).
  expect(after.inS).toBeGreaterThan(before.inS)
  expect(after.startS).toBeCloseTo(0, 1)
})

test('Alt+Right nudges the selected clip one frame; Shift+Alt is ten', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  const frame = 1 / 30
  await page.keyboard.press('Alt+ArrowRight')
  let now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(v.startS + frame, 4)

  await page.keyboard.press('Shift+Alt+ArrowRight')
  now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(v.startS + frame * 11, 4)

  // And back to zero (clamped, cannot go negative).
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Shift+Alt+ArrowLeft')
  now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(0, 4)
})

test('Alt+Up moves the selected clip to the track above', async ({ page }) => {
  await boot(page)
  // Place on V1, then a second video track exists as V2 above it.
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  const trackOf = async () =>
    page.evaluate(async (id) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { name: string; clips: { id: string }[] }[] }
      }
      const seq = activeSequence(useStore.getState().project)
      return seq.tracks.find((t) => t.clips.some((c) => c.id === id))!.name
    }, v.id)

  expect(await trackOf()).toBe('V1')
  await page.keyboard.press('Alt+ArrowUp')
  expect(await trackOf()).toBe('V2')
})

test('Ctrl+A selects every clip', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await page.getByTestId('asset-card').dblclick() // two clips
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')

  const selCount = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection.length
  })
  // Two video clips + their linked audio partners = 4.
  expect(selCount).toBeGreaterThanOrEqual(2)
  // On the timeline, selected clips carry the accent ring.
  await expect(page.locator('[data-clip-kind] .ring-accent, [data-clip-kind].ring-accent')).toHaveCount(selCount)
})

test('Shift+E disables the clip (renders at 40%) and re-enables it', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  await page.keyboard.press('Shift+E')
  expect((await clips(page)).find((c) => c.id === v.id)!.enabled).toBe(false)

  await page.keyboard.press('Shift+E')
  expect((await clips(page)).find((c) => c.id === v.id)!.enabled).toBe(true)
})

// The split scheme (2026-07-18, replaces the earlier selection-scoped C which
// was "way too confusing"): C = the pair, ALWAYS; Shift+C = audio only;
// Alt+C = video only. Ctrl+C stays Copy.
test('C cuts the linked PAIR even when only one half is selected', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!

  await setPlayhead(page, 0.5)
  await select(page, v.id) // one half selected: C must STILL cut both
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('c')

  const after = await clips(page)
  expect(after.filter((c) => c.trackKind === 'video')).toHaveLength(2)
  expect(after.filter((c) => c.trackKind === 'audio')).toHaveLength(2)
})

test('Shift+C cuts only the AUDIO; Alt+C only the VIDEO', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  await setPlayhead(page, 0.5)
  await setUI(page, { selection: [] })
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  await page.keyboard.press('Shift+C')
  let after = await clips(page)
  expect(after.filter((c) => c.trackKind === 'audio')).toHaveLength(2) // audio cut
  expect(after.filter((c) => c.trackKind === 'video')).toHaveLength(1) // video whole

  await page.keyboard.press('Control+z')
  await setPlayhead(page, 0.5)
  await page.keyboard.press('Alt+C')
  after = await clips(page)
  expect(after.filter((c) => c.trackKind === 'video')).toHaveLength(2) // video cut
  expect(after.filter((c) => c.trackKind === 'audio')).toHaveLength(1) // audio whole
})

test('trimming a SELECTED audio clip leaves its linked video full length', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  const before = await clips(page)
  const v0 = before.find((c) => c.trackKind === 'video')!
  const a0 = before.find((c) => c.trackKind === 'audio')!

  await select(page, a0.id) // the AUDIO half only
  // Drag the audio clip's right edge left by 60px (~1s at the default zoom). The -2 lands
  // INSIDE the 6px out-trim handle, so the box is re-read after the hover, not before it.
  const audio = page.locator('[data-clip-kind="audio"]').first()
  await audio.hover()
  const box = (await audio.boundingBox())!
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 62, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  const after = await clips(page)
  const v1 = after.find((c) => c.id === v0.id)!
  const a1 = after.find((c) => c.id === a0.id)!
  expect(a1.outS).toBeLessThan(a0.outS) // audio got shorter
  expect(v1.outS).toBe(v0.outS) // video untouched
})

test('trimming with nothing selected still trims the linked pair together', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  const before = await clips(page)
  const v0 = before.find((c) => c.trackKind === 'video')!
  const a0 = before.find((c) => c.trackKind === 'audio')!
  await setUI(page, { selection: [] })

  const audio = page.locator('[data-clip-kind="audio"]').first()
  await audio.hover()
  const box = (await audio.boundingBox())!
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 62, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  const after = await clips(page)
  // The link still means "these stay in sync" when you haven't singled one out.
  expect(after.find((c) => c.id === a0.id)!.outS).toBeLessThan(a0.outS)
  expect(after.find((c) => c.id === v0.id)!.outS).toBeLessThan(v0.outS)
})

test('slip with nothing selected slips BOTH halves, so the pair stays in sync', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await setUI(page, { selection: [] })

  // Trim both heads together first, so the pair has source handles on the left.
  const video = page.locator('[data-clip-kind="video"]').first()
  await video.hover()
  // +3 is inside the 6px in-trim handle: keep the aim, refresh the box it comes from.
  let box = (await video.boundingBox())!
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 33, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await setUI(page, { selection: [] })

  const before = await clips(page)
  const v0 = before.find((c) => c.trackKind === 'video')!
  const a0 = before.find((c) => c.trackKind === 'audio')!
  expect(v0.inS).toBeGreaterThan(0)
  expect(a0.inS).toBeGreaterThan(0)

  // The head trim above moved this clip, so hover and re-read before grabbing its middle.
  await video.hover()
  box = (await video.boundingBox())!
  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 15, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Alt')

  const after = await clips(page)
  const v1 = after.find((c) => c.id === v0.id)!
  const a1 = after.find((c) => c.id === a0.id)!
  // The video's source window actually moved...
  expect(v1.inS).toBeLessThan(v0.inS)
  // ...and the audio followed by exactly the same amount. Slipping only the
  // grabbed half left the picture running ahead of the voice, permanently,
  // with no visual feedback at all.
  expect(a1.inS - a0.inS).toBeCloseTo(v1.inS - v0.inS, 6)
  expect(v1.startS).toBe(v0.startS) // still a slip: position unchanged
})

test('a freshly inserted clip lands unselected, so trimming its head trims the pair', async ({
  page,
}) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Nothing is selected on insert: selecting the video half would make the very
  // next edit read as "I singled this one out".
  const selection = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection
  })
  expect(selection).toEqual([])

  const before = await clips(page)
  const v0 = before.find((c) => c.trackKind === 'video')!
  const a0 = before.find((c) => c.trackKind === 'audio')!

  // Head-trim the video straight after inserting: the audio must follow.
  const video = page.locator('[data-clip-kind="video"]').first()
  await video.hover()
  const box = (await video.boundingBox())!
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 33, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()

  const after = await clips(page)
  const v1 = after.find((c) => c.id === v0.id)!
  const a1 = after.find((c) => c.id === a0.id)!
  expect(v1.inS).toBeGreaterThan(v0.inS)
  expect(a1.inS - a0.inS).toBeCloseTo(v1.inS - v0.inS, 6)
  expect(a1.startS).toBeCloseTo(v1.startS, 6)
})
