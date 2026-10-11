// A test picture for the colour specs (the cinematic looks and the LUT import).
//
// A real clip is a poor thing to score a grade against: it has no colour that is
// known to the digit, so the only check left is "it looks different". This chart
// is drawn in the page, imported as a still, and has:
//   - twelve flat patches of known colour (greys, skin, the colour bands), each big
//     enough that its middle is far from any edge, so only the colour pass of a
//     look touches it;
//   - one bright block on a dark surround, for the glow a look puts round lights;
//   - one step edge between two greys, for the local contrast a look adds.
// Every spot is addressed as a fraction of the frame, so it reads the same at any
// size the monitor is drawn at.

import { expect, type Page } from '@playwright/test'
import { shrinkSequence } from './exportHelpers'

export type Rgb = [number, number, number]

/** The frame the chart is drawn at and the sequence is shrunk to. */
export const FRAME_W = 1280
export const FRAME_H = 720

/** A spot on the chart: centre as a fraction of the frame, half size in chart pixels. */
export interface Spot {
  name: string
  fx: number
  fy: number
  halfW: number
  halfH: number
  /** The colour the chart has there, 0..255. */
  rgb: Rgb
}

const COLS = [0.1, 0.28, 0.46, 0.64]
const ROWS = [0.18, 0.5, 0.82]
const PATCH_COLOURS: [string, Rgb][] = [
  ['gray', [128, 128, 128]],
  ['darkGray', [40, 40, 40]],
  ['nearBlack', [10, 10, 10]],
  ['skin', [170, 120, 95]],
  ['red', [200, 40, 40]],
  ['green', [40, 160, 60]],
  ['blue', [50, 80, 200]],
  ['orange', [200, 120, 40]],
  ['yellow', [190, 180, 50]],
  ['cyan', [40, 170, 170]],
  ['magenta', [170, 50, 160]],
  ['slate', [90, 100, 120]],
]

/** The patch size drawn, in chart pixels. Only the middle of each is ever read. */
const PATCH_W = 160
const PATCH_H = 120
/** Half of the square read from the middle of a patch. */
const READ_HALF = 10

export const CHART_BG: Rgb = [32, 32, 32]
export const BLOCK_RGB: Rgb = [250, 250, 250]
export const STEP_LOW: Rgb = [70, 70, 70]
export const STEP_HIGH: Rgb = [170, 170, 170]

/** The bright block: centre fraction and size in chart pixels. */
const BLOCK = { fx: 0.88, fy: 0.25, w: 140, h: 140 }
/** The step edge: the boundary column, and the rows it runs over. */
const STEP = { fx: 0.88, x0: 0.79, x1: 0.97, y0: 0.55, y1: 0.9 }

/** The twelve flat patches. */
export const PATCHES: Spot[] = PATCH_COLOURS.map(([name, rgb], i) => ({
  name,
  fx: COLS[i % 4],
  fy: ROWS[Math.floor(i / 4)],
  halfW: READ_HALF,
  halfH: READ_HALF,
  rgb,
}))

/** Just outside the bright block's left edge: where the glow of a look shows on the dark surround. */
export const NEAR_BLOCK: Spot = {
  name: 'nearBlock',
  fx: BLOCK.fx - BLOCK.w / 2 / FRAME_W - 10 / FRAME_W,
  fy: BLOCK.fy,
  halfW: 3,
  halfH: 40,
  rgb: CHART_BG,
}

/** The two sides of the step edge, a few pixels either way of the boundary. */
export const STEP_LOW_SIDE: Spot = { name: 'stepLow', fx: STEP.fx - 9 / FRAME_W, fy: 0.72, halfW: 3, halfH: 40, rgb: STEP_LOW }
export const STEP_HIGH_SIDE: Spot = { name: 'stepHigh', fx: STEP.fx + 9 / FRAME_W, fy: 0.72, halfW: 3, halfH: 40, rgb: STEP_HIGH }

/** The same three, as close to the edge as a glow or a local contrast boost is strongest: 2 to 6 pixels off it. */
export const NEAR_EDGE: Spot = {
  name: 'nearEdge',
  fx: BLOCK.fx - BLOCK.w / 2 / FRAME_W - 4 / FRAME_W,
  fy: BLOCK.fy,
  halfW: 2,
  halfH: 40,
  rgb: CHART_BG,
}
export const STEP_LOW_TIGHT: Spot = { name: 'stepLowTight', fx: STEP.fx - 4 / FRAME_W, fy: 0.72, halfW: 2, halfH: 40, rgb: STEP_LOW }
export const STEP_HIGH_TIGHT: Spot = { name: 'stepHighTight', fx: STEP.fx + 4 / FRAME_W, fy: 0.72, halfW: 2, halfH: 40, rgb: STEP_HIGH }

export const ALL_SPOTS: Spot[] = [
  ...PATCHES,
  NEAR_BLOCK,
  NEAR_EDGE,
  STEP_LOW_SIDE,
  STEP_HIGH_SIDE,
  STEP_LOW_TIGHT,
  STEP_HIGH_TIGHT,
]

/** The chart as PNG bytes, drawn in the page so the spec needs no file or encoder of its own. */
export async function chartPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ w, h, bg, patches, patchW, patchH, block, blockRgb, step, low, high }) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')!
      const css = (v: number[]): string => `rgb(${v[0]},${v[1]},${v[2]})`
      g.fillStyle = css(bg)
      g.fillRect(0, 0, w, h)
      for (const p of patches) {
        g.fillStyle = css(p.rgb)
        g.fillRect(Math.round(p.fx * w - patchW / 2), Math.round(p.fy * h - patchH / 2), patchW, patchH)
      }
      g.fillStyle = css(blockRgb)
      g.fillRect(Math.round(block.fx * w - block.w / 2), Math.round(block.fy * h - block.h / 2), block.w, block.h)
      const mid = Math.round(step.fx * w)
      g.fillStyle = css(low)
      g.fillRect(Math.round(step.x0 * w), Math.round(step.y0 * h), mid - Math.round(step.x0 * w), Math.round((step.y1 - step.y0) * h))
      g.fillStyle = css(high)
      g.fillRect(mid, Math.round(step.y0 * h), Math.round(step.x1 * w) - mid, Math.round((step.y1 - step.y0) * h))
      return c.toDataURL('image/png').split(',')[1]
    },
    {
      w: FRAME_W,
      h: FRAME_H,
      bg: CHART_BG,
      patches: PATCHES.map((p) => ({ fx: p.fx, fy: p.fy, rgb: p.rgb })),
      patchW: PATCH_W,
      patchH: PATCH_H,
      block: BLOCK,
      blockRgb: BLOCK_RGB,
      step: STEP,
      low: STEP_LOW,
      high: STEP_HIGH,
    },
  )
  return Buffer.from(b64, 'base64')
}

/**
 * Import the chart as a still, put it on the timeline, make the sequence the chart's
 * own size, trim it to one second (an export of it takes seconds) and park the
 * playhead on it. Returns the clip's id.
 */
export async function putChartOnTimeline(page: Page): Promise<string> {
  const buffer = await chartPng(page)
  await page.getByTestId('media-file-input').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer })
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await shrinkSequence(page, FRAME_W, FRAME_H)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const timelineMod = '/src/engine/timeline.ts'
    const typesMod = '/src/engine/types.ts'
    type Clip = { id: string; inS: number; outS: number }
    type Seq = { tracks: { kind: string; clips: Clip[] }[] }
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (u: Record<string, unknown>) => void } }
      updateActiveSequence: (label: string, fn: (s: Seq) => Seq) => void
    }
    const { recomputeDuration } = (await import(/* @vite-ignore */ timelineMod)) as { recomputeDuration: (s: Seq) => Seq }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => Seq }
    updateActiveSequence('trim chart', (s) =>
      recomputeDuration({
        ...s,
        tracks: s.tracks.map((t) =>
          t.kind !== 'video' ? t : { ...t, clips: t.clips.map((c) => ({ ...c, outS: c.inS + 1 })) },
        ),
      }),
    )
    useStore.getState().setUI({ playheadS: 0.5, selection: [] })
    return activeSequence(useStore.getState().project).tracks.find((t) => t.kind === 'video')!.clips[0].id
  })
}

/** The mean colour the program monitor shows at each spot, and how much it varies inside the box, after forcing a repaint. */
export async function readSpotStats(page: Page, spots: Spot[]): Promise<Record<string, { mean: Rgb; sd: number }>> {
  return page.evaluate(
    async ({ spots, frameW, frameH }) => {
      const previewMod = '/src/engine/preview.ts'
      const { invalidatePreview } = (await import(/* @vite-ignore */ previewMod)) as { invalidatePreview: () => void }
      invalidatePreview()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = c.width
      scratch.height = c.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      const out: Record<string, { mean: [number, number, number]; sd: number }> = {}
      for (const s of spots) {
        const sx = c.width / frameW
        const sy = c.height / frameH
        const hw = Math.max(1, Math.round(s.halfW * sx))
        const hh = Math.max(1, Math.round(s.halfH * sy))
        const cx = Math.round(c.width * s.fx)
        const cy = Math.round(c.height * s.fy)
        const d = ctx.getImageData(cx - hw, cy - hh, hw * 2, hh * 2).data
        const n = hw * 2 * hh * 2
        const sum = [0, 0, 0]
        let lumaSum = 0
        let lumaSq = 0
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 3; k++) sum[k] += d[i * 4 + k]
          const l = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
          lumaSum += l
          lumaSq += l * l
        }
        const meanL = lumaSum / n
        out[s.name] = { mean: [sum[0] / n, sum[1] / n, sum[2] / n], sd: Math.sqrt(Math.max(0, lumaSq / n - meanL * meanL)) }
      }
      return out
    },
    { spots, frameW: FRAME_W, frameH: FRAME_H },
  )
}

/** The mean colour the program monitor shows at each spot, after forcing a repaint. */
export async function readSpots(page: Page, spots: Spot[]): Promise<Record<string, Rgb>> {
  const stats = await readSpotStats(page, spots)
  return Object.fromEntries(Object.entries(stats).map(([name, v]) => [name, v.mean]))
}

/** The graphics chip the page's WebGL is really running on, as the browser reports it. */
export async function gpuName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'no webgl2'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  })
}

/** The largest per channel gap between two colours. */
export const gap = (a: Rgb, b: Rgb): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

export const lumaOf = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b
/** Max minus min channel: how far from grey a colour is. */
export const chromaOf = ([r, g, b]: Rgb): number => Math.max(r, g, b) - Math.min(r, g, b)

/** The mean colour an exported MP4 holds at each spot, at one moment of the file. */
export async function readSpotsFromFile(
  page: Page,
  mp4: Buffer,
  spots: Spot[],
  atS: number,
): Promise<{ width: number; height: number; spots: Record<string, Rgb> }> {
  return page.evaluate(
    async ({ b64, spots, atS, frameW, frameH }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('exported MP4 failed to decode'))
      })
      video.currentTime = atS
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)
      const out: Record<string, [number, number, number]> = {}
      for (const s of spots) {
        const hw = Math.max(1, Math.round((s.halfW * canvas.width) / frameW))
        const hh = Math.max(1, Math.round((s.halfH * canvas.height) / frameH))
        const cx = Math.round(canvas.width * s.fx)
        const cy = Math.round(canvas.height * s.fy)
        const d = ctx.getImageData(cx - hw, cy - hh, hw * 2, hh * 2).data
        const n = hw * 2 * hh * 2
        const sum = [0, 0, 0]
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k] += d[i * 4 + k]
        out[s.name] = [sum[0] / n, sum[1] / n, sum[2] / n]
      }
      return { width: video.videoWidth, height: video.videoHeight, spots: out }
    },
    { b64: mp4.toString('base64'), spots, atS, frameW: FRAME_W, frameH: FRAME_H },
  )
}
