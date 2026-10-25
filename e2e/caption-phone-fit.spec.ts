// The caption breaks the same way in the Phone monitor as in the export.
//
// The bug, 2026-10-20: in the Phone frame (1080 x 2112) the Word box caption
// "AWAKE DOESN'T REALLY" was laid out on one line by the fitter and drawn on one
// line in the export, but the program monitor drew it on two. The monitor draws
// titles at a fraction of the sequence size, and rounding the font size at that
// fraction made the line a hair too wide for the box, so it wrapped there only.
// The raster now decides the line breaks at the export size and keeps them at
// every scale (titleLinesAt in titleRaster.ts).
//
// Two checks here, both in the real app in a real browser.
//   1. The Phone frame, the Word box style through the real Captions tab, and the
//      program monitor photographed: the white letters must sit in one band of rows.
//   2. The fitter never draws text: it adds up a metrics table (captionTextWidthPx).
//      That table must agree with what this browser really measures for the three
//      caption faces, Montserrat, Lilita One and Oswald, within half a pixel at
//      100 px. If a font file is ever swapped, this is the test that says so.
//
// The speech model is the one thing stood in for: the words are handed to the
// caption door, as caption-word-box.spec.ts does.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parkModules, setUI, type ParkedWindow } from './storeWrites'

const SHOTS = process.env.PHONEFIT_SHOTS ?? join(tmpdir(), 'olp-phone-fit')

const PHONE_W = 1080
const PHONE_H = 2112

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

/** The sequence size, and the text of every caption on the Captions track in time order. */
async function captionState(page: Page): Promise<{ w: number; h: number; texts: string[] }> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const capMod = '/src/state/captionActions.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { captionsOn } = (await import(/* @vite-ignore */ capMod)) as {
      captionsOn: (seq: unknown) => { clip: { title: { text: string } } }[]
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { width: number; height: number }
    }
    const seq = activeSequence(useStore.getState().project)
    return { w: seq.width, h: seq.height, texts: captionsOn(seq).map(({ clip }) => clip.title.text) }
  })
}

type Bands = {
  /** The monitor picture's size. */
  W: number
  H: number
  /** Near white pixels anywhere: the letters. */
  bright: number
  /** Each run of rows that holds letters, top and bottom row inclusive. */
  bands: { top: number; bottom: number }[]
}

/**
 * Photograph the program monitor to `file`, then find the rows the white letters
 * sit in. The caption is in capitals, so every row of a line from the cap top to
 * the baseline holds white, and the only rows without any are the ones between
 * two lines. In the monitor the leading is tight (two or three rows), so any
 * empty row splits a band.
 */
async function readBands(page: Page, file: string): Promise<Bands> {
  const png = await page.getByTestId('program-canvas').screenshot({ path: file })
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const scratch = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const W = bitmap.width
    const H = bitmap.height
    const d = ctx.getImageData(0, 0, W, H).data
    const rows: number[] = []
    let bright = 0
    for (let y = 0; y < H; y++) {
      let n = 0
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (d[i]! > 200 && d[i + 1]! > 200 && d[i + 2]! > 200) n += 1
      }
      bright += n
      if (n >= 2) rows.push(y)
    }
    const runs: { top: number; bottom: number }[] = []
    for (const y of rows) {
      const last = runs[runs.length - 1]
      if (last && y === last.bottom + 1) last.bottom = y
      else runs.push({ top: y, bottom: y })
    }
    // A run under three rows is a speck, not a line of capitals.
    const bands = runs.filter((r) => r.bottom - r.top >= 2)
    return { W, H, bright, bands }
  }, png.toString('base64'))
}

/** Open the Captions tab with the style editor unfolded, the way he does. */
async function openStyleEditor(page: Page): Promise<void> {
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('caption-row')).not.toHaveCount(0)
  await page.getByTestId('captions-style-fold').click()
  await expect(page.getByTestId('caption-style-select')).toBeVisible()
}

test('the Word box caption AWAKE DOESN\'T REALLY is one line in the Phone monitor', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.goto('/')
  await page.getByTestId('format-select').selectOption('phone')
  await expect.poll(async () => {
    const s = await captionState(page)
    return [s.w, s.h]
  }).toEqual([PHONE_W, PHONE_H])

  await addWords(page)
  await openStyleEditor(page)
  await page.getByTestId('caption-style-select').selectOption('builtin-word-box')
  await page.getByTestId('caption-style-apply-all').click()

  // The style is three words a caption, so the whole line is one caption.
  await expect
    .poll(async () => (await captionState(page)).texts.map((t) => t.toLowerCase()), { timeout: 15_000 })
    .toEqual(["awake doesn't really"])

  // Make sure the face the monitor draws with is in, so the photo is of Oswald.
  await page.evaluate(async () => {
    const fontsMod = '/src/engine/render/titleFonts.ts'
    const { ensureTitleFont, OSWALD_STACK } = (await import(/* @vite-ignore */ fontsMod)) as {
      ensureTitleFont: (f: FontFaceSet, stack: string) => Promise<void>
      OSWALD_STACK: string
    }
    await ensureTitleFont(document.fonts, OSWALD_STACK)
  })

  // Inside DOESN'T: the caption is up, with the box round the middle word.
  await setUI(page, { playheadS: 0.6, selection: [] })

  let last: Bands = { W: 0, H: 0, bright: 0, bands: [] }
  const file = join(SHOTS, 'phone-wordbox.png')
  // The monitor repaints after the seek and may wait on the font, so poll until
  // the caption is drawn and the reading holds still for two frames in a row.
  let prev = ''
  await expect
    .poll(
      async () => {
        last = await readBands(page, file)
        const now = JSON.stringify(last.bands)
        const steady = last.bright > 50 && now === prev
        prev = now
        return steady
      },
      { timeout: 20_000, message: 'the caption never settled in the monitor' },
    )
    .toBe(true)
  console.log(`[phone fit] monitor ${last.W}x${last.H}, letter bands ${JSON.stringify(last.bands)}, photo ${file}`)
  // The monitor is the Phone frame's shape, so this photo is of the Phone layout.
  expect(Math.abs(last.W / last.H - PHONE_W / PHONE_H) * last.H).toBeLessThan(2)
  expect(last.bands, 'the caption is drawn on more than one line in the monitor').toHaveLength(1)
})

test('the fitter\'s width table matches what this browser measures for Montserrat, Lilita One and Oswald', async ({ page }) => {
  await page.goto('/')
  const rows = await page.evaluate(async () => {
    const fitMod = '/src/engine/captions/captionFit.ts'
    const styleMod = '/src/engine/captions/captionStyle.ts'
    const fontsMod = '/src/engine/render/titleFonts.ts'
    const { captionTextWidthPx } = (await import(/* @vite-ignore */ fitMod)) as {
      captionTextWidthPx: (text: string, px: number, family?: string) => number
    }
    type Def = { fontFamily: string; bold?: boolean; italic?: boolean; textCase?: string }
    const { BUILTIN_CAPTION_STYLES, captionDefFor } = (await import(/* @vite-ignore */ styleMod)) as {
      BUILTIN_CAPTION_STYLES: { id: string }[]
      captionDefFor: (style: unknown, text: string, seqHeight: number) => Def
    }
    const { ensureTitleFont } = (await import(/* @vite-ignore */ fontsMod)) as {
      ensureTitleFont: (f: FontFaceSet, stack: string) => Promise<void>
    }
    // One built in style per face: the house look is Montserrat, Oveon is Lilita One, Word box is Oswald.
    const ids = ['house', 'builtin-oveon', 'builtin-word-box']
    const samples = [
      "awake doesn't really",
      'The quick brown fox jumps over the lazy dog',
      'Wow, we WON in Prague! 1,234 views?',
      'diamonds MAMA office home WWW',
      'Příliš žluťoučký kůň úpěl ďábelské ódy',
    ]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const out: { id: string; family: string; font: string; status: string; text: string; table: number; real: number }[] = []
    for (const s of BUILTIN_CAPTION_STYLES) {
      if (!ids.includes(s.id)) continue
      const def = captionDefFor(s, '', 1920)
      await ensureTitleFont(document.fonts, def.fontFamily)
      // The same font string titleRaster.ts draws with (fontString), at 100 px.
      const font = `${def.italic ? 'italic ' : ''}${def.bold ? '700' : '400'} 100px ${def.fontFamily}`
      await document.fonts.load(font, samples.join(' '))
      const family = def.fontFamily.split(',')[0]!.replace(/'/g, '').trim()
      const faces = [...document.fonts].filter((f) => f.family.replace(/['"]/g, '') === family).map((f) => f.status)
      ctx.font = font
      for (const raw of samples) {
        const text = def.textCase === 'upper' ? raw.toUpperCase() : def.textCase === 'lower' ? raw.toLowerCase() : raw
        out.push({
          id: s.id,
          family,
          font,
          status: faces.join(',') || 'none',
          text,
          table: captionTextWidthPx(text, 100, def.fontFamily),
          real: ctx.measureText(text).width,
        })
      }
    }
    return out
  })
  for (const r of rows) console.log(`[width table] ${r.family} ${JSON.stringify(r.text)} table ${r.table.toFixed(2)} real ${r.real.toFixed(2)}`)
  // Every face was found and loaded, so the real width is the real font's, not the fallback's.
  expect(new Set(rows.map((r) => r.family))).toEqual(new Set(['Montserrat', 'Lilita One', 'Oswald']))
  for (const r of rows) {
    expect(r.status, `${r.family} was not loaded, so it was measured on the fallback`).toMatch(/^loaded(,loaded)*$/)
    expect(Math.abs(r.table - r.real), `${r.family} ${JSON.stringify(r.text)}: table ${r.table}, browser ${r.real}`).toBeLessThanOrEqual(0.5)
  }
})
