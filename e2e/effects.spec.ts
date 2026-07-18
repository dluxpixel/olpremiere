// The Effects browser and the per-clip effect stack (spec §5.4, §5.5, Phase 4).
// Until this landed, the Effects tab was a stub reading "Arriving in Phase 4"
// and clip.effects was dead data the renderer never read.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/effects'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function addClip(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.flatMap((t) => t.clips)[0].id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
}

/** The clip's effect stack, straight from the store. */
async function stackTypes(page: Page, clipId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; effects: { type: string }[] }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
    return (clip?.effects ?? []).map((e) => e.type)
  }, clipId)
}

/**
 * Drive a real HTML5 drag onto a clip. Playwright's mouse-based dragTo does not
 * populate dataTransfer for custom MIME types, so dispatch the events with a
 * DataTransfer we build ourselves. `xFrac` picks the horizontal landing point,
 * which is what decides a transition's edge.
 */
async function dropOnClip(page: Page, mime: string, payload: string, xFrac = 0.25): Promise<void> {
  await page.evaluate(
    ({ mime, payload, xFrac }) => {
      const clip = document.querySelector('[data-clip-kind="video"]')
      if (!clip) throw new Error('no video clip to drop on')
      const rect = clip.getBoundingClientRect()
      const clientX = rect.left + rect.width * xFrac
      const clientY = rect.top + rect.height / 2
      const dt = new DataTransfer()
      dt.setData(mime, payload)
      const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY }
      clip.dispatchEvent(new DragEvent('dragover', opts))
      clip.dispatchEvent(new DragEvent('drop', opts))
    },
    { mime, payload, xFrac },
  )
}

/** Sample the program monitor. Copies to a 2D scratch: the canvas already owns a webgl2 context. */
async function previewPixel(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = c.width
      scratch.height = c.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { fx, fy },
  )
}

test('the Effects tab lists effects and transitions, and search filters both', async ({ page }) => {
  await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()

  await expect(page.getByTestId('effect-item').first()).toBeVisible()
  await expect(page.getByTestId('transition-item').first()).toBeVisible()

  await page.getByTestId('effect-search').fill('blur')
  await expect(page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]')).toBeVisible()
  await expect(page.locator('[data-testid="effect-item"][data-payload="saturation"]')).toHaveCount(0)
  await expect(page.getByTestId('transition-item')).toHaveCount(0)

  await page.getByTestId('effect-search').fill('dissolve')
  await expect(page.locator('[data-testid="transition-item"][data-payload="crossDissolve"]')).toBeVisible()
  await expect(page.getByTestId('effect-item')).toHaveCount(0)

  await page.getByTestId('effect-search').fill('zzzz')
  await expect(page.getByText('No match for')).toBeVisible()
})

test('a fresh clip has an empty stack and says so', async ({ page }) => {
  const clipId = await addClip(page)
  await expect(page.getByTestId('effect-stack-empty')).toBeVisible()
  expect(await stackTypes(page, clipId)).toEqual([])
})

test('double-clicking an effect applies it to the selected clip', async ({ page }) => {
  const clipId = await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]').dblclick()

  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  await expect(page.getByTestId('channel-blur')).toBeVisible()
  expect(await stackTypes(page, clipId)).toEqual(['gaussianBlur'])

  // Screenshot the STACK itself, not panel-right: the stack sits below the fold,
  // so a panel shot proves nothing about how the cards actually look.
  await page.locator('[data-testid="effect-item"][data-payload="colorWheels"]').dblclick()
  await expect(page.getByTestId('effect-card')).toHaveCount(2)
  await page.getByTestId('effect-card').last().getByTestId('effect-toggle').click() // show the disabled state too
  await page.mouse.move(0, 0) // park the cursor: a hover tooltip would cover the row below it
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByTestId('effect-stack').scrollIntoViewIfNeeded()
  await page.getByTestId('effect-stack').screenshot({ path: `${VERIFY}/effect-stack.png` })
})

test('dragging an effect from the browser onto a clip applies it', async ({ page }) => {
  const clipId = await addClip(page)
  await dropOnClip(page, 'application/x-reel-effect', 'saturation')
  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  expect(await stackTypes(page, clipId)).toEqual(['saturation'])
})

test('right-click an effect → Apply to every clip hits them all, in one undo', async ({ page }) => {
  await addClip(page)
  // A second clip on the timeline, and NOTHING selected — "every clip" must not
  // depend on a selection.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)
  // Video-track clips only — the imported webm carries linked audio, and a
  // visual effect deliberately never lands on an audio clip.
  const ids = await page.evaluate(async () => {
    // Same indirection as the helpers above: a literal specifier would make tsc
    // try to resolve these browser-only paths at build time.
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    useStore.getState().setUI({ selection: [] })
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
      .map((c) => c.id)
  })
  expect(ids).toHaveLength(2)

  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="saturation"]').click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Apply to every clip' }).click()

  for (const id of ids) expect(await stackTypes(page, id)).toEqual(['saturation'])

  // ONE undo clears all of them → it was a single command, not one per clip.
  await page.keyboard.press('Control+z')
  for (const id of ids) expect(await stackTypes(page, id)).toEqual([])
})

test('dragging a transition onto a clip picks the edge nearest the cursor', async ({ page }) => {
  const clipId = await addClip(page)

  await dropOnClip(page, 'application/x-reel-transition', 'crossDissolve', 0.1)
  await dropOnClip(page, 'application/x-reel-transition', 'dipToBlack', 0.9)

  const edges = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; transitionIn?: { type: string }; transitionOut?: { type: string } }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
    return { in: clip?.transitionIn?.type ?? null, out: clip?.transitionOut?.type ?? null }
  }, clipId)

  expect(edges).toEqual({ in: 'crossDissolve', out: 'dipToBlack' })
})

test('White Flash: drop on the in edge → opens near-white, resolves to footage', async ({ page }) => {
  const clipId = await addClip(page)

  // Drop on the LEFT half → in edge; the drop carries the kind's own default.
  await dropOnClip(page, 'application/x-reel-transition', 'whiteFlash', 0.1)
  const tr = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; transitionIn?: { type: string; durationS: number } }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.transitionIn ?? null
  }, clipId)
  expect(tr).toEqual({ type: 'whiteFlash', durationS: 0.2 })

  // Drive the playhead EXACTLY (a ruler click lands frames late, which is deep
  // enough into a 200 ms flash to fail a whiteness threshold). At t=0 the
  // curve is alpha=1 → the monitor must be essentially pure white.
  const setPlayhead = (tS: number) =>
    page.evaluate(async (t) => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { setUI: (p: unknown) => void } }
      }
      useStore.getState().setUI({ playheadS: t })
    }, tS)

  await setPlayhead(0)
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5)).every((c) => c >= 240), { timeout: 10_000 })
    .toBe(true)
  const flash = await previewPixel(page, 0.5, 0.5)

  // Well past the 200 ms window the white must have fully resolved into
  // footage — a clearly different frame from the flash.
  await setPlayhead(1)
  await expect
    .poll(
      async () => {
        const px = await previewPixel(page, 0.5, 0.5)
        return px.reduce((s, c, i) => s + Math.abs(c - flash[i]!), 0)
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(60)
})

test('Auto Color applies on drop at a visible strength and still renders', async ({ page }) => {
  const clipId = await addClip(page)
  // Park inside the clip so the monitor shows a real decoded frame.
  await page.getByTestId('ruler').click({ position: { x: 30, y: 10 } })
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5)).some((c) => c > 10), { timeout: 10_000 })
    .toBe(true)

  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="autoColor"]').dblclick()

  // It lands in the stack with an Amount control...
  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  await expect(page.getByTestId('channel-amount')).toBeVisible()
  expect(await stackTypes(page, clipId)).toEqual(['autoColor'])

  // ...seeded at strength 0.6 immediately (NOT the neutral 0), so it does
  // something the moment it's dropped...
  const amount = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; effects: { params: Record<string, number> }[] }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
    return clip.effects[0].params.amount
  }, clipId)
  expect(amount).toBe(0.6)

  // ...and the preview still paints a real frame (the generated shader compiled + ran).
  expect((await previewPixel(page, 0.5, 0.5)).some((c) => c > 10)).toBe(true)
})

test('applying the same effect twice keeps two independent instances', async ({ page }) => {
  const clipId = await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()
  const blur = page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]')
  await blur.dblclick()
  await blur.dblclick()
  expect(await stackTypes(page, clipId)).toEqual(['gaussianBlur', 'gaussianBlur'])
  await expect(page.getByTestId('effect-card')).toHaveCount(2)
})

test('the stack reorders, and the ends cannot move further', async ({ page }) => {
  const clipId = await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="gaussianBlur"]').dblclick()
  await page.locator('[data-testid="effect-item"][data-payload="saturation"]').dblclick()

  // Applied out of order, but canonical math order puts saturation before blur.
  expect(await stackTypes(page, clipId)).toEqual(['saturation', 'gaussianBlur'])

  const cards = page.getByTestId('effect-card')
  await expect(cards.first().getByTestId('effect-up')).toBeDisabled()
  await expect(cards.last().getByTestId('effect-down')).toBeDisabled()

  await cards.last().getByTestId('effect-up').click()
  expect(await stackTypes(page, clipId)).toEqual(['gaussianBlur', 'saturation'])
})

test('removing an effect empties the stack again', async ({ page }) => {
  const clipId = await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="saturation"]').dblclick()
  await expect(page.getByTestId('effect-card')).toHaveCount(1)

  await page.getByTestId('effect-remove').click()
  await expect(page.getByTestId('effect-stack-empty')).toBeVisible()
  expect(await stackTypes(page, clipId)).toEqual([])
})

test('disabling an effect restores the original pixels; re-enabling grades again', async ({ page }) => {
  await addClip(page)
  // Park inside the clip so the monitor shows a real decoded frame.
  await page.getByTestId('ruler').click({ position: { x: 30, y: 10 } })
  await expect.poll(async () => (await previewPixel(page, 0.5, 0.5)).some((c) => c > 10), { timeout: 10_000 }).toBe(true)
  const base = await previewPixel(page, 0.5, 0.5)

  await dropOnClip(page, 'application/x-reel-effect', 'saturation')
  // Drive saturation to -1 (greyscale): R, G and B must converge.
  await page.getByTestId('field-saturation').dblclick()
  await page.getByTestId('field-saturation').fill('-1')
  await page.getByTestId('field-saturation').press('Enter')

  await expect
    .poll(async () => {
      const [r, , b] = await previewPixel(page, 0.5, 0.5)
      return Math.abs(r - b)
    }, { timeout: 10_000 })
    .toBeLessThan(12)

  // The eye toggle must take the effect out of the render, not just grey the UI.
  await page.getByTestId('effect-toggle').click()
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
    .toBeGreaterThan(base[0] - 12)

  await page.getByTestId('effect-toggle').click()
  await expect
    .poll(async () => {
      const [r, , b] = await previewPixel(page, 0.5, 0.5)
      return Math.abs(r - b)
    }, { timeout: 10_000 })
    .toBeLessThan(12)
})
