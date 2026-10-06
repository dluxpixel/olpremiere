// The phone screen frame, 1080 x 2112 (his ask, 2026-10-05).
//
// He posts tall videos from his iPhone to TikTok and Reels. Some of his 1080x1920 files play shrunk
// with black above and below and others zoomed to fill, per video, on TikTok's own say. Both kinds
// are stored at exactly 576x1024, so the file's size is not what it reacts to, its SHAPE is. The
// area TikTok plays in on his phone is 1179 x 2307 device px (ratio 0.5111), and he says Instagram
// uses the same one: "find the exact ratio of TikTok and Instagram because they use both the same
// one, and just give me that." A video of exactly that shape fills it whether the app fits it or
// fills it, and in 1080 wide that is 1080 x 2112.
//
// What a person would check, in the order they would check it:
//   - the shape is in the picker, right after 9:16 Shorts, and the closed select stays as compact
//     as it is (2026-10-04: "there's a lot of blank space"),
//   - picking it reformats the sequence and grows his 1080x1920 phone clip to fill it,
//   - the monitor, the Safe margins guides and the screenshot all follow the taller frame,
//   - the preview has no black band, AND the exported file is exactly 1080 x 2112 with none either,
//     read back with the bundled ffmpeg, so the preview and the file are the same picture.
//
// The source is a real 1080x1920 H.264 phone clip made with the bundled ffmpeg: green across its
// top 16 rows and red across its bottom 16, so "fills the frame" is checked on the picture's own
// first and last row, and not only on "something bright is there".

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { avcLevelOf, cropdetect, edgeBands, ffmpegAvailable, framePixels, rowColour, runFfmpeg, videoSizeOf } from './exportHelpers'

test.skip(!ffmpegAvailable(), 'needs the bundled ffmpeg (vendor/ffmpeg), which a fresh worktree does not have')

const VERIFY = '_verify/phone'
const SRC = `${VERIFY}/phone-clip-1080x1920.mp4`
const PHONE_W = 1080
const PHONE_H = 2112

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
  const r = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i',
    // Brown with a light grid, a green strip across the top and a red one across the bottom. Nothing in it is dark.
    'color=c=0xb07848:s=1080x1920:r=30:d=2,drawgrid=w=135:h=240:t=6:c=0xf0d090,' +
      'drawbox=x=0:y=0:w=iw:h=16:c=0x00e000:t=fill,drawbox=x=0:y=ih-16:w=iw:h=16:c=0xe00000:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-shortest', SRC,
  ])
  expect(r.code, r.err.slice(-400)).toBe(0)
})

/** Open the app with the phone clip on the timeline, in the default 16:9 frame. */
async function open(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(SRC)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** The sequence and the project default, and the clip's resting scale, straight from the store. */
async function state(page: Page): Promise<{ seqW: number; seqH: number; setW: number; setH: number; scale: number }> {
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
    return { seqW: seq.width, seqH: seq.height, setW: p.settings.width, setH: p.settings.height, scale: clip.transform.scale }
  })
}

interface PreviewEdges {
  w: number
  h: number
  top: number[]
  bottom: number[]
  /** Whole rows and columns at each edge that are black, from the monitor's own pixels. */
  bands: { top: number; bottom: number; left: number; right: number }
}

/** Read the monitor canvas back: the colour just inside its top and bottom rows, and any black band at its four edges. */
async function previewEdges(page: Page): Promise<PreviewEdges> {
  return page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const src = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(src, 0, 0)
    const { width: w, height: h } = c
    const d = ctx.getImageData(0, 0, w, h).data
    const luma = (x: number, y: number): number => {
      const i = (y * w + x) * 4
      return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    }
    const row = (y: number): number => {
      let s = 0
      for (let x = 0; x < w; x++) s += luma(x, y)
      return s / w
    }
    const col = (x: number): number => {
      let s = 0
      for (let y = 0; y < h; y++) s += luma(x, y)
      return s / h
    }
    const run = (n: number, at: (i: number) => number): number => {
      let k = 0
      while (k < n && at(k) <= 24) k++
      return k
    }
    const px = (x: number, y: number): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
    return {
      w,
      h,
      top: px(w >> 1, 1),
      bottom: px(w >> 1, h - 2),
      bands: {
        top: run(h, (i) => row(i)),
        bottom: run(h, (i) => row(h - 1 - i)),
        left: run(w, (i) => col(i)),
        right: run(w, (i) => col(w - 1 - i)),
      },
    }
  })
}

const isGreen = ([r, g, b]: number[]): boolean => g > 150 && r < 90 && b < 90
const isRed = ([r, g, b]: number[]): boolean => r > 150 && g < 90 && b < 90

test('the Phone shape is in the picker after 9:16, stays compact, and switching fills the frame with his clip', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const select = page.getByTestId('format-select')

  // In the list, right after 9:16 Shorts, with the full name; the closed select says the short one.
  const listed = await select.evaluate((el) =>
    Array.from((el as HTMLSelectElement).options).map((o) => [o.value, (o.querySelector('.opt-long') as HTMLElement).innerText.trim()]),
  )
  expect(listed).toEqual([
    ['16:9', '16:9 Wide'],
    ['9:16', '9:16 Shorts'],
    ['phone', 'Phone screen: TikTok and Reels'],
    ['1:1', '1:1 Square'],
  ])

  // Still 1920x1080 until he picks it, and a phone clip in a wide frame is cropped to fill it.
  expect(await state(page)).toMatchObject({ seqW: 1920, seqH: 1080 })

  // The face's whole width, and how much of it is the label itself: the rest is padding, border and the
  // arrow, which is the same for every label, so it is what "blank space in the bar" would grow.
  const face = () =>
    select.evaluate((el) => {
      const label = el.querySelector('selectedcontent') as HTMLElement
      return {
        text: label.innerText.trim(),
        width: el.getBoundingClientRect().width,
        labelW: label.getBoundingClientRect().width,
      }
    })
  const wide = await face()
  expect(wide.text).toBe('16:9')

  await select.selectOption('phone')
  await expect(select).toHaveValue('phone')
  const phone = await face()
  expect(phone.text).toBe('Phone')
  // "Phone" is a longer word than "16:9", so its select is wider by exactly the extra the word needs: the
  // padding around the label is the same as it was, to a pixel. That is what "no blank space" means here.
  expect(phone.width).toBeGreaterThanOrEqual(36)
  expect(Math.abs(phone.width - phone.labelW - (wide.width - wide.labelW))).toBeLessThanOrEqual(1.5)
  expect(phone.width).toBeLessThanOrEqual(70)

  // The sequence AND the project default are the phone raster, and his clip was grown to cover it:
  // 1080x1920 into 1080x2112 is 2112/1920 = 1.1.
  const s = await state(page)
  expect(s).toMatchObject({ seqW: PHONE_W, seqH: PHONE_H, setW: PHONE_W, setH: PHONE_H })
  expect(s.scale).toBeCloseTo(1.1, 6)

  // The monitor takes the taller frame: its box is the frame's own shape, to a device pixel.
  const canvas = (await page.getByTestId('program-canvas').boundingBox())!
  expect(Math.abs(canvas.width / canvas.height - PHONE_W / PHONE_H) * canvas.height).toBeLessThan(1.5)

  // 9:16 still works as it did, and it is a different frame: the Shorts size, the clip back to its own fill.
  await select.selectOption('9:16')
  expect(await state(page)).toMatchObject({ seqW: 1080, seqH: 1920 })
  await select.selectOption('phone')
  await expect(select).toHaveValue('phone')
  expect(await state(page)).toMatchObject({ seqW: PHONE_W, seqH: PHONE_H })
})

test('the preview of the phone frame has no black band: his clip fills it, first row to last', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.getByTestId('format-select').selectOption('phone')
  // Pause on the first frame; wait for the clip's own green top and red bottom to be drawn.
  await expect
    .poll(async () => {
      const e = await previewEdges(page)
      return isGreen(e.top) && isRed(e.bottom)
    }, { timeout: 20_000 })
    .toBe(true)
  const e = await previewEdges(page)
  expect(e.bands).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  // The canvas is the phone's shape, so the picture is not boxed inside a taller or wider raster.
  expect(Math.abs(e.w / e.h - PHONE_W / PHONE_H) * e.h).toBeLessThan(1.5)
})

test('Safe margins is drawn over the whole of the taller frame, at the same share on both axes', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.getByTestId('format-select').selectOption('phone')
  await page.getByTestId('safe-margins-bar-toggle').click()
  const overlay = page.getByTestId('safe-margins')
  await expect(overlay).toBeVisible()
  await expect
    .poll(async () => {
      const a = (await overlay.boundingBox())!
      const c = (await page.getByTestId('program-canvas').boundingBox())!
      return Math.abs(a.width - c.width) <= 1.5 && Math.abs(a.height - c.height) <= 1.5 && Math.abs(a.x - c.x) <= 1.5 && Math.abs(a.y - c.y) <= 1.5
    })
    .toBe(true)
  const frame = (await overlay.boundingBox())!
  // Action safe (90 percent) and title safe (80 percent): a fifth of a tall frame's height is a lot
  // more pixels than a fifth of its width, and both guides are the same SHARE of each side.
  const boxes = await overlay.locator('> div').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )
  expect(boxes).toHaveLength(2)
  for (const [i, share] of [0.9, 0.8].entries()) {
    expect(boxes[i].w / frame.width, `guide ${i} width share`).toBeCloseTo(share, 2)
    expect(boxes[i].h / frame.height, `guide ${i} height share`).toBeCloseTo(share, 2)
    // Centred on the frame.
    expect(boxes[i].x + boxes[i].w / 2).toBeCloseTo(frame.x + frame.width / 2, 0)
    expect(boxes[i].y + boxes[i].h / 2).toBeCloseTo(frame.y + frame.height / 2, 0)
  }
})

test('the screenshot of the phone frame is 1080 x 2112 with his clip filling it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.getByTestId('format-select').selectOption('phone')
  await page.getByTestId('screenshot-button').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(2, { timeout: 30_000 })

  const still = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const persistMod = '/src/state/persistence.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { assets: Record<string, { kind: string; width?: number; height?: number; blobKey: string }> } } }
    }
    const { getBlob } = (await import(/* @vite-ignore */ persistMod)) as { getBlob: (k: string) => Promise<Blob | null> }
    const asset = Object.values(useStore.getState().project.assets).find((a) => a.kind === 'image')!
    const bmp = await createImageBitmap((await getBlob(asset.blobKey))!)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const px = (x: number, y: number): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
    return { w: bmp.width, h: bmp.height, assetW: asset.width, assetH: asset.height, top: px(bmp.width >> 1, 2), bottom: px(bmp.width >> 1, bmp.height - 3), left: px(2, bmp.height >> 1), right: px(bmp.width - 3, bmp.height >> 1) }
  })
  expect(still).toMatchObject({ w: PHONE_W, h: PHONE_H, assetW: PHONE_W, assetH: PHONE_H })
  // The picture's own first and last rows are the frame's: green on top, red below, and the sides are picture, not black.
  expect(isGreen(still.top), `top ${still.top}`).toBe(true)
  expect(isRed(still.bottom), `bottom ${still.bottom}`).toBe(true)
  for (const side of [still.left, still.right]) expect(Math.max(...side), `side ${side}`).toBeGreaterThan(60)
})

test('exports the phone frame as a 1080 x 2112 file with no black band, the same picture the preview shows', async ({ page }) => {
  test.setTimeout(300_000)
  await open(page)
  await page.getByTestId('format-select').selectOption('phone')

  // What the plan says before a frame is made: the dialog states the size, and it is the phone raster.
  const planned = await page.evaluate(async () => {
    const planMod = '/src/engine/export/exportPlan.ts'
    const typesMod = '/src/engine/types.ts'
    const storeMod = '/src/state/store.ts'
    const { planExport } = (await import(/* @vite-ignore */ planMod)) as {
      planExport: (s: unknown) => { settings: { width: number; height: number; videoCodec?: string }; nativeEncoder: string }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => unknown }
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    return planExport(activeSequence(useStore.getState().project))
  })
  expect(planned.settings).toMatchObject({ width: PHONE_W, height: PHONE_H, videoCodec: 'avc' })

  const downloadPromise = page.waitForEvent('download', { timeout: 280_000 })
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-plan')).toContainText('1080 × 2112')
  const download = await downloadPromise
  const mp4 = `${VERIFY}/phone-export.mp4`
  await download.saveAs(mp4)
  expect(fs.statSync(mp4).size).toBeGreaterThan(20_000)

  // Exactly the phone raster, not a size near it.
  expect(await videoSizeOf(mp4)).toEqual({ w: PHONE_W, h: PHONE_H })
  const report = await runFfmpeg(['-i', mp4])
  expect(report.err).toMatch(/Video: h264/)
  expect(report.err).toMatch(/Audio: aac/)
  // A clean decode, start to end.
  const decode = await runFfmpeg(['-v', 'error', '-i', mp4, '-f', 'null', '-'])
  expect(decode.code).toBe(0)
  expect(decode.err.trim()).toBe('')

  // No black band on any edge, by the crop detector and by the luma of every edge row and column...
  expect(await cropdetect(mp4)).toEqual({ w: PHONE_W, h: PHONE_H, x: 0, y: 0 })
  expect(await edgeBands(mp4, PHONE_W, PHONE_H)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })

  // ...and the clip's own first row is the file's first row, its last row the file's last: the green
  // strip is at the very top and the red at the very bottom, so nothing was boxed, shifted or cropped.
  const rgb = await framePixels(mp4, PHONE_W, PHONE_H)
  expect(isGreen(rowColour(rgb, PHONE_W, 2)), `row 2 ${rowColour(rgb, PHONE_W, 2)}`).toBe(true)
  expect(isRed(rowColour(rgb, PHONE_W, PHONE_H - 3)), `last rows ${rowColour(rgb, PHONE_W, PHONE_H - 3)}`).toBe(true)
  // The sides are picture: the left and right edge columns are not black at any height.
  const mid = Math.floor(PHONE_H / 2)
  for (const x of [0, PHONE_W - 1]) {
    const i = (mid * PHONE_W + x) * 3
    expect(Math.max(rgb[i], rgb[i + 1], rgb[i + 2]), `column ${x}`).toBeGreaterThan(60)
  }

  // The preview was the same picture: the monitor showed green on top and red below as well.
  const e = await previewEdges(page)
  expect(isGreen(e.top) && isRed(e.bottom)).toBe(true)

  // The level the file declares. 8976 macroblocks a frame is more than 4.0 holds (8192) and more than 4.2
  // holds (8704), so a true file says 5.0 or above, and a phone decodes all of them. Headless Chromium's
  // encoder writes 5.0 (measured 2026-10-06); the desktop app's x264 writes 5.1 (src/engine/export/phoneExport.test.ts).
  const level = avcLevelOf(fs.readFileSync(mp4))
  console.log(`[phone export] ${PHONE_W}x${PHONE_H} level_idc ${level}`)
  expect([50, 51, 52], `level_idc ${level}`).toContain(level)
})
