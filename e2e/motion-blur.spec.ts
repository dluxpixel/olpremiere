// Does a fast move actually smear? Real pixels off the program monitor, because the
// honest question about a blur is what the picture looks like.
//
// His ask, 2026-08-17: *"how do these good YouTubers make the extremely good
// edits?"* The answer researched that day was motion blur derived from the move
// itself, and the reason it matters is that an animation with perfectly sharp edges
// reads as made by a computer.
//
// A TITLE clip is the subject on purpose: rasterized text carries the hardest edges
// anything in this app can, which is exactly what a smear destroys and what a
// measurement can see. A soft video gradient would prove nothing either way.
//
// ⛔ AND THE FIRST VERSION OF THIS FILE MEASURED THE WRONG THING, which is worth
// keeping written down. It drove a punch in and read the middle of the frame, found
// no change, and looked exactly like a broken shader. A punch is a ZOOM: its smear
// runs outward from the centre, so it displaces almost nothing AT the centre, which
// is where centred text lives. The shader was right the whole time. A slide is the
// case where the smear is uniform across the frame, so a slide is what proves it,
// and the zoom is proved at the frame's edge where a zoom actually moves picture.

import { expect, test, type Page } from '@playwright/test'

/**
 * Horizontal edge energy over a band of the program monitor: the sum of the absolute
 * luma difference between neighbouring pixels.
 *
 * Sharp text scores high. The same text smeared sideways scores lower, because a
 * smear is exactly the operation that spreads an edge over more pixels.
 *
 * `from`/`to` are fractions of the frame HEIGHT.
 */
async function edgeEnergy(page: Page, from = 0.1, to = 0.9): Promise<number> {
  return page.evaluate(
    ({ from, to }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const s = document.createElement('canvas')
      s.width = c.width
      s.height = c.height
      const ctx = s.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      let energy = 0
      const y0 = Math.max(0, Math.floor(c.height * from))
      const y1 = Math.min(c.height - 1, Math.floor(c.height * to))
      for (let y = y0; y <= y1; y += 2) {
        const d = ctx.getImageData(0, y, c.width, 1).data
        for (let i = 0; i + 7 < d.length; i += 4) {
          const l0 = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
          const l1 = 0.2126 * d[i + 4] + 0.7152 * d[i + 5] + 0.0722 * d[i + 6]
          energy += Math.abs(l1 - l0)
        }
      }
      return energy
    },
    { from, to },
  )
}

/**
 * A coarse grid of luma samples off the monitor, for asking "did the picture change
 * at all" rather than "did it get softer".
 *
 * ⛔ EDGE ENERGY IS THE WRONG QUESTION FOR A ZOOM, measured 2026-08-17: with the
 * shutter on, a zoom's smear drags text out over empty background, so it ADDS edges
 * where the sharp frame had none. Full frame it read 56,908 blurred against 57,028
 * sharp, and one band read HIGHER blurred. Both are the shader working correctly on
 * a picture that is mostly flat. So the zoom is proved by the picture differing, and
 * the softening direction is proved by the slide, where the smear is uniform.
 */
async function lumaGrid(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const s = document.createElement('canvas')
    s.width = c.width
    s.height = c.height
    const ctx = s.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const out: number[] = []
    for (let y = 0; y < c.height; y += 4) {
      for (let x = 0; x < c.width; x += 4) {
        const i = (y * c.width + x) * 4
        out.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
      }
    }
    return out
  })
}

/** Mean absolute luma difference between two grids, 0..255. */
const meanDiff = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i])
  return n > 0 ? sum / n : 0
}

/**
 * Animate one channel on the only clip, fast, and park the playhead at a WHOLE
 * frame.
 *
 * ⛔ THE WHOLE FRAME MATTERS. The preview's redraw is keyed on the frame INDEX, so
 * seeking from 0 to half a frame repaints nothing and the next measurement silently
 * reads the previous picture. That cost three runs.
 *
 * Linear on purpose: the app's default curve is `snapIn`, which covers most of its
 * distance in the first instant, so two frames in there is nothing left to smear.
 */
async function animate(page: Page, channel: string, from: number, to: number): Promise<void> {
  await page.evaluate(
    async ({ channel, from, to }) => {
      // A variable, not a literal: tsc cannot resolve an absolute dev-server path,
      // and it must live INSIDE the callback, because this body runs in the browser.
      const storeMod = '/src/state/store.ts'
      const { updateActiveSequence, useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
        useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
      }
      type Clip = { keyframes?: Record<string, unknown> }
      updateActiveSequence('animate for test', (sq) => {
        const seq = sq as { tracks: { clips: Clip[] }[] }
        return {
          ...seq,
          tracks: seq.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => ({
              ...c,
              keyframes: {
                ...(c.keyframes ?? {}),
                [channel]: [
                  { t: 0, value: from, ease: 'linear' },
                  { t: 4 / 30, value: to, ease: 'linear' },
                ],
              },
            })),
          })),
        }
      })
      useStore.getState().setUI({ playheadS: 2 / 30 })
    },
    { channel, from, to },
  )
  await page.waitForTimeout(400)
}

/** Flip motion blur off and let the preview repaint. */
async function blurOff(page: Page): Promise<void> {
  await page.getByTestId('motion-blur-toggle').click()
  await expect(page.getByTestId('shutter-angle')).toBeHidden()
  await page.waitForTimeout(400)
}

test('the control is there and starts at the film standard', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await expect(page.getByTestId('motion-blur-toggle')).toBeVisible()
  // ON by default. If this fails, the feature exists and changes nothing he sees.
  await expect(page.getByTestId('shutter-angle')).toHaveValue(/180/)
})

test('a fast slide smears, and switching motion blur off makes it sharp again', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)

  // 900 px over four frames: a whip, and its smear is uniform across the frame.
  await animate(page, 'posX', 0, 900)
  const smeared = await edgeEnergy(page)

  await blurOff(page)
  const sharp = await edgeEnergy(page)

  // A smear spreads every edge, so it MUST cost edge energy.
  expect(smeared).toBeLessThan(sharp * 0.9)
  expect(sharp).toBeGreaterThan(0)
})

test('a fast zoom changes the picture too, which is the shader other half', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)

  // 1 to 2.4 over four frames. The radial half of the shader is a different branch
  // from the sideways half, so it gets its own proof.
  await animate(page, 'scale', 1, 2.4)
  const smeared = await lumaGrid(page)
  await blurOff(page)
  const sharp = await lumaGrid(page)

  // The picture must genuinely differ. Measured 2026-08-17: this zoom moves the
  // frame's mean luma by 0.26 of a level, while the still clip below moves it by
  // under 0.01. The floor sits between those two, an order of magnitude above the
  // noise and well under the real signal, rather than at a round number nobody
  // measured.
  expect(meanDiff(smeared, sharp)).toBeGreaterThan(0.1)
})

test('a still clip is untouched, so nothing he has not animated goes soft', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)

  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
    }
    useStore.getState().setUI({ playheadS: 15 / 30 })
  })
  await page.waitForTimeout(400)
  const withBlurOn = await lumaGrid(page)
  await blurOff(page)
  const withBlurOff = await lumaGrid(page)

  // The same picture, pixel for pixel: a clip with no keyframes never gets a second
  // sample, so there is nothing to smear and nothing to pay for.
  expect(meanDiff(withBlurOn, withBlurOff)).toBeLessThan(0.01)
})
