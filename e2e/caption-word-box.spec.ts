// The Word box, read off the real program monitor.
//
// His words, 2026-10-19: *"Look at this text ... completely copy the system ...
// Also add it as an option if I want to highlight my text too."* His frame is
// white bold capitals with a dark outline, and the word being said sits in a
// rounded box with a crimson border and a dark see-through fill.
//
// Every unit test around this reads numbers or source text. None of them can
// see a pixel, and the failure this feature can have is silent: a box that
// draws round the wrong word, or stays put while the words move on, still
// renders as something. So this one reads the canvas. A caption of three words,
// each said for 0.4 s, is put in the Word box look through the real Captions
// tab, the playhead is set inside each word in turn, and the monitor is
// photographed. The border colour (#C02749) is the only crimson on the frame,
// so its pixels are the box, and their centre must walk right with the speaker.
//
// The speech model is the one thing stood in for: the words are handed to the
// caption door, as captions-tab.spec.ts does. Everything else is the real tab,
// the real store and the real renderer.
//
// ⚠️ THE PICTURE IS READ BACK FROM THE PNG IT SAVES, not from the canvas, so the
// file left on disk is exactly what was judged. Where the PNGs land can be set
// with WORDBOX_SHOTS; it defaults to a folder under the system temp directory.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parkModules, setUI, type ParkedWindow } from './storeWrites'

const SHOTS = process.env.WORDBOX_SHOTS ?? join(tmpdir(), 'olp-wordbox')

/** The border of the box on his frame. The only crimson anywhere on the monitor. */
const CRIMSON = { rMin: 140, gMax: 75, bMin: 45, bMax: 110, rOverG: 90 }

/** Fewest crimson pixels that count as a box. The monitor is small, so a border is a pixel or two thick. */
const MIN_CRIMSON = 30

/** How far right the box centre must move from one word to the next, in monitor pixels. */
const MIN_STEP = 8

type Reading = {
  /** Pixels that are the box border's crimson. */
  crimson: number
  /** Their mean x in the saved picture, or -1 when there are none. */
  cx: number
  /** Near white pixels: the letters, so a frame with a caption on it can be told from an empty one. */
  bright: number
}

/** Three words, 0.4 s each, as the speech model would hand them over. */
async function addWords(page: Page): Promise<void> {
  await parkModules(page, ['/src/state/captionActions.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const capMod = '/src/state/captionActions.ts'
    const { addCaptionsFromWords } = mods[capMod] as { addCaptionsFromWords: (w: unknown[]) => void }
    addCaptionsFromWords([
      { text: 'AWAKE', startS: 0, endS: 0.4 },
      { text: "DOESN'T", startS: 0.4, endS: 0.8 },
      { text: 'REALLY', startS: 0.8, endS: 1.2 },
    ])
  })
}

/** The text of every caption on the Captions track, in time order. */
async function captionTexts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const capMod = '/src/state/captionActions.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { captionsOn } = (await import(/* @vite-ignore */ capMod)) as {
      captionsOn: (seq: unknown) => { clip: { title: { text: string } } }[]
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => unknown }
    return captionsOn(activeSequence(useStore.getState().project)).map(({ clip }) => clip.title.text)
  })
}

/** Photograph the program monitor to `file`, then count the box and the letters in that very picture. */
async function read(page: Page, file: string): Promise<Reading> {
  const png = await page.getByTestId('program-canvas').screenshot({ path: file })
  return page.evaluate(
    async ({ b64, crimson }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const scratch = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      let count = 0
      let sumX = 0
      let bright = 0
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const i = (y * bitmap.width + x) * 4
          const r = d[i]!
          const g = d[i + 1]!
          const b = d[i + 2]!
          if (r > crimson.rMin && g < crimson.gMax && b > crimson.bMin && b < crimson.bMax && r - g > crimson.rOverG) {
            count += 1
            sumX += x
          }
          if (r > 200 && g > 200 && b > 200) bright += 1
        }
      }
      return { crimson: count, cx: count > 0 ? sumX / count : -1, bright }
    },
    { b64: png.toString('base64'), crimson: CRIMSON },
  )
}

type BoxReading = {
  /** Pixels that are the box border's crimson. */
  crimson: number
  /** The crimson box's bounds in the saved picture, inclusive. */
  x0: number
  x1: number
  y0: number
  y1: number
  /** How thick the left border is, counted along the box's middle row. */
  border: number
  /** Near white pixels in the columns inside the border: the boxed word's letters. */
  bright: number
  /** The top and bottom row of those letters, or -1 when there are none. */
  inkTop: number
  inkBottom: number
}

/** Photograph the program monitor to `file`, then find the box and the boxed word's letters in that very picture. */
async function readBox(page: Page, file: string): Promise<BoxReading> {
  const png = await page.getByTestId('program-canvas').screenshot({ path: file })
  return page.evaluate(
    async ({ b64, crimson }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const scratch = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const W = bitmap.width
      const H = bitmap.height
      const d = ctx.getImageData(0, 0, W, H).data
      const isCrimson = (x: number, y: number): boolean => {
        const i = (y * W + x) * 4
        const r = d[i]!
        const g = d[i + 1]!
        const b = d[i + 2]!
        return r > crimson.rMin && g < crimson.gMax && b > crimson.bMin && b < crimson.bMax && r - g > crimson.rOverG
      }
      const isBright = (x: number, y: number): boolean => {
        const i = (y * W + x) * 4
        return d[i]! > 200 && d[i + 1]! > 200 && d[i + 2]! > 200
      }
      let count = 0
      let x0 = W
      let x1 = -1
      let y0 = H
      let y1 = -1
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!isCrimson(x, y)) continue
          count += 1
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      const out = { crimson: count, x0, x1, y0, y1, border: 0, bright: 0, inkTop: -1, inkBottom: -1 }
      if (count === 0) return out
      const mid = Math.round((y0 + y1) / 2)
      let border = 0
      for (let x = x0; x <= x1 && isCrimson(x, mid); x++) border += 1
      out.border = border
      // The columns inside the border, so a neighbouring word's ink is never counted.
      // Every row of the frame is read, so a letter that hangs out of the box is found.
      for (let y = 0; y < H; y++) {
        for (let x = x0 + border; x <= x1 - border; x++) {
          if (!isBright(x, y)) continue
          out.bright += 1
          if (out.inkTop < 0) out.inkTop = y
          out.inkBottom = y
        }
      }
      return out
    },
    { b64: png.toString('base64'), crimson: CRIMSON },
  )
}

/** Open the Captions tab with the style editor unfolded, the way he does. */
async function openStyleEditor(page: Page): Promise<void> {
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('caption-row')).not.toHaveCount(0)
  await page.getByTestId('captions-style-fold').click()
  await expect(page.getByTestId('caption-style-select')).toBeVisible()
}

test('the Word box style walks a crimson box along the words as they are said', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.goto('/')
  await addWords(page)

  await openStyleEditor(page)
  await page.getByTestId('caption-style-select').selectOption('builtin-word-box')
  await page.getByTestId('caption-style-apply-all').click()

  // The style is three words a caption, so the whole line is one caption.
  await expect
    .poll(async () => (await captionTexts(page)).map((t) => t.toLowerCase()), { timeout: 15_000 })
    .toEqual(["awake doesn't really"])

  // Inside AWAKE, inside DOESN'T, inside REALLY.
  const times = [0.2, 0.6, 1.0]
  const seen: Reading[] = []
  for (const [i, t] of times.entries()) {
    await setUI(page, { playheadS: t, selection: [] })
    const before = seen[i - 1]
    let last: Reading = { crimson: 0, cx: -1, bright: 0 }
    // The monitor repaints after the seek, and the first frame may also wait on the
    // font. So poll for a frame with a box that has moved on from the last word's.
    await expect
      .poll(
        async () => {
          last = await read(page, join(SHOTS, `wordbox-${i}.png`))
          return last.crimson >= MIN_CRIMSON && (before === undefined || last.cx > before.cx + MIN_STEP)
        },
        { timeout: 20_000, message: `no crimson box to the right of word ${i} at ${t} s` },
      )
      .toBe(true)
    seen.push(last)
    console.log(`[word box] t=${t} s: ${last.crimson} crimson pixels, centre x ${last.cx.toFixed(1)}, ${last.bright} letter pixels`)
  }

  // The box is an overlay: the letters are on the frame in all three, and the box moves, not the line.
  for (const r of seen) expect(r.bright, 'the letters are missing from a frame').toBeGreaterThan(20)
  expect(seen[1]!.cx).toBeGreaterThan(seen[0]!.cx + MIN_STEP)
  expect(seen[2]!.cx).toBeGreaterThan(seen[1]!.cx + MIN_STEP)
})

// The box's bottom edge was once a fixed margin under the baseline, so the tail of
// a g, y or p reached the box's outer edge and its outline stuck out past it. Only
// a lowercase word shows that, so this frame turns the Word box style's capitals off.
test('the Word box goes round the tail of a lowercase g, not through it', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.goto('/')
  await parkModules(page, ['/src/state/captionActions.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const { addCaptionsFromWords } = mods['/src/state/captionActions.ts'] as { addCaptionsFromWords: (w: unknown[]) => void }
    addCaptionsFromWords([
      { text: 'we', startS: 0, endS: 0.4 },
      { text: 'are', startS: 0.4, endS: 0.8 },
      { text: 'going', startS: 0.8, endS: 1.2 },
    ])
  })
  // Inside "going".
  await setUI(page, { playheadS: 1.0, selection: [] })

  await openStyleEditor(page)
  await page.getByTestId('caption-style-select').selectOption('builtin-word-box')
  await page.getByTestId('caption-style-case-lower').click()
  await page.getByTestId('caption-style-apply-all').click()
  await expect.poll(async () => captionTexts(page), { timeout: 15_000 }).toEqual(['we are going'])

  // Wait for a frame with the box and its word on it that holds still (the font may swap in late).
  const shot = join(SHOTS, 'wordbox-descender.png')
  let last = null as BoxReading | null
  let r = null as BoxReading | null
  await expect
    .poll(
      async () => {
        last = r
        r = await readBox(page, shot)
        return r.crimson >= MIN_CRIMSON && r.bright > 20 && JSON.stringify(r) === JSON.stringify(last)
      },
      { timeout: 20_000, message: 'no steady frame with a crimson box round "going"' },
    )
    .toBe(true)
  const box = r!
  console.log(
    `[word box] going: box rows ${box.y0} to ${box.y1}, border ${box.border}, ink rows ${box.inkTop} to ${box.inkBottom}`,
  )

  expect(box.border, 'no border found on the box').toBeGreaterThan(0)
  // Every white pixel of the word is inside the box's rows, the tail of the g too.
  expect(box.inkTop).toBeGreaterThanOrEqual(box.y0)
  expect(box.inkBottom, 'the tail of the g hangs out of the box').toBeLessThanOrEqual(box.y1)
  // And it stays off the crimson border: the letters sit inside it, as the caps do.
  expect(box.inkBottom, 'the tail of the g sits on the crimson border').toBeLessThan(box.y1 - box.border)
})

test('the Word box switch puts the box on the house style, and off by default', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.goto('/')
  await addWords(page)
  await setUI(page, { playheadS: 0.6, selection: [] })
  const shot = join(SHOTS, 'wordbox-toggle.png')

  // The control: the house look has letters on the frame and no crimson anywhere.
  await expect.poll(async () => (await read(page, shot)).bright, { timeout: 20_000 }).toBeGreaterThan(20)
  expect((await read(page, shot)).crimson, 'crimson on the frame before the switch is on').toBe(0)

  await openStyleEditor(page)
  await page.getByTestId('caption-style-word-box').check()
  await page.getByTestId('caption-style-apply-all').click()

  await expect.poll(async () => (await read(page, shot)).crimson, { timeout: 20_000 }).toBeGreaterThanOrEqual(MIN_CRIMSON)
})
