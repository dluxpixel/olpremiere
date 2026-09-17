// A dissolve mixes LIGHT, not numbers.
//
// Halfway between a black clip and a white clip the frame must be half as
// bright as white, which on an sRGB screen is pixel value 188, not 128. The
// old combine mixed the encoded values and landed on 128, about a fifth of the
// light, so every dissolve sagged dark through its middle and a fade from black
// fell off a cliff at the end. This reads the program monitor itself, through
// the real renderer, at the midpoint of a real cross dissolve.

import { expect, test, type Page } from '@playwright/test'

const BLACK = 'e2e/.fixtures/black.png'
const WHITE = 'e2e/.fixtures/white.png'

/** The 8-bit sRGB value of a linear light fraction. */
const srgb = (linear: number): number => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055)

async function centrePixel(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const scratch = document.createElement('canvas')
    scratch.width = 4
    scratch.height = 4
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(c, Math.floor(c.width / 2), Math.floor(c.height / 2), 4, 4, 0, 0, 4, 4)
    const d = ctx.getImageData(1, 1, 1, 1).data
    return [d[0], d[1], d[2]] as [number, number, number]
  })
}

/** Put a 2 s cross dissolve on the second clip and park the playhead a fraction of the way through it. */
async function dissolveAt(page: Page, fraction: number): Promise<void> {
  await page.evaluate(
    async ({ fraction }) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown; setUI: (p: { playheadS: number }) => void } }
        updateActiveSequence: (label: string, fn: (s: Seq) => Seq) => void
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => Seq }
      type Clip = { id: string; startS: number; transitionIn?: { type: string; durationS: number } }
      type Seq = { tracks: { kind: string; clips: Clip[] }[] }
      const D = 2
      updateActiveSequence('dissolve', (s) => ({
        ...s,
        tracks: s.tracks.map((t) =>
          t.kind !== 'video'
            ? t
            : { ...t, clips: t.clips.map((c, i) => (i === 1 ? { ...c, transitionIn: { type: 'crossDissolve', durationS: D } } : c)) },
        ),
      }))
      const seq = activeSequence(useStore.getState().project)
      const second = seq.tracks.find((t) => t.kind === 'video')!.clips[1]
      useStore.getState().setUI({ playheadS: second.startS + D * fraction })
    },
    { fraction },
  )
}

test('halfway through a dissolve from black to white the picture is half the LIGHT of white', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles([BLACK, WHITE])
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 15_000 })
  // Newest import first in the bin, so the last card is black: it goes first on the timeline.
  await page.getByTestId('asset-card').last().dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('asset-card').first().dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

  await dissolveAt(page, 0.5)
  await expect
    .poll(async () => (await centrePixel(page))[1], { timeout: 10_000 })
    .toBeGreaterThan(srgb(0.5) - 8)
  const [r, g, b] = await centrePixel(page)
  expect(g).toBeLessThan(srgb(0.5) + 8) // 188, give or take the dither
  expect(Math.abs(r - g)).toBeLessThan(4)
  expect(Math.abs(b - g)).toBeLessThan(4)

  // A quarter of the way in, a quarter of the light: 137, nowhere near 64.
  await dissolveAt(page, 0.25)
  await expect
    .poll(async () => (await centrePixel(page))[1], { timeout: 10_000 })
    .toBeGreaterThan(srgb(0.25) - 8)
  expect((await centrePixel(page))[1]).toBeLessThan(srgb(0.25) + 8)
})

test('a white clip at half opacity over black is half the LIGHT of white, so a fade no longer falls off a cliff', async ({ page }) => {
  // Opacity and the corner fade handles go through the layer composite, not
  // the transition combine. With the composite in encoded space a clip at 50%
  // opacity over black drew 128; in linear light it draws 188.
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles([WHITE])
  await expect(page.getByTestId('asset-card')).toHaveCount(1, { timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
      updateActiveSequence: (label: string, fn: (s: Seq) => Seq) => void
    }
    type Seq = { tracks: { kind: string; clips: { opacity: number }[] }[] }
    updateActiveSequence('half', (s) => ({
      ...s,
      tracks: s.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, clips: t.clips.map((c) => ({ ...c, opacity: 0.5 })) })),
    }))
    useStore.getState().setUI({ playheadS: 1 })
  })
  await expect
    .poll(async () => (await centrePixel(page))[1], { timeout: 10_000 })
    .toBeGreaterThan(srgb(0.5) - 8)
  expect((await centrePixel(page))[1]).toBeLessThan(srgb(0.5) + 8)
})

test('halfway from mid grey to white the inputs are decoded too, not only the output re-encoded', async ({ page }) => {
  // Black and white are the same in both spaces, so the first test cannot tell
  // a decoded input from a raw one. Grey 128 can: it is 21.6% light, so half way
  // to white is 60.8% light, pixel 204. Mixing the raw numbers gives 192, and
  // re-encoding a raw mix gives 226. Only the whole chain lands on 204.
  const GREY = 'e2e/.fixtures/grey.png'
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles([GREY, WHITE])
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 15_000 })
  await page.getByTestId('asset-card').last().dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('asset-card').first().dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

  await dissolveAt(page, 0.5)
  const grey = 128 / 255
  const greyLinear = grey <= 0.04045 ? grey / 12.92 : Math.pow((grey + 0.055) / 1.055, 2.4)
  const want = srgb((greyLinear + 1) / 2)
  await expect
    .poll(async () => (await centrePixel(page))[1], { timeout: 10_000 })
    .toBeGreaterThan(want - 5)
  expect((await centrePixel(page))[1]).toBeLessThan(want + 5)
})
