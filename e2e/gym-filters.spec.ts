// The gym filters, end to end: each new or unhidden effect is found by name in the
// Effects tab, applied by double click, seen changing the program monitor, and
// then seen changing the EXPORTED FILE the same way. Both are drawn by the one
// shared renderer from the one pure resolver, so a filter that works in the
// monitor but not in the file (or the other way round) is a real bug.
//
// One export carries all of it: nine clips of the same two seconds, the first left
// plain as the reference and the other eight each wearing one filter. Every
// reading is "this clip against the plain one at the same moment", off the monitor
// and then off the file, so the picture itself cancels out.
//
// The footage is the first 0.9 s of the shared fixture (flat red with a timecode in
// one corner; it turns blue at 1 s, which is why only the red part is used) with a
// click track for sound: three clicks, so the strobe follows REAL detected beats
// and the export has to carry them to its worker.
//
// ⛔ No store write ever happens after an await inside page.evaluate. The modules
// are imported once, in an evaluate that only reads, and every write is a plain
// synchronous evaluate through the handle that left behind.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { ffmpegAvailable, framePixels, runFfmpeg } from './exportHelpers'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/gym'
const FOOTAGE = `${VERIFY}/gym-footage.webm`
const W = 640
const H = 360
/** Where the clicks sit in each clip's own 0.9 s. */
const CLICKS_S = [0.15, 0.5, 0.8]
/** The one moment of every clip the pictures are compared at: steady red, mid clip. */
const MEASURE_S = 0.5

// Same as export.spec.ts: no save picker, so the export arrives as a download.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

// --- Footage: the red fixture's picture with a click track as its sound ----

function clickTrackWav(path: string, clicks: readonly number[], seconds = 0.9, rate = 48000): void {
  const n = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (const t0 of clicks) {
    const s0 = Math.floor(t0 * rate)
    const len = Math.floor(0.03 * rate)
    for (let i = 0; i < len && s0 + i < n; i++) {
      const v = Math.sin((2 * Math.PI * 1500 * i) / rate) * Math.exp(-i / (0.006 * rate)) * 0.9
      buf.writeInt16LE(Math.round(v * 32767), 44 + (s0 + i) * 2)
    }
  }
  fs.writeFileSync(path, buf)
}

test.beforeAll(async () => {
  fs.mkdirSync(VERIFY, { recursive: true })
  expect(ffmpegAvailable(), 'the bundled ffmpeg is needed to make the footage and read the export').toBe(true)
  const wav = `${VERIFY}/clicks.wav`
  clickTrackWav(wav, CLICKS_S)
  const r = await runFfmpeg([
    '-y', '-i', FIXTURE, '-i', wav, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', '-t', '0.9', FOOTAGE,
  ])
  expect(r.code, r.err.slice(-400)).toBe(0)
})

// --- The page handle: imports are read-only, every write is synchronous ----

interface Handle {
  useStore: {
    getState: () => {
      project: unknown
      setUI: (u: Record<string, unknown>) => void
    }
  }
  setActiveSequenceFormat: (w: number, h: number, refit?: boolean) => void
  invalidatePreview: () => void
  sequenceWithBeats: (seq: unknown, assets: unknown) => Promise<{ beatGridS?: number[] }>
  activeSequence: (p: unknown) => unknown
}
type G = { __gym: Handle }

async function bind(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const previewMod = '/src/engine/preview.ts'
    const gridMod = '/src/engine/beatGrid.ts'
    const typesMod = '/src/engine/types.ts'
    const s = (await import(/* @vite-ignore */ storeMod)) as Record<string, unknown>
    const p = (await import(/* @vite-ignore */ previewMod)) as Record<string, unknown>
    const g = (await import(/* @vite-ignore */ gridMod)) as Record<string, unknown>
    const t = (await import(/* @vite-ignore */ typesMod)) as Record<string, unknown>
    ;(window as unknown as G).__gym = {
      useStore: s.useStore,
      setActiveSequenceFormat: s.setActiveSequenceFormat,
      invalidatePreview: p.invalidatePreview,
      sequenceWithBeats: g.sequenceWithBeats,
      activeSequence: t.activeSequence,
    } as Handle
  })
}

/** A plain synchronous write: the playhead, the selection. */
const setUI = (page: Page, ui: Record<string, unknown>): Promise<void> =>
  page.evaluate((ui) => {
    ;(window as unknown as G).__gym.useStore.getState().setUI(ui)
  }, ui)

const setFormat = (page: Page, w: number, h: number): Promise<void> =>
  page.evaluate(
    ({ w, h }) => {
      ;(window as unknown as G).__gym.setActiveSequenceFormat(w, h, false)
    },
    { w, h },
  )

interface ClipRow {
  id: string
  startS: number
  effects: { type: string; params: Record<string, unknown> }[]
}

/** Every video clip, in time order, read from the store. Synchronous read. */
const videoClips = (page: Page): Promise<ClipRow[]> =>
  page.evaluate(() => {
    const g = (window as unknown as G).__gym
    const seq = g.activeSequence(g.useStore.getState().project) as {
      tracks: { kind: string; clips: ClipRow[] }[]
    }
    return seq.tracks
      .filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips.map((c) => ({ id: c.id, startS: c.startS, effects: c.effects })))
      .sort((a, b) => a.startS - b.startS)
  })

const fpsOf = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const g = (window as unknown as G).__gym
    return (g.activeSequence(g.useStore.getState().project) as { fps: number }).fps
  })

// --- Pixels: the monitor and the file as the same kind of thing ------------

interface Shot {
  w: number
  h: number
  rgb: Uint8Array
}
type Region = [number, number, number, number]

const WHOLE: Region = [0, 0, 1, 1]
/** The flat red, clear of the timecode, the bars and the edges. */
const FLAT: Region = [0.4, 0.45, 0.95, 0.9]
const MID: Region = [0.3, 0.4, 0.7, 0.6]
const TOP: Region = [0, 0, 1, 0.08]
const BOTTOM: Region = [0, 0.92, 1, 1]
/** The timecode: the only edges in the picture. */
const TEXT: Region = [0.03, 0.06, 0.3, 0.3]

/** The program monitor, repainted and copied at w x h (the model: cinematic-looks.spec.ts). */
async function monitor(page: Page, w = W, h = H): Promise<Shot> {
  const b64 = await page.evaluate(
    async ({ w, h }) => {
      ;(window as unknown as G).__gym.invalidatePreview()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = w
      scratch.height = h
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      let bin = ''
      for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000))
      return btoa(bin)
    },
    { w, h },
  )
  const rgba = Buffer.from(b64, 'base64')
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = rgba[i * 4]
    rgb[i * 3 + 1] = rgba[i * 4 + 1]
    rgb[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return { w, h, rgb }
}

/** The monitor at sequence time `t`, once the picture has arrived and stopped changing. */
async function monitorAt(page: Page, t: number, w = W, h = H): Promise<Shot> {
  await setUI(page, { playheadS: t })
  let prev: Shot | null = null
  let settled: Shot | null = null
  await expect
    .poll(
      async () => {
        const now = await monitor(page, w, h)
        const ok = prev !== null && meanLuma(now, WHOLE) > 20 && meanAbsDiff(prev, now) < 0.5
        if (ok) settled = now
        prev = now
        return ok
      },
      { timeout: 15_000, intervals: [100, 200, 300] },
    )
    .toBe(true)
  return settled!
}

function exportedAt(file: string, t: number, fps: number): Promise<Shot> {
  // ffmpeg hands back the frame ON SCREEN at -ss, so the middle of frame t is the time to ask for.
  return framePixels(file, W, H, t + 0.5 / fps).then((buf) => ({ w: W, h: H, rgb: new Uint8Array(buf) }))
}

function each(s: Shot, reg: Region, fn: (x: number, y: number, r: number, g: number, b: number) => void): void {
  const x0 = Math.floor(s.w * reg[0])
  const y0 = Math.floor(s.h * reg[1])
  const x1 = Math.min(s.w, Math.ceil(s.w * reg[2]))
  const y1 = Math.min(s.h, Math.ceil(s.h * reg[3]))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * s.w + x) * 3
      fn(x, y, s.rgb[i], s.rgb[i + 1], s.rgb[i + 2])
    }
  }
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

function meanLuma(s: Shot, reg: Region): number {
  let sum = 0
  let n = 0
  each(s, reg, (_x, _y, r, g, b) => {
    sum += luma(r, g, b)
    n++
  })
  return n ? sum / n : 0
}

/** Red minus blue: how warm the patch is. */
function warmth(s: Shot, reg: Region): number {
  let sum = 0
  let n = 0
  each(s, reg, (_x, _y, r, _g, b) => {
    sum += r - b
    n++
  })
  return n ? sum / n : 0
}

/** Spread of the luma inside a patch: noise on a flat colour. */
function lumaStd(s: Shot, reg: Region): number {
  let sum = 0
  let sq = 0
  let n = 0
  each(s, reg, (_x, _y, r, g, b) => {
    const l = luma(r, g, b)
    sum += l
    sq += l * l
    n++
  })
  const m = sum / Math.max(1, n)
  return Math.sqrt(Math.max(0, sq / Math.max(1, n) - m * m))
}

/** Mean sideways step in luma: how hard the edges are. Falls when blurred, rises when sharpened. */
function edgeEnergy(s: Shot, reg: Region): number {
  let sum = 0
  let n = 0
  const at = (x: number, y: number): number => {
    const i = (y * s.w + x) * 3
    return luma(s.rgb[i], s.rgb[i + 1], s.rgb[i + 2])
  }
  each(s, reg, (x, y) => {
    if (x + 1 >= s.w) return
    sum += Math.abs(at(x + 1, y) - at(x, y))
    n++
  })
  return n ? sum / n : 0
}

/**
 * How far the blue picture sits to the right of the green one, in px, over the
 * timecode. The text is white on red, so green and blue both jump at its edges;
 * RGB split slides blue one way and red the other, green stays, so this reads the
 * split directly. 0 when the channels agree.
 */
function blueOverGreen(s: Shot, reg: Region): number {
  const bgAt = (c: number): number => {
    let sum = 0
    let n = 0
    each(s, [0.28, 0.28, 0.285, 0.285], (_x, _y, r, g, b) => {
      sum += [r, g, b][c]
      n++
    })
    return sum / Math.max(1, n)
  }
  const centroid = (c: number): number => {
    const bg = bgAt(c)
    let mass = 0
    let sx = 0
    each(s, reg, (x, _y, r, g, b) => {
      const m = Math.min(1, Math.max(0, ([r, g, b][c] - bg) / Math.max(1, 255 - bg)))
      mass += m
      sx += m * x
    })
    return mass > 0 ? sx / mass : 0
  }
  return centroid(2) - centroid(1)
}

function meanAbsDiff(a: Shot, b: Shot): number {
  let sum = 0
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i] - b.rgb[i])
  return sum / a.rgb.length
}

// --- The cases -------------------------------------------------------------

type Case = { type: string; words: string }
const CASES: Case[] = [
  { type: 'strobe', words: 'strobe' },
  { type: 'rgbSplit', words: 'rgb split' },
  { type: 'cinematicBars', words: 'cinematic bars' },
  { type: 'grain', words: 'film grain' },
  { type: 'sharpen', words: 'sharpen' },
  { type: 'directionalBlur', words: 'motion blur' },
  { type: 'colorWheels', words: 'lift gamma gain' },
  { type: 'whiteBalance', words: 'white balance' },
]

test('every gym filter shows in the monitor and in the exported file', async ({ page }) => {
  test.setTimeout(240_000)
  const passFailures: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('pass did not build') || m.text().includes('shader')) passFailures.push(m.text())
  })
  await page.goto('/')
  await bind(page)
  await page.getByTestId('media-file-input').setInputFiles(FOOTAGE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // Nine clips: the plain reference, then one per filter.
  for (let i = 1; i <= 9; i++) {
    await page.getByTestId('asset-card').dblclick()
    await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(i)
  }
  await setFormat(page, W, H)
  const fps = await fpsOf(page)
  const clips = await videoClips(page)
  expect(clips).toHaveLength(9)
  for (let i = 1; i < clips.length; i++) expect(clips[i].startS).toBeGreaterThan(clips[i - 1].startS + 0.5)

  // --- Found by name in the Effects tab, applied by double click ------------
  await page.getByRole('tab', { name: 'Effects' }).click()
  for (const [i, c] of CASES.entries()) {
    await setUI(page, { selection: [clips[i + 1].id] })
    await page.getByTestId('effect-search').fill(c.words)
    const row = page.locator(`[data-testid="effect-item"][data-payload="${c.type}"]`)
    await expect(row, `${c.type} is searchable as "${c.words}"`).toHaveCount(1)
    await row.dblclick()
    await expect
      .poll(async () => (await videoClips(page))[i + 1].effects.map((e) => e.type))
      .toEqual([c.type])
  }
  // Motion Blur is the directional blur: the move-derived smear stays off the shelf.
  await page.getByTestId('effect-search').fill('motion blur')
  await expect(page.locator('[data-testid="effect-item"][data-payload="motionSmear"]')).toHaveCount(0)
  await page.getByTestId('effect-search').fill('')

  // --- Each one starts with a setting that does something -------------------
  const afterApply = await videoClips(page)
  for (const [i, c] of CASES.entries()) {
    const fx = afterApply[i + 1].effects[0]
    expect(Object.keys(fx.params).length, `${c.type} arrives with a setting already up`).toBeGreaterThan(0)
  }

  // --- Cinematic bars: the 2.39:1 quick pick sets the size from THIS frame --
  await setUI(page, { selection: [clips[3].id] })
  await page.locator('[data-testid="effect-quickpick"][data-pick="2.39:1"]').click()
  await expect
    .poll(async () => Number((await videoClips(page))[3].effects[0].params.size))
    .toBeCloseTo(12.8, 1)
  await setUI(page, { selection: [] })

  // --- The strobe follows the clicks the app itself detects -----------------
  const grid = await page.evaluate(async () => {
    const g = (window as unknown as G).__gym
    const seq = g.activeSequence(g.useStore.getState().project)
    const project = g.useStore.getState().project as { assets: unknown }
    return (await g.sequenceWithBeats(seq, project.assets)).beatGridS ?? []
  })
  const strobeStart = clips[1].startS
  for (const click of CLICKS_S) {
    const near = grid.filter((b) => Math.abs(b - (strobeStart + click)) < 0.05)
    expect(near.length, `a detected beat near the click at ${click}s of the strobe clip, grid ${JSON.stringify(grid.slice(0, 9))}`).toBeGreaterThan(0)
  }
  const beat = grid.find((b) => Math.abs(b - (strobeStart + CLICKS_S[1])) < 0.05)!
  // The first frame at or after the beat, and a frame between flashes (the one before has died by then).
  const tOn = Math.ceil(beat * fps - 1e-6) / fps
  const tOff = Math.floor((beat - 0.1) * fps) / fps
  // The same moment of every other clip, on the frame grid.
  const at = (i: number): number => Math.round((clips[i].startS + MEASURE_S) * fps) / fps

  // --- The monitor -----------------------------------------------------------
  const plainMon = await monitorAt(page, at(0))
  const mon: Record<string, Shot> = {}
  for (const [i, c] of CASES.entries()) {
    if (c.type === 'strobe') continue
    mon[c.type] = await monitorAt(page, at(i + 1))
  }
  const strobeOnMon = await monitorAt(page, tOn)
  const strobeOffMon = await monitorAt(page, tOff)
  const plainOffMon = await monitorAt(page, Math.round((clips[0].startS + (tOff - strobeStart)) * fps) / fps)

  // The monitor shows every filter.
  const monLumaGain = meanLuma(strobeOnMon, WHOLE) - meanLuma(plainOffMon, WHOLE)
  expect(monLumaGain, 'strobe flashes the monitor on the beat').toBeGreaterThan(20)
  expect(Math.abs(meanLuma(strobeOffMon, WHOLE) - meanLuma(plainOffMon, WHOLE)), 'and is quiet off the beat').toBeLessThan(6)
  expect(blueOverGreen(mon.rgbSplit, TEXT) - blueOverGreen(plainMon, TEXT), 'RGB split slides the channels').toBeGreaterThan(5)
  expect(meanLuma(mon.cinematicBars, TOP), 'top bar').toBeLessThan(20)
  expect(meanLuma(mon.cinematicBars, BOTTOM), 'bottom bar').toBeLessThan(20)
  expect(Math.abs(meanLuma(mon.cinematicBars, MID) - meanLuma(plainMon, MID)), 'the picture between the bars is untouched').toBeLessThan(8)
  expect(lumaStd(mon.grain, FLAT) - lumaStd(plainMon, FLAT), 'film grain adds noise').toBeGreaterThan(1)
  expect(edgeEnergy(mon.sharpen, TEXT) / edgeEnergy(plainMon, TEXT), 'sharpen hardens edges').toBeGreaterThan(1.02)
  expect(edgeEnergy(mon.directionalBlur, TEXT) / edgeEnergy(plainMon, TEXT), 'motion blur softens edges').toBeLessThan(0.8)
  expect(meanLuma(mon.colorWheels, FLAT) - meanLuma(plainMon, FLAT), 'Lift / Gamma / Gain lifts the highlights').toBeGreaterThan(4)
  expect(warmth(mon.whiteBalance, FLAT) - warmth(plainMon, FLAT), 'White Balance warms the picture').toBeGreaterThan(8)

  // --- Export, then read the same moments out of the file --------------------
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/gym-e2e.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(20_000)
  // The export dialog stays up over the app until it is dismissed.
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Done' })).toHaveCount(0)

  const plainFile = await exportedAt(mp4Path, at(0), fps)
  const file: Record<string, Shot> = {}
  for (const [i, c] of CASES.entries()) {
    if (c.type === 'strobe') continue
    file[c.type] = await exportedAt(mp4Path, at(i + 1), fps)
  }
  const strobeOnFile = await exportedAt(mp4Path, tOn, fps)
  const strobeOffFile = await exportedAt(mp4Path, tOff, fps)
  const plainOffFile = await exportedAt(mp4Path, Math.round((clips[0].startS + (tOff - strobeStart)) * fps) / fps, fps)

  const report = {
    grid: grid.slice(0, 9),
    tOn,
    tOff,
    strobe: {
      mon: [meanLuma(plainOffMon, WHOLE), meanLuma(strobeOffMon, WHOLE), meanLuma(strobeOnMon, WHOLE)],
      file: [meanLuma(plainOffFile, WHOLE), meanLuma(strobeOffFile, WHOLE), meanLuma(strobeOnFile, WHOLE)],
    },
    rgbSplit: { mon: blueOverGreen(mon.rgbSplit, TEXT) - blueOverGreen(plainMon, TEXT), file: blueOverGreen(file.rgbSplit, TEXT) - blueOverGreen(plainFile, TEXT) },
    bars: {
      mon: [meanLuma(mon.cinematicBars, TOP), meanLuma(mon.cinematicBars, BOTTOM), meanLuma(mon.cinematicBars, MID)],
      file: [meanLuma(file.cinematicBars, TOP), meanLuma(file.cinematicBars, BOTTOM), meanLuma(file.cinematicBars, MID)],
    },
    grain: { mon: lumaStd(mon.grain, FLAT) - lumaStd(plainMon, FLAT), file: lumaStd(file.grain, FLAT) - lumaStd(plainFile, FLAT) },
    sharpen: { mon: edgeEnergy(mon.sharpen, TEXT) / edgeEnergy(plainMon, TEXT), file: edgeEnergy(file.sharpen, TEXT) / edgeEnergy(plainFile, TEXT) },
    motionBlur: { mon: edgeEnergy(mon.directionalBlur, TEXT) / edgeEnergy(plainMon, TEXT), file: edgeEnergy(file.directionalBlur, TEXT) / edgeEnergy(plainFile, TEXT) },
    colorWheels: { mon: meanLuma(mon.colorWheels, FLAT) - meanLuma(plainMon, FLAT), file: meanLuma(file.colorWheels, FLAT) - meanLuma(plainFile, FLAT) },
    whiteBalance: { mon: warmth(mon.whiteBalance, FLAT) - warmth(plainMon, FLAT), file: warmth(file.whiteBalance, FLAT) - warmth(plainFile, FLAT) },
  }
  fs.writeFileSync(`${VERIFY}/gym-e2e.json`, JSON.stringify(report, null, 2))
  const why = JSON.stringify(report)

  // The file shows what the monitor showed.
  const fileLumaGain = meanLuma(strobeOnFile, WHOLE) - meanLuma(plainOffFile, WHOLE)
  expect(fileLumaGain, `strobe flashes the file on the beat ${why}`).toBeGreaterThan(20)
  expect(Math.abs(fileLumaGain - monLumaGain), `the flash is as strong in the file ${why}`).toBeLessThan(12)
  expect(Math.abs(meanLuma(strobeOffFile, WHOLE) - meanLuma(plainOffFile, WHOLE)), `and quiet off the beat ${why}`).toBeLessThan(6)
  const splitFile = blueOverGreen(file.rgbSplit, TEXT) - blueOverGreen(plainFile, TEXT)
  expect(splitFile, `RGB split in the file ${why}`).toBeGreaterThan(5)
  expect(Math.abs(splitFile - (blueOverGreen(mon.rgbSplit, TEXT) - blueOverGreen(plainMon, TEXT))), `same split ${why}`).toBeLessThan(4)
  expect(meanLuma(file.cinematicBars, TOP), `top bar in the file ${why}`).toBeLessThan(25)
  expect(meanLuma(file.cinematicBars, BOTTOM), `bottom bar in the file ${why}`).toBeLessThan(25)
  expect(Math.abs(meanLuma(file.cinematicBars, MID) - meanLuma(plainFile, MID)), `bars leave the picture ${why}`).toBeLessThan(10)
  expect(lumaStd(file.grain, FLAT) - lumaStd(plainFile, FLAT), `film grain in the file ${why}`).toBeGreaterThan(0.5)
  expect(edgeEnergy(file.sharpen, TEXT) / edgeEnergy(plainFile, TEXT), `sharpen in the file ${why}`).toBeGreaterThan(1.02)
  expect(edgeEnergy(file.directionalBlur, TEXT) / edgeEnergy(plainFile, TEXT), `motion blur in the file ${why}`).toBeLessThan(0.8)
  const wheelsFile = meanLuma(file.colorWheels, FLAT) - meanLuma(plainFile, FLAT)
  expect(wheelsFile, `Lift / Gamma / Gain in the file ${why}`).toBeGreaterThan(4)
  expect(Math.abs(wheelsFile - (meanLuma(mon.colorWheels, FLAT) - meanLuma(plainMon, FLAT))), `same lift ${why}`).toBeLessThan(10)
  const warmFile = warmth(file.whiteBalance, FLAT) - warmth(plainFile, FLAT)
  expect(warmFile, `White Balance in the file ${why}`).toBeGreaterThan(8)
  expect(Math.abs(warmFile - (warmth(mon.whiteBalance, FLAT) - warmth(plainMon, FLAT))), `same warmth ${why}`).toBeLessThan(12)

  // --- The tall Phone frame: the quick pick measures THIS frame -------------
  await setFormat(page, 360, 640)
  await setUI(page, { selection: [clips[3].id] })
  await page.locator('[data-testid="effect-quickpick"][data-pick="2.39:1"]').click()
  await expect
    .poll(async () => Number((await videoClips(page))[3].effects[0].params.size))
    .toBeCloseTo(38.2, 1)
  await setUI(page, { selection: [] })
  const tall = await monitorAt(page, at(3), 360, 640)
  expect(meanLuma(tall, [0, 0, 1, 0.3]), 'a tall frame gets tall bars').toBeLessThan(20)
  expect(meanLuma(tall, [0, 0.7, 1, 1]), 'top and bottom').toBeLessThan(20)
  expect(meanLuma(tall, [0.3, 0.45, 0.7, 0.55]), 'the picture is left in the middle').toBeGreaterThan(60)

  expect(passFailures).toEqual([])
})
