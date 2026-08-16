// Zoom inside the picture: the shot gets closer, the picture stays put.
//
// The geometry is proven in src/engine/innerZoom.test.ts, which drives the real
// computeQuad and asserts the corners never move. What this covers is the wiring:
// one field in the inspector reaching all four crops, and the backdrop behind it
// staying exactly where it was.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

interface Shape {
  crop: { t: number; r: number; b: number; l: number }
  scale: number
}

async function shapeOf(page: Page): Promise<Shape> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: {
          clips: { transform: { scale: number; crop: { t: number; r: number; b: number; l: number } } }[]
        }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips)[0]
    return { crop: clip.transform.crop, scale: clip.transform.scale }
  })
}

async function shortWithClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('format-select').selectOption('9:16')
  await page.locator('[data-clip-kind="video"]').click()
  await expect(page.getByTestId('field-innerZoom')).toBeVisible()
}

test('one field zooms inside and never touches the scale', async ({ page }) => {
  await shortWithClip(page)
  // ⛔ SCALE IS NOT 1 HERE. Switching a sequence to 9:16 refits every clip to
  // fill the new frame, so the clip arrives already scaled up. The claim is not
  // that scale is 1, it is that the inner zoom LEAVES IT ALONE whatever it is.
  const before = await shapeOf(page)
  expect(before.crop).toMatchObject({ t: 0, r: 0, b: 0, l: 0 })

  const field = page.getByTestId('field-innerZoom')
  await field.dblclick()
  await field.fill('2')
  await field.press('Enter')

  const after = await shapeOf(page)
  // A quarter off every edge is 2x, and all four move together.
  expect(after.crop.t).toBeCloseTo(0.25, 4)
  expect(after.crop.r).toBeCloseTo(0.25, 4)
  expect(after.crop.b).toBeCloseTo(0.25, 4)
  expect(after.crop.l).toBeCloseTo(0.25, 4)
  // ⛔ Scale untouched. Scale would have grown the picture out over the bands,
  // which is the whole thing this exists instead of.
  expect(after.scale).toBe(before.scale)
})

test('its reset puts the picture back', async ({ page }) => {
  await shortWithClip(page)
  const field = page.getByTestId('field-innerZoom')
  await field.dblclick()
  await field.fill('1.8')
  await field.press('Enter')
  expect((await shapeOf(page)).crop.t).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Reset zoom inside' }).click()
  expect(await shapeOf(page)).toMatchObject({ crop: { t: 0, r: 0, b: 0, l: 0 } })
})

test('the stopwatch keyframes all four crops at once', async ({ page }) => {
  await shortWithClip(page)
  await page.getByTestId('stopwatch-innerZoom').click()

  const kfs = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { keyframes: Record<string, unknown[]> }[] }[] }
    }
    const clip = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0]
    return ['cropT', 'cropR', 'cropB', 'cropL'].map((ch) => (clip.keyframes[ch] ?? []).length)
  })
  expect(kfs).toEqual([1, 1, 1, 1])
})
