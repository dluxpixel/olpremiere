// The cinematic looks, end to end: picked from the Looks shelf onto TWO selected
// clips, seen on the program monitor, and exported. The exported file has to show
// the same picture the monitor showed, because both are drawn by the one shared
// renderer (effects/looks.ts, render/glRenderer.ts).

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { shrinkSequence } from './exportHelpers'
import {
  ALL_SPOTS,
  FRAME_H,
  FRAME_W,
  NEAR_BLOCK,
  NEAR_EDGE,
  STEP_HIGH_TIGHT,
  STEP_LOW_TIGHT,
  PATCHES,
  STEP_HIGH_SIDE,
  STEP_LOW_SIDE,
  chromaOf,
  gap,
  gpuName,
  lumaOf,
  putChartOnTimeline,
  readSpotStats,
  readSpots,
  type Rgb as ChartRgb,
  type Spot,
} from './gradeChart'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/looks'

// Same as export.spec.ts: no save picker, so the export arrives as a download.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

type Rgb = [number, number, number]
const luma = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Every video clip on the timeline, with its effects, read from the store. */
async function clips(page: Page): Promise<{ id: string; effects: { type: string; params: Record<string, unknown> }[] }[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { id: string; effects: { type: string; params: Record<string, unknown> }[] }[] }[]
      }
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips.map((c) => ({ id: c.id, effects: c.effects })))
  })
}

async function setUI(page: Page, ui: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (ui) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (u: Record<string, unknown>) => void } }
    }
    useStore.getState().setUI(ui)
  }, ui)
}

/**
 * The mean colour of a 9 x 9 patch of the program monitor at a fractional
 * position, after forcing a repaint (see stylize-pack.spec.ts for why a parked
 * WebGL canvas must be repainted before it is copied).
 */
async function monitorPatch(page: Page, fx: number, fy: number): Promise<Rgb> {
  return page.evaluate(
    async ({ fx, fy }) => {
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
      const d = ctx.getImageData(Math.floor(c.width * fx) - 4, Math.floor(c.height * fy) - 4, 9, 9).data
      const sum = [0, 0, 0]
      for (let i = 0; i < 81; i++) for (let k = 0; k < 3; k++) sum[k] += d[i * 4 + k]
      return sum.map((v) => v / 81) as Rgb
    },
    { fx, fy },
  )
}

test('a look from the Looks shelf lands on every selected clip, and the export shows what the monitor shows', async ({ page }) => {
  test.setTimeout(240_000)
  // A look pass this GPU will not build is left out with one warning, and the
  // look still draws its colour (glRenderer.ts, lazyPass). So the picture alone
  // cannot prove a look's passes ran: no pass may have failed to build. Moody
  // Gym needs the clarity pass, and Kodak Film, at the end, the other two.
  const passFailures: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('pass did not build')) passFailures.push(m.text())
  })
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

  // HD, so the export takes its 16 bit composite and its dither: the path his
  // real 1080 x 1920 exports take.
  await shrinkSequence(page, 1280, 720)
  await setUI(page, { playheadS: 0.5 })
  await expect.poll(async () => (await monitorPatch(page, 0.5, 0.5))[0], { timeout: 10_000 }).toBeGreaterThan(120)
  const before = await monitorPatch(page, 0.5, 0.5)

  // Both clips selected, then the look picked off the shelf by its plain name.
  const ids = (await clips(page)).map((c) => c.id)
  expect(ids).toHaveLength(2)
  await setUI(page, { selection: ids })
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.getByTestId('effect-search').fill('moody')
  const row = page.locator('[data-testid="look-item"][data-payload="lookMoodyGym"]')
  await expect(row).toHaveCount(1)
  await expect(page.getByTestId('effect-item')).toHaveCount(0)
  await row.dblclick()

  // On BOTH clips, at the full look.
  await expect
    .poll(async () => (await clips(page)).map((c) => c.effects.map((e) => `${e.type}:${String(e.params.amount)}`).join(',')))
    .toEqual(['lookMoodyGym:1', 'lookMoodyGym:1'])

  // The monitor shows it: the fixture's red goes darker and loses colour.
  await setUI(page, { selection: [] })
  await expect.poll(async () => luma(await monitorPatch(page, 0.5, 0.5)), { timeout: 10_000 }).toBeLessThan(luma(before) - 10)
  const centre = await monitorPatch(page, 0.5, 0.5)
  const side = await monitorPatch(page, 0.3, 0.35)
  const centreLate = await (async () => {
    await setUI(page, { playheadS: 2.5 })
    return monitorPatch(page, 0.5, 0.5)
  })()

  // Export, then read the same spots back out of the file.
  const downloadPromise = page.waitForEvent('download', { timeout: 200_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/looks-e2e.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(20_000)

  const b64 = fs.readFileSync(mp4Path).toString('base64')
  const fromFile = await page.evaluate(async (b64src) => {
    const bytes = Uint8Array.from(atob(b64src), (c) => c.charCodeAt(0))
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('exported MP4 failed to decode'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const c2d = canvas.getContext('2d')!
    const patch = async (t: number, fx: number, fy: number): Promise<number[]> => {
      video.currentTime = t
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
      })
      c2d.drawImage(video, 0, 0)
      const d = c2d.getImageData(Math.floor(canvas.width * fx) - 4, Math.floor(canvas.height * fy) - 4, 9, 9).data
      const sum = [0, 0, 0]
      for (let i = 0; i < 81; i++) for (let k = 0; k < 3; k++) sum[k] += d[i * 4 + k]
      return sum.map((v) => v / 81)
    }
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      centre: await patch(0.5, 0.5, 0.5),
      side: await patch(0.5, 0.3, 0.35),
      centreLate: await patch(2.5, 0.5, 0.5),
    }
  }, b64)

  expect(fromFile.width).toBe(1280)
  expect(fromFile.height).toBe(720)
  const report = { before, centre, side, centreLate, fromFile }
  fs.writeFileSync(`${VERIFY}/looks-e2e.json`, JSON.stringify(report, null, 2))
  // Within what the H.264 round trip costs, channel by channel, in both clips.
  for (const [mon, file] of [
    [centre, fromFile.centre],
    [side, fromFile.side],
    [centreLate, fromFile.centreLate],
  ] as [Rgb, number[]][]) {
    for (let k = 0; k < 3; k++) expect(Math.abs(mon[k] - file[k]), `${JSON.stringify(report)}`).toBeLessThan(10)
  }

  // The halation and bloom programs (the bright pass and the glow combine) are
  // built only when a look first needs them, so only a look that has them puts
  // them through a real GPU's compiler. Moody Gym has neither. Kodak Film has
  // clarity, halation and bloom, all three passes, so one monitor frame of it
  // compiles and draws every look pass there is, and a typo in any of them
  // fails here instead of shipping as a console warning.
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await setUI(page, { selection: ids, playheadS: 0.5 })
  await page.getByTestId('effect-search').fill('kodak')
  const kodak = page.locator('[data-testid="look-item"][data-payload="lookKodakFilm"]')
  await expect(kodak).toHaveCount(1)
  await kodak.dblclick()
  await expect
    .poll(async () => (await clips(page)).map((c) => c.effects.map((e) => e.type).join(',')))
    .toEqual(['lookKodakFilm', 'lookKodakFilm'])
  await setUI(page, { selection: [] })
  // A frame of it on the monitor: the picture leaves Moody Gym's.
  await expect
    .poll(async () => {
      const now = await monitorPatch(page, 0.5, 0.5)
      return Math.max(...now.map((v, k) => Math.abs(v - centre[k])))
    }, { timeout: 10_000 })
    .toBeGreaterThan(3)
  expect(passFailures).toEqual([])
})

// ---------------------------------------------------------------------------
// All ten looks on a real GPU, scored against their own row of numbers.
//
// The first test above puts two looks through the whole shelf-to-export route. This
// one covers all ten: a look whose shader has a typo, a uniform that is never set,
// or a pass that does not build still draws a plausible looking frame, so "it is
// different from the source" proves nothing. The chart (gradeChart.ts) has flat
// patches of known colour, so the colour pass of every look is scored against
// applyLook, the TypeScript twin of the same numbers (lookMath.ts), and the passes
// that read their neighbours (clarity, halation, bloom) are scored on the spots of
// the chart built to show them.

interface LookFacts {
  id: string
  clarity: number
  /** The grain's peak size, as the look's row says. */
  grain: number
  halation: boolean
  bloom: boolean
}

/** Which of the ten looks there are, and which passes each one asks for. */
async function lookFacts(page: Page): Promise<LookFacts[]> {
  return page.evaluate(async () => {
    const looksMod = '/src/engine/effects/looks.ts'
    const { LOOKS } = (await import(/* @vite-ignore */ looksMod)) as {
      LOOKS: { id: string; clarity: number; grain: { amount: number }; halation?: unknown; bloom?: unknown }[]
    }
    return LOOKS.map((s) => ({
      id: s.id,
      clarity: s.clarity,
      grain: s.grain.amount,
      halation: Boolean(s.halation),
      bloom: Boolean(s.bloom),
    }))
  })
}

/** What the chart's spots should read after a look's colour pass alone, from the look's own numbers. */
async function colourPassOf(page: Page, lookId: string, spots: Spot[]): Promise<Record<string, ChartRgb>> {
  return page.evaluate(
    async ({ lookId, spots, w, h }) => {
      const looksMod = '/src/engine/effects/looks.ts'
      const mathMod = '/src/engine/effects/lookMath.ts'
      const { LOOKS } = (await import(/* @vite-ignore */ looksMod)) as { LOOKS: { id: string; grain: { amount: number; size: number } }[] }
      const { applyLook } = (await import(/* @vite-ignore */ mathMod)) as {
        applyLook: (
          spec: unknown,
          rgb: number[],
          amount: number,
          ctx: { x: number; y: number; w: number; h: number; seed: number },
        ) => number[]
      }
      // Grain is noise with no average: the box on the monitor averages it away, a single pixel of the twin does not.
      const found = LOOKS.find((s) => s.id === lookId)!
      const spec = { ...found, grain: { ...found.grain, amount: 0 } }
      const out: Record<string, number[]> = {}
      for (const s of spots) {
        const v = applyLook(spec, [s.rgb[0] / 255, s.rgb[1] / 255, s.rgb[2] / 255], 1, { x: s.fx * w, y: s.fy * h, w, h, seed: 0 })
        out[s.name] = v.map((x) => x * 255)
      }
      return out as Record<string, ChartRgb>
    },
    { lookId, spots, w: FRAME_W, h: FRAME_H },
  )
}

/** Put a look on the clip the way every door does: swapping the one it wears. */
async function wearLook(page: Page, clipId: string, lookId: string): Promise<void> {
  await page.evaluate(
    async ({ clipId, lookId }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const looksMod = '/src/engine/effects/looks.ts'
      const { applyEffect } = (await import(/* @vite-ignore */ editsMod)) as { applyEffect: (clipId: string, type: string) => void }
      const { LOOKS, lookType } = (await import(/* @vite-ignore */ looksMod)) as {
        LOOKS: { id: string }[]
        lookType: (s: { id: string }) => string
      }
      applyEffect(clipId, lookType(LOOKS.find((s) => s.id === lookId)!))
    },
    { clipId, lookId },
  )
}

/**
 * How far each look is allowed to land from its own numbers, per channel, on the 0..255 scale.
 * Measured worst gap on two GPUs is 3.1 (Golden Hour on the yellow patch, which is bright
 * enough to bloom onto itself); every other patch of every look lands within 1.3.
 */
const COLOUR_TOLERANCE = 5

type Chart = Record<string, ChartRgb>

/** What each look must do to the chart, read straight off its row of numbers (not off applyLook). */
const DIRECTION: Record<string, (m: Chart, s: Chart) => string | null> = {
  // exposure -0.35 and a pulled curve: the mid grey goes down a long way; colour 0.8; the hue table drains red.
  moodyGym: (m, s) =>
    lumaOf(m.gray) > lumaOf(s.gray) - 12 ? 'mid grey did not go darker' : chromaOf(m.red) > chromaOf(s.red) * 0.9 ? 'red kept its colour' : null,
  // teal shadows: the dark grey picks up blue and green over red.
  tealOrange: (m, s) =>
    (m.darkGray[1] + m.darkGray[2]) / 2 - m.darkGray[0] < (s.darkGray[1] + s.darkGray[2]) / 2 - s.darkGray[0] + 2
      ? 'shadows did not go teal'
      : null,
  // tungsten film: a cool white balance and lifted blacks.
  film800T: (m, s) =>
    m.gray[2] - m.gray[0] < s.gray[2] - s.gray[0] + 5
      ? 'grey did not go cool'
      : lumaOf(m.nearBlack) < lumaOf(s.nearBlack) + 4
        ? 'blacks were not lifted'
        : null,
  // print film: a warm white balance.
  kodakFilm: (m, s) => (m.gray[0] - m.gray[2] < s.gray[0] - s.gray[2] + 3 ? 'grey did not go warm' : null),
  // bleach bypass: colour 0.45, and a hard curve pulls a dark grey down.
  gritty: (m, s) =>
    chromaOf(m.red) > chromaOf(s.red) * 0.7 ? 'red kept its colour' : lumaOf(m.darkGray) > lumaOf(s.darkGray) - 10 ? 'darks did not deepen' : null,
  // mono through an orange filter: no colour left, skin bright, blue dark.
  blackWhite: (m) =>
    Math.max(chromaOf(m.red), chromaOf(m.skin), chromaOf(m.blue), chromaOf(m.green)) > 6
      ? 'colour left in a black and white look'
      : lumaOf(m.skin) < lumaOf(m.blue) + 30
        ? 'skin is not brighter than blue'
        : null,
  // warm gain 1.06 over 0.9.
  goldenHour: (m, s) => (m.gray[0] - m.gray[2] < s.gray[0] - s.gray[2] + 8 ? 'grey did not go golden' : null),
  // cool gain 0.95 under 1.06.
  coldSteel: (m, s) => (m.gray[2] - m.gray[0] < s.gray[2] - s.gray[0] + 8 ? 'grey did not go steel blue' : null),
  // warm gain 1.05 over 0.88, and greens drained to 0.4.
  bronze: (m, s) =>
    m.gray[0] - m.gray[2] < s.gray[0] - s.gray[2] + 6
      ? 'grey did not go bronze'
      : chromaOf(m.green) > chromaOf(s.green) * 0.6
        ? 'green kept its colour'
        : null,
  // matte: the 0.06 foot of the curve lifts the blacks, colour 0.78.
  softFilm: (m, s) =>
    lumaOf(m.nearBlack) < lumaOf(s.nearBlack) + 5
      ? 'blacks were not lifted'
      : chromaOf(m.red) > chromaOf(s.red) * 0.9
        ? 'red kept its colour'
        : null,
}

test('all ten looks compile and draw on this GPU, each moving the chart the way its row of numbers says', async ({ page }) => {
  test.setTimeout(480_000)
  const problems: string[] = []
  page.on('console', (m) => {
    const text = m.text()
    if (text.includes('did not build') || /shader compile failed|program link failed|renderer init failed/.test(text)) problems.push(text)
  })
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))

  await page.goto('/')
  const clipId = await putChartOnTimeline(page)
  const gpu = await gpuName(page)
  test.info().annotations.push({ type: 'gpu', description: gpu })

  const source: Chart = Object.fromEntries(ALL_SPOTS.map((s) => [s.name, s.rgb]))
  // The chart with no look on it reads as drawn: if the monitor itself bent the
  // colours, every score below would be off by that much.
  await expect
    .poll(async () => {
      const m = await readSpots(page, PATCHES)
      return Math.max(...PATCHES.map((p) => gap(m[p.name], p.rgb)))
    }, { timeout: 15_000 })
    .toBeLessThanOrEqual(3)

  const facts = await lookFacts(page)
  expect(facts.map((f) => f.id)).toHaveLength(10)

  // With no look on the clip nothing is grainy, glowing or sharpened: a flat patch has no
  // spread and the spots beside the block and the edge read as drawn. That is the control
  // every look below is scored against.
  const bare = await readSpotStats(page, ALL_SPOTS)
  expect(bare.gray.sd).toBeLessThan(0.3)
  for (const s of [NEAR_BLOCK, NEAR_EDGE, STEP_LOW_TIGHT, STEP_HIGH_TIGHT]) {
    expect(gap(bare[s.name].mean, s.rgb), `${s.name} with no look`).toBeLessThanOrEqual(1.5)
  }

  const report: Record<string, unknown> = { gpu }
  const failures: string[] = []
  for (const look of facts) {
    await wearLook(page, clipId, look.id)
    const expected = await colourPassOf(page, look.id, ALL_SPOTS)
    // Poll until the monitor has drawn THIS look: the frame already on the canvas is the last one's.
    let measured: Chart = {}
    let stats: Record<string, { mean: ChartRgb; sd: number }> = {}
    for (let i = 0; i < 24; i++) {
      stats = await readSpotStats(page, ALL_SPOTS)
      measured = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.mean])) as Chart
      if (Math.max(...PATCHES.map((p) => gap(measured[p.name], expected[p.name]))) <= COLOUR_TOLERANCE) break
      await page.waitForTimeout(250)
    }
    const colourGaps = Object.fromEntries(PATCHES.map((p) => [p.name, Number(gap(measured[p.name], expected[p.name]).toFixed(1))]))
    const moved = Math.max(...PATCHES.map((p) => gap(measured[p.name], p.rgb)))
    const excess = (s: Spot): ChartRgb => [0, 1, 2].map((k) => measured[s.name][k] - expected[s.name][k]) as ChartRgb
    const near = excess(NEAR_BLOCK)
    const hi = excess(STEP_HIGH_SIDE)
    const lo = excess(STEP_LOW_SIDE)
    const edge = excess(NEAR_EDGE)
    const hiT = excess(STEP_HIGH_TIGHT)
    const loT = excess(STEP_LOW_TIGHT)
    const sd = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v.sd.toFixed(2))]))
    report[look.id] = { measured, expected, colourGaps, moved, nearExcess: near, edgeExcess: edge, stepHighExcess: hi, stepLowExcess: lo, stepHighTightExcess: hiT, stepLowTightExcess: loT, sd }

    for (const p of PATCHES) {
      if (colourGaps[p.name] > COLOUR_TOLERANCE) {
        failures.push(`${look.id}: ${p.name} reads ${measured[p.name].map(Math.round)} but its numbers say ${expected[p.name].map(Math.round)}`)
      }
    }
    if (moved < 6) failures.push(`${look.id}: the chart barely moved (${moved.toFixed(1)})`)
    const said = DIRECTION[look.id]?.(measured, source)
    if (said) failures.push(`${look.id}: ${said}`)

    // Grain: the noise is mean zero, so the colours above do not see it. Its size shows as
    // the spread inside a flat patch, which on the mid grey is about 19.5 times the look's
    // grain amount (measured on two GPUs, 18 to 22 for all ten looks). A pass that never
    // draws gives a spread of 0, a runaway one gives far more.
    const grainSd = stats.gray.sd
    if (grainSd < 11 * look.grain || grainSd > 30 * look.grain) {
      failures.push(`${look.id}: grain spread on the grey patch is ${grainSd.toFixed(2)}, expected about ${(19.5 * look.grain).toFixed(2)}`)
    }

    // Halation and bloom: the dark surround next to the bright block is lit where the look
    // has a glow, and left alone where it has none. 4 px off the edge is where it is
    // strongest; the least glow measured there is 33 levels (Kodak's small halation), the
    // most any look without one moves it is 3.
    const glowing = look.halation || look.bloom
    const lit = Math.max(...edge)
    if (glowing && lit < 15) failures.push(`${look.id}: no glow next to the bright block (only ${lit.toFixed(1)} above its colour pass)`)
    if (!glowing && Math.max(...edge.map(Math.abs), ...near.map(Math.abs)) > 5) {
      failures.push(`${look.id}: has no glow in its numbers but the surround moved ${edge.map((v) => v.toFixed(1))}`)
    }
    // Halation is red: the red channel climbs well above the blue one.
    if (look.halation && edge[0] - edge[2] < 10) failures.push(`${look.id}: halation is not red (${edge.map((v) => v.toFixed(1))})`)
    // Bloom has the wider reach: 10 px out it still shows (smallest measured 18).
    if (look.bloom && Math.max(...near) < 8) failures.push(`${look.id}: bloom does not reach 10 px out (${near.map((v) => v.toFixed(1))})`)

    // Clarity: local contrast. Next to a step edge the bright side goes brighter and the dark
    // side darker, by a spread that grows with the look's clarity (measured 19 to 36 times
    // it across the seven looks that have some); a look without clarity leaves the edge alone.
    const spread = (hiT[0] + hiT[1] + hiT[2] - loT[0] - loT[1] - loT[2]) / 3
    const needed = Math.max(2.5, 12 * look.clarity)
    if (look.clarity > 0 && spread < needed) {
      failures.push(`${look.id}: clarity ${look.clarity} should open the edge by at least ${needed.toFixed(1)}, it opened ${spread.toFixed(1)}`)
    }
    if (look.clarity === 0 && Math.abs(spread) > 2) failures.push(`${look.id}: has no clarity but the edge moved by ${spread.toFixed(1)}`)
  }

  fs.writeFileSync(`${VERIFY}/all-looks.json`, JSON.stringify(report, null, 2))
  expect(failures).toEqual([])
  expect(problems).toEqual([])
})
