// The picture frame INSIDE the export frame, proved on real pixels.
//
// His ask, 2026-09-04, off a reel: the file is still a 9:16 short, and the
// footage sits in a square inside it with bands above and below.
//
// ⛔ THE PART THAT NEEDS A BROWSER IS THE CLIP, NOT THE LAYOUT. The geometry is
// pure and unit-tested. What no unit test can see is whether the shader actually
// discards the picture outside the box: `uContentBox` is a uniform, and a
// uniform that is never set, or set on the wrong program, fails by drawing a
// perfectly normal-looking frame with the picture spilling into the bands. It
// only shows up the moment he zooms, which is the moment he would find it.
//
// So the discriminator here is a ZOOM PAST THE BOX. At scale 3 the picture
// covers the whole 9:16 frame; with a square inner frame the bands must stay
// black anyway.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** A pixel of the program monitor. The canvas owns a webgl2 context, so copy first. */
async function pixel(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
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

const lit = (px: [number, number, number]): boolean => Math.max(...px) > 24

/** One real video clip on a 9:16 sequence, parked on a decoded frame. */
async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('format-select').selectOption('9:16')
  await page.getByTestId('ruler').click({ position: { x: 30, y: 10 } })
  // Wait for an actual decoded frame rather than the empty first paint.
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.5)), { timeout: 15_000 }).toBe(true)
}

/** Zoom the one clip, so the picture wants to cover the whole 9:16 frame. */
async function zoom(page: Page, scale: number): Promise<void> {
  await page.evaluate(async (scale) => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    updateActiveSequence('e2e: zoom', (s) => {
      const sq = s as { tracks: { clips: Record<string, unknown>[] }[] }
      return {
        ...sq,
        tracks: sq.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => ({ ...c, transform: { ...(c.transform as object), scale } })),
        })),
      }
    })
  }, scale)
}

test('a square inner frame keeps the bands black even under a zoom', async ({ page }) => {
  await setup(page)

  // The control FIRST, so a fixture that simply never draws cannot pass the
  // real assertion by accident. Filling the frame, zoomed to 3, the top band
  // is covered in picture.
  await zoom(page, 3)
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.1)), { timeout: 15_000 }).toBe(true)
  const spill = await pixel(page, 0.5, 0.1)

  // Now the square. Same zoom, same frame, and the top band must go dark: a
  // 1:1 box in a 1080x1920 frame runs from y 420 to y 1500, so 0.1 down is
  // outside it.
  await page.getByTestId('content-aspect-select').selectOption('1:1')
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.1)), { timeout: 15_000 }).toBe(false)

  const band = await pixel(page, 0.5, 0.1)
  const inside = await pixel(page, 0.5, 0.5)
  console.log(`[frame] band was ${spill.join(',')}, now ${band.join(',')}; inside ${inside.join(',')}`)

  // And the square itself still has the picture in it: a clip that discards
  // everything would also make the band black, and would prove nothing.
  expect(lit(inside), 'the square went dark too: this is not a clip, it is a blank').toBe(true)
})

test('clearing the inner frame gives the whole frame back', async ({ page }) => {
  await setup(page)
  await zoom(page, 3)
  await page.getByTestId('content-aspect-select').selectOption('1:1')
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.1)), { timeout: 15_000 }).toBe(false)

  // ⛔ THE UNIFORM IS PER-PROGRAM STATE. If it were only ever set and never
  // cleared, the box would outlive the setting and keep cropping.
  await page.getByTestId('content-aspect-select').selectOption('full')
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.1)), { timeout: 15_000 }).toBe(true)
})

test('a typed ratio is honoured, and it is not the preset rounded off', async ({ page }) => {
  await setup(page)
  await zoom(page, 3)

  // A square first, so the row below has a known reading to differ from. Its
  // box runs 420..1500 in a 1080x1920 frame, so 19% down is in the top band.
  await page.getByTestId('content-aspect-select').selectOption('1:1')
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.19)), { timeout: 15_000 }).toBe(false)

  // Now 4:5 typed by hand. Its box runs 285..1635, so the SAME point is now
  // inside the picture. A custom ratio that quietly fell back to a preset, or
  // to no frame at all, cannot produce this pair of readings.
  await page.getByTestId('content-aspect-select').selectOption('__customContent')
  const field = page.getByTestId('content-aspect-custom')
  await expect(field).toBeVisible()
  await field.fill('4:5')
  await field.press('Enter')

  await expect.poll(async () => lit(await pixel(page, 0.5, 0.19)), { timeout: 15_000 }).toBe(true)
  // ...and 10% down is still band, so it really is a frame and not a clearing.
  expect(lit(await pixel(page, 0.5, 0.1)), 'the 4:5 band filled in').toBe(false)
})

test('nonsense in the ratio field leaves his frame alone', async ({ page }) => {
  await setup(page)
  await zoom(page, 3)
  await page.getByTestId('content-aspect-select').selectOption('1:1')
  await expect.poll(async () => lit(await pixel(page, 0.5, 0.1)), { timeout: 15_000 }).toBe(false)

  await page.getByTestId('content-aspect-select').selectOption('__customContent')
  const field = page.getByTestId('content-aspect-custom')
  await field.fill('wide please')
  await field.press('Enter')

  // ⛔ SILENTLY CLEARING THE FRAME IS THE FAILURE THIS GUARDS. A typo must cost
  // him a retype, never the framing he already set.
  expect(lit(await pixel(page, 0.5, 0.1)), 'a typo cleared the inner frame').toBe(false)
})
