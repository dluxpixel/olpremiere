// ⛔ THE ONLY TEST THAT CAN TELL AN INVERSION FROM A SOFT LIGHT.
//
// Every other test around this feature reads source text: that the resolver
// promotes the blend, that the shader has a `1 - d` branch, that the uniform is
// 2 rather than 1. None of them can see a pixel. And the failure this feature
// actually has is a silent wrong-mode: leave the uniform's ternary two-way and
// every inverted title renders as SOFT LIGHT, with no type error, no runtime
// error, and a picture that still looks like something.
//
// So this one reads the canvas. A full-frame RED bed on V1, one word on V2, and
// the letters must come back with the red GONE.
//
// ⚠️ IT SCANS A ROW, IT DOES NOT SAMPLE A POINT. The centre of a frame is very
// often the gap between two letters, and an antialiased edge is a half-covered
// pixel that proves nothing either way. So the whole middle row is read and the
// question asked of it is "did ANY pixel lose its red", which only an inversion
// can answer yes to: soft light leaves a saturated destination saturated, and
// white text leaves it white.

import { expect, test, type Page } from '@playwright/test'

/**
 * Every pixel across the vertical middle of the program monitor, every 4th
 * column. Copied to a 2D scratch because the canvas already owns a webgl2
 * context and cannot hand out a 2D one.
 */
async function centreRow(page: Page): Promise<[number, number, number][]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const scratch = document.createElement('canvas')
    scratch.width = c.width
    scratch.height = c.height
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const y = Math.floor(c.height / 2)
    const d = ctx.getImageData(0, y, c.width, 1).data
    const out: [number, number, number][] = []
    for (let x = 0; x < c.width; x += 4) out.push([d[x * 4], d[x * 4 + 1], d[x * 4 + 2]])
    return out
  })
}

/**
 * A full-frame red bed on V1 and one huge word on V2, built straight into the
 * store.
 *
 * The bed is a title with no text and an enormous box: the rasterizer sizes a
 * textless box off the usable width and clamps it to the frame, so it fills
 * every pixel with one known colour. That is what makes the reading decisive.
 * The word carries no shadow in either arm, so the control is a clean white and
 * not a smear of half-lit red.
 */
async function build(page: Page, invert: boolean): Promise<void> {
  await page.goto('/')
  await page.evaluate(async (inv) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { updateActiveSequence, useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    const { defaultTitleDef, newTitleClip } = (await import(/* @vite-ignore */ typesMod)) as {
      defaultTitleDef: (t?: string) => Record<string, unknown>
      newTitleClip: (def: unknown, startS: number, durS?: number) => Record<string, unknown>
    }

    updateActiveSequence('e2e: invert fixture', (s) => {
      const sq = s as { height: number; tracks: { kind: string; name: string }[] }

      const bed = newTitleClip(
        {
          ...defaultTitleDef(''),
          shadow: undefined,
          box: { color: '#ff0000', paddingPx: 5000, radiusPx: 0 },
        },
        0,
        5,
      )
      const word = newTitleClip(
        {
          ...defaultTitleDef('MMM'),
          shadow: undefined,
          fontSizePx: Math.round(sq.height * 0.4),
          color: '#ffffff',
          ...(inv ? { invertBackdrop: true } : {}),
        },
        0,
        5,
      )

      // V1 is the first video track and V2 the second: array order is
      // bottom→top, so the word composites OVER the bed.
      let seen = 0
      return {
        ...sq,
        durationS: 5,
        tracks: sq.tracks.map((t) => {
          if (t.kind !== 'video') return t
          seen += 1
          return { ...t, clips: [seen === 1 ? bed : word] }
        }),
      }
    })
    useStore.getState().setUI({ playheadS: 1, selection: [] })
  }, invert)
}

/** How many sampled pixels lost the bed's red entirely. Only an inversion can. */
const deRedded = (row: [number, number, number][]): number =>
  row.filter(([r, g, b]) => r < 60 && g > 190 && b > 190).length

/** How many still read as the untouched bed. */
const stillBed = (row: [number, number, number][]): number =>
  row.filter(([r, g, b]) => r > 190 && g < 60 && b < 60).length

test('an inverted word over red turns cyan where the letters are', async ({ page }) => {
  await build(page, true)

  await expect
    .poll(async () => stillBed(await centreRow(page)), { timeout: 15_000 })
    .toBeGreaterThan(20)

  const row = await centreRow(page)
  const flipped = deRedded(row)
  console.log(`[invert] ${flipped} of ${row.length} sampled pixels inverted, ${stillBed(row)} still bed`)

  // 255 minus the bed is cyan and nothing else is. Soft light cannot take a
  // saturated red channel to near zero, so this number is the whole proof.
  expect(flipped, 'no pixel lost its red: the blend is not inverting').toBeGreaterThan(10)
  // And the bed is still visible around the word, so it is clipped to the
  // glyphs rather than flipping the entire frame.
  expect(stillBed(row), 'the whole frame inverted, not just the letters').toBeGreaterThan(20)
})

test('the same word without the switch leaves the frame alone', async ({ page }) => {
  await build(page, false)

  await expect
    .poll(async () => stillBed(await centreRow(page)), { timeout: 15_000 })
    .toBeGreaterThan(20)

  const row = await centreRow(page)
  console.log(`[normal] ${deRedded(row)} of ${row.length} inverted, ${stillBed(row)} still bed`)
  // White over red is white or red, never cyan. If this fires, the invert has
  // leaked into every ordinary title.
  expect(deRedded(row), 'an ordinary title inverted its backdrop').toBe(0)
})
