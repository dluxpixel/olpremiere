// The size pop, read off real pixels at full size.
//
// His words, 2026-10-08: captions where "each word lights up as said, colour and a
// small pop". The colour was there; the pop is the part this file looks at. The
// unit tests read numbers (how big, when) and a fake canvas. None of them can see
// what the user would see, and the failures this feature can have are quiet ones:
// a word that grows but drags its neighbours with it, a pop that never happens in
// the real raster, a word that grows right off the edge of the picture.
//
// So this goes through the real Captions tab (the "Pop the word" row), resolves
// the frame the monitor and the export both draw (resolveFrame), and rasterizes
// its caption with the very rasterizer the export uses, at the sequence size, in
// this browser with the real Oswald. Two moments inside the same word are
// compared: 0.1 s in (the top of the pop) and 0.3 s in (settled, the word is its
// plain size again).
//
//   the word being said     its white letters are about 15 percent wider and
//                           taller at the top of the pop than settled
//   the words around it     their white letters are the same pixels in both, with the
//                           word box ON: its swollen box may sit under them, and the
//                           letters of every word are drawn over it
//   the edge of the picture a word pushed against the edge is held back instead of
//                           growing out of the picture
//
// The speech model is the one thing stood in for: the words are handed to the
// caption door, as caption-word-box.spec.ts does.

import { expect, test, type Page } from '@playwright/test'
import { parkModules, setUI, type ParkedWindow } from './storeWrites'

/** The pop the Captions tab starts on, and the size the unit tests pin. */
const POP = 1.15

/** How far in from the edge the edge test puts the white of the last word, in sequence pixels. */
const EDGE_GAP = 6

type Ink = { a: number; b: number; top: number; bottom: number }

type PopReading = {
  W: number
  H: number
  fontFamily: string
  oswaldFaces: string[]
  oswaldUsable: boolean
  /** The word the frame says is popping, and its size (null when the frame is the plain title). */
  peak: { at: number | null; scale: number | null }
  settled: { at: number | null; scale: number | null }
  /** The columns each word's white letters take on the settled frame, left to right. */
  words: { a: number; b: number }[]
  /** The popping word's white letters: the box they fill, at the top of the pop and settled. */
  popped: { peak: Ink; settled: Ink }
  /**
   * For each other word, across its columns: the white letter pixels it holds on the settled frame,
   * how many of them are not the very same pixel on the peak frame (a white pixel that went, came, or
   * changed colour), and how many other pixels differ (the box swelling under it, which is allowed).
   */
  neighbours: { index: number; white: number; changed: number; under: number }[]
  /** Opaque white pixels on the outermost ring of the picture, on each frame. */
  ring: { peak: number; settled: number }
}

/** Three words, 0.4 s each, as the speech model would hand them over. */
async function addWords(page: Page): Promise<void> {
  await parkModules(page, ['/src/state/captionActions.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const { addCaptionsFromWords } = mods['/src/state/captionActions.ts'] as { addCaptionsFromWords: (w: unknown[]) => void }
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

/**
 * Three words on one caption, in white letters on the Word box look with its box
 * left ON, popping 15 percent: at the top of the pop the box swells and reaches
 * under the words beside it, and the letters of every word are drawn over it. Then
 * the "Pop the word" row is switched off and on again so it comes back at its own
 * default.
 */
async function setUpPopCaption(page: Page): Promise<void> {
  await page.goto('/')
  await addWords(page)
  await setUI(page, { playheadS: 0.6, selection: [] })

  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('caption-row')).not.toHaveCount(0)
  await page.getByTestId('captions-style-fold').click()
  await expect(page.getByTestId('caption-style-select')).toBeVisible()
  await page.getByTestId('caption-style-select').selectOption('builtin-word-box')
  // The box stays on: the look as he gets it, and the case this file must prove.
  await expect(page.getByTestId('caption-style-word-box')).toBeChecked()

  await page.getByTestId('caption-style-word-pop-size').uncheck()
  await expect(page.getByTestId('caption-style-word-pop-size-value')).toHaveCount(0)
  await page.getByTestId('caption-style-word-pop-size').check()
  await expect(page.getByTestId('caption-style-word-pop-size-value')).toHaveValue(POP.toFixed(2))

  await page.getByTestId('caption-style-apply-all').click()
  await expect
    .poll(async () => (await captionTexts(page)).map((t) => t.toLowerCase()), { timeout: 15_000 })
    .toEqual(["awake doesn't really"])
}

/**
 * Rasterize the caption at `tPeak` and at `tSettled` (both inside the same word),
 * at the sequence size, and measure what differs. With `edgeGapPx` set, the whole
 * line is first slid right until the white of its last word ends that many pixels
 * from the right edge of the picture.
 */
async function readPop(
  page: Page,
  o: { tPeak: number; tSettled: number; popIndex: number; edgeGapPx: number | null },
): Promise<PopReading | null> {
  return page.evaluate(
    async ({ tPeak, tSettled, popIndex, edgeGapPx }) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const resolveMod = '/src/engine/render/resolve.ts'
      const rasterMod = '/src/engine/render/titleRaster.ts'
      const fontsMod = '/src/engine/render/titleFonts.ts'
      type Title = {
        fontFamily: string
        offsetXPx?: number
        popWord?: { at: number; word: string; scale: number }
      }
      type Op = { type: string; layer?: { title?: Title } }
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => unknown }
      const { resolveFrame } = (await import(/* @vite-ignore */ resolveMod)) as {
        resolveFrame: (seq: unknown, t: number) => { width: number; height: number; ops: Op[] }
      }
      const { rasterizeTitle } = (await import(/* @vite-ignore */ rasterMod)) as {
        rasterizeTitle: (title: Title, w: number, h: number) => OffscreenCanvas
      }
      const { ensureTitleFont } = (await import(/* @vite-ignore */ fontsMod)) as {
        ensureTitleFont: (fs: FontFaceSet, stack: string) => Promise<void>
      }

      const seq = activeSequence(useStore.getState().project)
      const frameAt = (t: number) => resolveFrame(seq, t)
      const titleOf = (ops: Op[]): Title | undefined => ops.map((op) => (op.type === 'layer' ? op.layer?.title : undefined)).find((x) => x)
      const peakFrame = frameAt(tPeak)
      let peakTitle = titleOf(peakFrame.ops)
      let settledTitle = titleOf(frameAt(tSettled).ops)
      if (!peakTitle || !settledTitle) return null
      const W = peakFrame.width
      const H = peakFrame.height

      // The real font, loaded for sure: a pop measured on the fallback face would prove little.
      await ensureTitleFont(document.fonts, peakTitle.fontFamily)
      const oswald: FontFace[] = []
      document.fonts.forEach((f) => {
        if (f.family.replace(/^["']|["']$/g, '') === 'Oswald') oswald.push(f)
      })
      await Promise.all(oswald.map((f) => f.load().catch(() => null)))

      const pixels = (title: Title): Uint8ClampedArray => rasterizeTitle(title, W, H).getContext('2d')!.getImageData(0, 0, W, H).data
      const isWhite = (d: Uint8ClampedArray, i: number): boolean => d[i + 3]! > 240 && d[i]! > 200 && d[i + 1]! > 200 && d[i + 2]! > 200

      // The columns that hold a white letter, in runs; the widest gaps between runs are the spaces.
      const wordColumns = (d: Uint8ClampedArray, words: number): { a: number; b: number }[] => {
        const lit = new Uint8Array(W)
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) if (isWhite(d, (y * W + x) * 4)) lit[x] = 1
        }
        const runs: { a: number; b: number }[] = []
        for (let x = 0; x < W; x++) {
          if (!lit[x]) continue
          const last = runs[runs.length - 1]
          if (last && last.b === x - 1) last.b = x
          else runs.push({ a: x, b: x })
        }
        if (runs.length < words) return []
        const cuts = runs
          .slice(1)
          .map((r, i) => ({ before: i + 1, width: r.a - runs[i]!.b - 1 }))
          .sort((p, q) => q.width - p.width)
          .slice(0, words - 1)
          .map((g) => g.before)
          .sort((p, q) => p - q)
        const bounds = [0, ...cuts, runs.length]
        return Array.from({ length: words }, (_, k) => ({ a: runs[bounds[k]!]!.a, b: runs[bounds[k + 1]! - 1]!.b }))
      }

      const WORDS = 3
      if (edgeGapPx !== null) {
        const probe = wordColumns(pixels(settledTitle), WORDS)
        if (probe.length !== WORDS) return null
        const dx = W - 1 - edgeGapPx - probe[WORDS - 1]!.b
        peakTitle = { ...peakTitle, offsetXPx: (peakTitle.offsetXPx ?? 0) + dx }
        settledTitle = { ...settledTitle, offsetXPx: (settledTitle.offsetXPx ?? 0) + dx }
      }

      const peak = pixels(peakTitle)
      const settled = pixels(settledTitle)
      const words = wordColumns(settled, WORDS)
      if (words.length !== WORDS) return null

      // The popping word's own white letters: the columns between its neighbours.
      const c0 = popIndex > 0 ? words[popIndex - 1]!.b + 1 : 0
      const c1 = popIndex < WORDS - 1 ? words[popIndex + 1]!.a - 1 : W - 1
      const inkIn = (d: Uint8ClampedArray): Ink => {
        const ink = { a: W, b: -1, top: H, bottom: -1 }
        for (let y = 0; y < H; y++) {
          for (let x = c0; x <= c1; x++) {
            if (!isWhite(d, (y * W + x) * 4)) continue
            if (x < ink.a) ink.a = x
            if (x > ink.b) ink.b = x
            if (y < ink.top) ink.top = y
            if (y > ink.bottom) ink.bottom = y
          }
        }
        return ink
      }

      // A neighbour's letters are its white pixels. The box of the popping word may sit under them, so a
      // pixel that is not white on either frame is only counted as "under"; a pixel that is white on
      // either frame must be the very same white on both.
      const neighbours: { index: number; white: number; changed: number; under: number }[] = []
      for (let k = 0; k < WORDS; k++) {
        if (k === popIndex) continue
        let white = 0
        let changed = 0
        let under = 0
        for (let y = 0; y < H; y++) {
          for (let x = words[k]!.a; x <= words[k]!.b; x++) {
            const i = (y * W + x) * 4
            const wp = isWhite(peak, i)
            const ws = isWhite(settled, i)
            if (ws) white += 1
            const same = peak[i] === settled[i] && peak[i + 1] === settled[i + 1] && peak[i + 2] === settled[i + 2] && peak[i + 3] === settled[i + 3]
            if (wp || ws) {
              if (wp !== ws || !same) changed += 1
            } else if (!same) {
              under += 1
            }
          }
        }
        neighbours.push({ index: k, white, changed, under })
      }

      const ringWhite = (d: Uint8ClampedArray): number => {
        let n = 0
        for (let x = 0; x < W; x++) {
          if (isWhite(d, x * 4)) n += 1
          if (isWhite(d, ((H - 1) * W + x) * 4)) n += 1
        }
        for (let y = 1; y < H - 1; y++) {
          if (isWhite(d, (y * W) * 4)) n += 1
          if (isWhite(d, (y * W + W - 1) * 4)) n += 1
        }
        return n
      }

      return {
        W,
        H,
        fontFamily: peakTitle.fontFamily,
        oswaldFaces: oswald.map((f) => f.status),
        oswaldUsable: document.fonts.check('700 40px Oswald'),
        peak: { at: peakTitle.popWord?.at ?? null, scale: peakTitle.popWord?.scale ?? null },
        settled: { at: settledTitle.popWord?.at ?? null, scale: settledTitle.popWord?.scale ?? null },
        words,
        popped: { peak: inkIn(peak), settled: inkIn(settled) },
        neighbours,
        ring: { peak: ringWhite(peak), settled: ringWhite(settled) },
      }
    },
    o,
  )
}

/** Poll until the caption is restyled and both frames can be read, then hand back that reading. */
async function settledReading(
  page: Page,
  o: { tPeak: number; tSettled: number; popIndex: number; edgeGapPx: number | null },
): Promise<PopReading> {
  let last: PopReading | null = null
  await expect
    .poll(
      async () => {
        last = await readPop(page, o)
        return last !== null && last.peak.scale !== null
      },
      { timeout: 20_000, message: `no popping word at ${o.tPeak} s` },
    )
    .toBe(true)
  return last!
}

function expectRealFont(r: PopReading): void {
  expect(r.fontFamily, 'the caption is not set in Oswald').toContain('Oswald')
  expect(r.oswaldFaces.length, 'no face is registered as Oswald, so this was measured on the fallback font').toBeGreaterThan(0)
  expect(r.oswaldFaces, 'an Oswald face had not finished loading').toEqual(r.oswaldFaces.map(() => 'loaded'))
  expect(r.oswaldUsable, 'the browser does not offer bold Oswald').toBe(true)
}

function widthOf(ink: Ink): number {
  return ink.b - ink.a + 1
}
function heightOf(ink: Ink): number {
  return ink.bottom - ink.top + 1
}

test('the word being said grows about 15 percent at the top of the pop and every other word stays put', async ({ page }) => {
  await setUpPopCaption(page)

  // Inside DOESN'T (0.4 s to 0.8 s): 0.1 s in is the top of the pop, 0.3 s in is settled.
  const r = await settledReading(page, { tPeak: 0.5, tSettled: 0.7, popIndex: 1, edgeGapPx: null })
  const wide = widthOf(r.popped.peak) / widthOf(r.popped.settled)
  const tall = heightOf(r.popped.peak) / heightOf(r.popped.settled)
  console.log(
    `[word pop] ${r.W}x${r.H}, scale ${r.peak.scale} then ${r.settled.scale}, letters ${widthOf(r.popped.settled)}x${heightOf(r.popped.settled)} ` +
      `grow to ${widthOf(r.popped.peak)}x${heightOf(r.popped.peak)} (x${wide.toFixed(3)} wide, x${tall.toFixed(3)} tall), ` +
      `neighbours ${r.neighbours.map((n) => `${n.index}: ${n.changed} of ${n.white} white changed, ${n.under} under`).join(', ')}, ring ${r.ring.peak}/${r.ring.settled}`,
  )

  expectRealFont(r)
  // The frame says the second word is popping, at the size the tab set, and says nothing once settled.
  expect(r.peak.at, 'the pop is on the wrong word').toBe(1)
  expect(r.peak.scale!).toBeGreaterThan(POP - 0.01)
  expect(r.peak.scale!).toBeLessThan(POP + 0.01)
  expect(r.settled.scale, 'the word is still marked as popping once it has settled').toBeNull()

  // The letters really are bigger in the raster, by about the amount asked for.
  expect(wide, 'the popping word is not about 15 percent wider').toBeGreaterThan(POP - 0.02)
  expect(wide).toBeLessThan(POP + 0.02)
  expect(tall, 'the popping word is not about 15 percent taller').toBeGreaterThan(POP - 0.04)
  expect(tall).toBeLessThan(POP + 0.04)

  // And the letters of the words either side are the very same white pixels in both: only the popping
  // word moved. The box is ON here, so its swollen shape is allowed under them, never over them.
  expect(r.neighbours.map((n) => n.index)).toEqual([0, 2])
  for (const n of r.neighbours) {
    expect(n.white, `word ${n.index} has no white letters on the settled frame`).toBeGreaterThan(500)
    expect(n.changed, `a white letter of word ${n.index} changed while its neighbour popped, so the box is drawn over it`).toBe(0)
    // The box really did swell under this word, or the line above would pass for nothing.
    expect(n.under, `the swollen box never reached under word ${n.index}`).toBeGreaterThan(0)
  }

  // Nothing of the picture is cut at the edge on either frame.
  expect(r.ring.peak, 'white letters touch the edge of the picture at the top of the pop').toBe(0)
  expect(r.ring.settled).toBe(0)
})

test('a word pushed against the edge of the picture is held back, not grown out of it', async ({ page }) => {
  await setUpPopCaption(page)

  // Inside REALLY (0.8 s to 1.2 s), with the line slid right until REALLY's letters end
  // a few pixels from the edge. Grown by 15 percent about its middle, it would leave.
  const r = await settledReading(page, { tPeak: 0.9, tSettled: 1.1, popIndex: 2, edgeGapPx: EDGE_GAP })
  const wide = widthOf(r.popped.peak) / widthOf(r.popped.settled)
  console.log(
    `[word pop] at the edge: last word ends at ${r.words[2]!.b} of ${r.W - 1}, letters ${widthOf(r.popped.settled)} wide ` +
      `then ${widthOf(r.popped.peak)} (x${wide.toFixed(3)}), ring ${r.ring.peak}/${r.ring.settled}`,
  )

  expectRealFont(r)
  expect(r.peak.at, 'the pop is on the wrong word').toBe(2)
  // The setup really did put the word at the edge, or this would pass for nothing.
  expect(r.words[2]!.b).toBe(r.W - 1 - EDGE_GAP)
  // Held back: not smaller than it was, not the full 15 percent either.
  expect(wide, 'the popping word shrank').toBeGreaterThan(0.99)
  expect(wide, 'the popping word grew as if the edge were not there').toBeLessThan(POP - 0.02)
  // And its white letters end before the last column, on both frames.
  expect(r.popped.peak.b, 'the popping word runs into the edge of the picture').toBeLessThan(r.W - 1)
  expect(r.ring.peak, 'white letters touch the edge of the picture at the top of the pop').toBe(0)
  expect(r.ring.settled).toBe(0)
})
