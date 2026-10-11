// Shorts auto fill (his call 2026-10-08, "Both"): a Shorts project starts in the phone screen shape,
// and wide 16:9 footage fills the tall frame by itself, however it gets there.
//
// What a person would check, in the order they would check it:
//   - the Projects window has a "Shorts project" button next to "New project", and the header still
//     fits its 520 px window with both,
//   - it opens a tall edit (the Phone shape, 1080 x 2112), and his 16:9 clip, added the way he adds
//     one, fills it with no black above or below,
//   - a clip COPIED from a wide edit and pasted into the Shorts project fills it too (the one road
//     in that used to leave bars),
//   - the picture is not stretched: a round thing in the footage is still round, and still centred,
//   - the exported file is exactly the frame's size with no black band, and the same round picture,
//     in the Phone shape AND after switching the project to 9:16.
//
// The source is a real 1920x1080 H.264 clip made with the bundled ffmpeg: a bright disc, radius 150,
// on a blue field. A disc is the cheapest honest test of "not stretched": any squeeze or stretch turns
// it into an oval, and a cover fill of a 1080 tall source shows it 300 x the fill scale across.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { cropdetect, edgeBands, ffmpegAvailable, framePixels, runFfmpeg, videoSizeOf } from './exportHelpers'

test.skip(!ffmpegAvailable(), 'needs the bundled ffmpeg (vendor/ffmpeg), which a fresh worktree does not have')

const VERIFY = '_verify/shorts'
const SRC = `${VERIFY}/disc-1920x1080.mp4`
const PHONE_W = 1080
const PHONE_H = 2112
const SHORTS_H = 1920
/** The disc is 300 px across in a 1080 px tall source; a cover fill scales the picture so that height is the frame's. */
const DISC_OF_HEIGHT = 300 / 1080

// Headless Chromium HAS showSaveFilePicker, and a real OS picker cannot be driven from a test, so the export
// would wait on it for good. Shadowing it takes the documented Firefox path: the file is handed to the
// browser as a download (the same thing e2e/export.spec.ts does).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

test.beforeAll(async () => {
  fs.mkdirSync(VERIFY, { recursive: true })
  const inDisc = 'lte(hypot(X-960,Y-540),150)'
  const r = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i',
    `color=c=0x2060a0:s=1920x1080:r=30:d=2,format=rgb24,geq=r='if(${inDisc},240,32)':g='if(${inDisc},240,96)':b='if(${inDisc},240,160)'`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-shortest', SRC,
  ])
  expect(r.code, r.err.slice(-400)).toBe(0)
})

/** The editor is up. The first page of a run waits on the dev server compiling the app cold. */
const editorUp = (page: Page) => expect(page.getByTestId('panel-left')).toBeVisible({ timeout: 30_000 })

/** Put the disc clip in the bin and on the timeline, the way he does: double click the card. */
async function addDisc(page: Page): Promise<void> {
  await page.getByTestId('media-file-input').setInputFiles(SRC)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** The Projects window from the tab strip's + button, then its Shorts button. */
async function newShortsProject(page: Page): Promise<void> {
  await page.getByTestId('edit-tabs-add').click()
  await page.getByTestId('project-new-shorts').click()
  await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
}

/** The sequence and the project default, and the first clip's resting scale, straight from the store. Read only. */
async function state(page: Page): Promise<{ seqW: number; seqH: number; setW: number; setH: number; scale: number | null }> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { settings: { width: number; height: number } } } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { width: number; height: number; tracks: { clips: { transform: { scale: number } }[] }[] }
    }
    const p = useStore.getState().project
    const seq = activeSequence(p)
    const clip = seq.tracks.flatMap((t) => t.clips)[0]
    return { seqW: seq.width, seqH: seq.height, setW: p.settings.width, setH: p.settings.height, scale: clip ? clip.transform.scale : null }
  })
}

/** What a 1920x1080 picture needs to cover a w x h frame, over what it needs to sit inside it. */
const coverFor = (w: number, h: number): number => Math.max(w / 1920, h / 1080) / Math.min(w / 1920, h / 1080)

interface Disc {
  /** Its bounding box in fractions of the picture's own width and height. */
  w: number
  h: number
  cx: number
  cy: number
  /** Whole rows and columns at each edge that are black. */
  bands: { top: number; bottom: number; left: number; right: number }
}

/** The bright disc is the pixels whose weakest channel is past the middle of the field (32) and the disc (240). */
const DISC_MIN = 136

/** Read the monitor canvas back: where the disc is, how big, and any black band at its four edges. */
async function previewDisc(page: Page): Promise<Disc & { pxW: number; pxH: number }> {
  return page.evaluate(async (min) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const src = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(src, 0, 0)
    const { width: w, height: h } = c
    const d = ctx.getImageData(0, 0, w, h).data
    let x0 = w
    let x1 = -1
    let y0 = h
    let y1 = -1
    const luma = (i: number): number => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (Math.min(d[i], d[i + 1], d[i + 2]) > min) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    const row = (y: number): number => {
      let s = 0
      for (let x = 0; x < w; x++) s += luma((y * w + x) * 4)
      return s / w
    }
    const col = (x: number): number => {
      let s = 0
      for (let y = 0; y < h; y++) s += luma((y * w + x) * 4)
      return s / h
    }
    const run = (n: number, at: (i: number) => number): number => {
      let k = 0
      while (k < n && at(k) <= 24) k++
      return k
    }
    const found = x1 >= x0 && y1 >= y0
    return {
      pxW: w,
      pxH: h,
      w: found ? (x1 - x0 + 1) / w : 0,
      h: found ? (y1 - y0 + 1) / h : 0,
      cx: found ? (x0 + x1 + 1) / 2 / w : 0,
      cy: found ? (y0 + y1 + 1) / 2 / h : 0,
      bands: {
        top: run(h, (i) => row(i)),
        bottom: run(h, (i) => row(h - 1 - i)),
        left: run(w, (i) => col(i)),
        right: run(w, (i) => col(w - 1 - i)),
      },
    }
  }, DISC_MIN)
}

/** The same measure on one decoded frame of an exported file (packed RGB, top row first). */
function fileDisc(rgb: Buffer, w: number, h: number): Disc {
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (Math.min(rgb[i], rgb[i + 1], rgb[i + 2]) > DISC_MIN) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  const found = x1 >= x0 && y1 >= y0
  return {
    w: found ? (x1 - x0 + 1) / w : 0,
    h: found ? (y1 - y0 + 1) / h : 0,
    cx: found ? (x0 + x1 + 1) / 2 / w : 0,
    cy: found ? (y0 + y1 + 1) / 2 / h : 0,
    bands: { top: 0, bottom: 0, left: 0, right: 0 },
  }
}

/** The disc is round (its box is as wide as tall in real pixels), the size the fill math says, and in the middle. */
function expectRoundAndCentred(disc: Disc, frameW: number, frameH: number, label: string): void {
  const widthPx = disc.w * frameW
  const heightPx = disc.h * frameH
  expect(widthPx / heightPx, `${label}: ratio of width to height`).toBeGreaterThan(0.99)
  expect(widthPx / heightPx, `${label}: ratio of width to height`).toBeLessThan(1.01)
  // A cover fill of a source 1080 tall puts its 300 px disc at 300/1080 of the frame's height.
  expect(Math.abs(disc.h - DISC_OF_HEIGHT), `${label}: disc height share ${disc.h}`).toBeLessThan(0.01)
  expect(Math.abs(disc.cx - 0.5), `${label}: centred across ${disc.cx}`).toBeLessThan(0.01)
  expect(Math.abs(disc.cy - 0.5), `${label}: centred down ${disc.cy}`).toBeLessThan(0.01)
}

/** Poll until the monitor has drawn the disc, then return it. */
async function drawnDisc(page: Page): Promise<Disc & { pxW: number; pxH: number }> {
  await expect.poll(async () => (await previewDisc(page)).h > 0, { timeout: 20_000 }).toBe(true)
  return previewDisc(page)
}

test('the Projects window has a Shorts project button, and both buttons fit the header', async ({ page }) => {
  await page.goto('/')
  await editorUp(page)
  await page.getByTestId('edit-tabs-add').click()
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  const shorts = page.getByTestId('project-new-shorts')
  await expect(shorts).toHaveText('Shorts project')
  await expect(page.getByTestId('project-new')).toHaveText('New project')

  // Nothing is pushed past the window's right edge, and nothing wraps or clips inside the header.
  const box = (await dialog.boundingBox())!
  for (const id of ['project-new-shorts', 'project-new', 'projects-tab-active', 'projects-tab-later', 'projects-tab-archived']) {
    const b = (await page.getByTestId(id).boundingBox())!
    expect(b.x, `${id} starts inside`).toBeGreaterThanOrEqual(box.x)
    expect(b.x + b.width, `${id} ends inside`).toBeLessThanOrEqual(box.x + box.width + 0.5)
  }
  const header = dialog.locator('> div').first()
  const fits = await header.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  expect(fits, 'header content fits its width').toBe(true)
  // The two buttons do not overlap each other or the tabs.
  const a = (await shorts.boundingBox())!
  const bNew = (await page.getByTestId('project-new').boundingBox())!
  const tabs = (await page.getByTestId('projects-tab-archived').boundingBox())!
  expect(a.x + a.width).toBeLessThanOrEqual(bNew.x)
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(a.x)
})

test('a Shorts project opens tall, and a 16:9 clip added to it fills the frame with a round disc, no band', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await editorUp(page)
  // A plain new project is still wide, and the Shorts one is the Phone shape in the sequence AND the project default.
  expect(await state(page)).toMatchObject({ seqW: 1920, seqH: 1080 })
  await newShortsProject(page)
  expect(await state(page)).toMatchObject({ seqW: PHONE_W, seqH: PHONE_H, setW: PHONE_W, setH: PHONE_H })
  await expect(page.getByTestId('format-select')).toHaveValue('phone')

  await addDisc(page)
  expect((await state(page)).scale).toBeCloseTo(coverFor(PHONE_W, PHONE_H), 6)

  const disc = await drawnDisc(page)
  expect(disc.bands).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  expect(Math.abs(disc.pxW / disc.pxH - PHONE_W / PHONE_H) * disc.pxH).toBeLessThan(1.5)
  expectRoundAndCentred(disc, disc.pxW, disc.pxH, 'preview')
})

test('a clip copied from a wide edit and pasted into a Shorts project fills it', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await editorUp(page)
  // The wide edit he starts in: the clip is its own size, 1:1, with the frame around it.
  await addDisc(page)
  expect((await state(page)).scale).toBeCloseTo(1, 6)
  await page.locator('[data-clip-kind="video"]').click()
  await page.keyboard.press('Control+c')

  await newShortsProject(page)
  await expect(page.locator('[data-clip-kind]')).toHaveCount(0)
  await page.keyboard.press('Control+v')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  expect(await state(page)).toMatchObject({ seqW: PHONE_W, seqH: PHONE_H })
  expect((await state(page)).scale).toBeCloseTo(coverFor(PHONE_W, PHONE_H), 6)

  const disc = await drawnDisc(page)
  expect(disc.bands).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  expectRoundAndCentred(disc, disc.pxW, disc.pxH, 'pasted preview')
})

/** Export the open edit and return the saved file's path. */
async function exportTo(page: Page, name: string): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 280_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4 = `${VERIFY}/${name}.mp4`
  await download.saveAs(mp4)
  expect(fs.statSync(mp4).size).toBeGreaterThan(20_000)
  return mp4
}

/** The file is exactly w x h, decodes clean, has no black band, and shows the same round, centred disc. */
async function expectFilledFile(mp4: string, w: number, h: number): Promise<void> {
  expect(await videoSizeOf(mp4)).toEqual({ w, h })
  const decode = await runFfmpeg(['-v', 'error', '-i', mp4, '-f', 'null', '-'])
  expect(decode.code).toBe(0)
  expect(decode.err.trim()).toBe('')
  expect(await cropdetect(mp4)).toEqual({ w, h, x: 0, y: 0 })
  expect(await edgeBands(mp4, w, h)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  expectRoundAndCentred(fileDisc(await framePixels(mp4, w, h), w, h), w, h, 'exported file')
}

test('exports a Shorts project as a 1080 x 2112 file with no band and a round disc, the same picture the preview shows', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  await editorUp(page)
  await newShortsProject(page)
  await addDisc(page)
  const preview = await drawnDisc(page)
  expectRoundAndCentred(preview, preview.pxW, preview.pxH, 'preview')

  const mp4 = await exportTo(page, 'shorts-phone')
  await expectFilledFile(mp4, PHONE_W, PHONE_H)
})

test('switch the Shorts project to 9:16 and it exports 1080 x 1920 with the clip still filling it, round', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  await editorUp(page)
  await newShortsProject(page)
  await addDisc(page)
  await page.getByTestId('format-select').selectOption('9:16')
  await expect(page.getByTestId('format-select')).toHaveValue('9:16')
  expect(await state(page)).toMatchObject({ seqW: PHONE_W, seqH: SHORTS_H })
  expect((await state(page)).scale).toBeCloseTo(coverFor(PHONE_W, SHORTS_H), 6)
  const preview = await drawnDisc(page)
  expect(preview.bands).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  expectRoundAndCentred(preview, preview.pxW, preview.pxH, 'preview')

  const mp4 = await exportTo(page, 'shorts-9x16')
  await expectFilledFile(mp4, PHONE_W, SHORTS_H)
})
