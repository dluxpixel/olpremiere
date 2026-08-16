// The screenshot button in the monitor bar (his ask, 2026-08-15).
//
// The assertion that matters is the SIZE. Reading back the monitor canvas would
// also produce a PNG and also land it in the bin, and it would pass any test
// that only counted assets, while handing him a soft panel-sized picture whose
// dimensions changed with how wide he left the panel. So this test says the
// still is exactly the sequence's own raster, which only the real render path
// can be.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

interface Shot {
  seqW: number
  seqH: number
  images: { name: string; width?: number; height?: number; blobKey: string }[]
}

/** Sequence size + every image asset in the bin, straight from the store. */
async function shotState(page: Page): Promise<Shot> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => {
          project: {
            assets: Record<string, { name: string; kind: string; width?: number; height?: number; blobKey: string }>
          }
        }
      }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { width: number; height: number }
    }
    const state = useStore.getState()
    const seq = activeSequence(state.project)
    return {
      seqW: seq.width,
      seqH: seq.height,
      images: Object.values(state.project.assets)
        .filter((a) => a.kind === 'image')
        .map((a) => ({ name: a.name, width: a.width, height: a.height, blobKey: a.blobKey })),
    }
  })
}

/**
 * How many DISTINCT colours the stored still contains, sampled on a grid.
 *
 * One colour means a blank canvas, which is exactly what a screenshot taken
 * without a working renderer produces: the right size, the right name, in the
 * right place, and no picture in it. Size alone would never catch that.
 */
async function distinctColours(page: Page, blobKey: string): Promise<number> {
  return page.evaluate(async (key) => {
    const mod = '/src/state/persistence.ts'
    const { getBlob } = (await import(/* @vite-ignore */ mod)) as {
      getBlob: (k: string) => Promise<Blob | null>
    }
    const blob = await getBlob(key)
    if (!blob) return 0
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return 0
    ctx.drawImage(bmp, 0, 0)
    const seen = new Set<number>()
    const step = 16
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
        seen.add((r << 16) | (g << 8) | b)
      }
    }
    return seen.size
  }, blobKey)
}

test('the screenshot lands in the media at the sequence size', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Nothing photographed yet.
  expect((await shotState(page)).images).toHaveLength(0)

  await page.getByTestId('screenshot-button').click()
  // Two cards now: the footage and the still.
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 20_000 })

  const after = await shotState(page)
  expect(after.images).toHaveLength(1)
  const still = after.images[0]
  // Full size, not panel size. This is the whole point of the feature.
  expect(still.width).toBe(after.seqW)
  expect(still.height).toBe(after.seqH)
  // Named by the frame it was taken on, with no colon in it.
  expect(still.name).toMatch(/^Frame \d\d-\d\d-\d\d-\d\d\.png$/)
  // And there is a PICTURE in it, not a correctly-sized blank.
  expect(await distinctColours(page, still.blobKey)).toBeGreaterThan(1)
})

test('a 9:16 short is photographed as a 9:16 still', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // The button sits next to this picker, and it has to follow it.
  await page.getByTestId('format-select').selectOption('9:16')
  await page.getByTestId('screenshot-button').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 20_000 })

  const after = await shotState(page)
  expect(after.seqH).toBeGreaterThan(after.seqW)
  expect(after.images[0].width).toBe(after.seqW)
  expect(after.images[0].height).toBe(after.seqH)
})
