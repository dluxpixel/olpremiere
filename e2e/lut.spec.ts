// LUT import, end to end: a .cube file chosen in the Inspector grades the program
// monitor the way the file says, and the exported file shows the same grade.
//
// The picture is the chart in gradeChart.ts: flat patches of known colour. Each
// check reads the monitor (or the exported MP4) at those patches and compares it
// with sampleCube (effects/cube.ts), the plain TypeScript twin of what the shader
// does with the same table. Every .cube file is written into this test's own
// output folder, never into the repo.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { PATCHES, gap, gpuName, putChartOnTimeline, readSpots, readSpotsFromFile, type Rgb, type Spot } from './gradeChart'
import { parkModules, selectClips, setUI, type ParkedWindow } from './storeWrites'

const VERIFY = '_verify/lut'

// Same as export.spec.ts: no save picker, so the export arrives as a download.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

// ---------------------------------------------------------------------------
// The .cube files. Red moves fastest in a 3D table, as in every grading tool.

const row = (v: readonly number[]): string => v.map((x) => x.toFixed(6)).join(' ')

function cube3d(title: string, size: number, fn: (r: number, g: number, b: number) => Rgb): string {
  const rows = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const top = size - 1
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) rows.push(row(fn(r / top, g / top, b / top)))
  return rows.join('\n') + '\n'
}

function cube1d(title: string, size: number, fn: (x: number) => number): string {
  const rows = [`TITLE "${title}"`, `LUT_1D_SIZE ${size}`]
  for (let i = 0; i < size; i++) {
    const v = fn(i / (size - 1))
    rows.push(row([v, v, v]))
  }
  return rows.join('\n') + '\n'
}

/** Channels rotated, a level squeeze on one and a curve on another: nothing like the input, and not a straight line between table steps. */
const ROTATE = (r: number, g: number, b: number): Rgb => [g, 0.1 + 0.8 * b, r * r]

/** Write a file into this test's own output folder and return its path. */
function writeCube(name: string, text: string): string {
  const file = test.info().outputPath(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

// ---------------------------------------------------------------------------
// The page.

/** The chart on the timeline with a LUT effect added from the Effects tab, no file chosen yet. */
async function chartWithLutEffect(page: Page): Promise<{ clipId: string; effectId: string }> {
  await page.goto('/')
  const clipId = await putChartOnTimeline(page)
  await selectClips(page, [clipId])
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.getByTestId('effect-search').fill('lut')
  await page.locator('[data-testid="effect-item"][data-payload="lut"]').dblclick()
  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  await expect(page.getByTestId('lut-name')).toHaveText('No LUT chosen yet')
  await expect(page.getByTestId('channel-amount')).toBeVisible()
  const effectId = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { effects: { id: string; type: string }[] }[] }[] }
    }
    const fx = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips.flatMap((c) => c.effects))
    return fx.find((e) => e.type === 'lut')!.id
  })
  return { clipId, effectId }
}

async function setAmount(page: Page, clipId: string, effectId: string, amount: number): Promise<void> {
  // The import is its own step and the write runs synchronously (e2e/storeWrites.ts).
  await parkModules(page, ['/src/state/clipEdits.ts'])
  await page.evaluate(
    ({ clipId, effectId, amount }) => {
      const { setEffectParamValue } = (window as unknown as ParkedWindow).__e2eMods['/src/state/clipEdits.ts'] as {
        setEffectParamValue: (clipId: string, effectId: string, key: string, value: number) => void
      }
      setEffectParamValue(clipId, effectId, 'amount', amount)
    },
    { clipId, effectId, amount },
  )
}

/** What the chart's spots should read after a table at `amount`: the table's own answer, mixed with the picture. */
async function expectedFromCube(page: Page, text: string, spots: Spot[], amount: number): Promise<Record<string, Rgb>> {
  return page.evaluate(
    async ({ text, spots, amount }) => {
      const cubeMod = '/src/engine/effects/cube.ts'
      const { parseCube, sampleCube } = (await import(/* @vite-ignore */ cubeMod)) as {
        parseCube: (t: string) => unknown
        sampleCube: (c: unknown, rgb: number[]) => number[]
      }
      const cube = parseCube(text)
      const out: Record<string, number[]> = {}
      for (const s of spots) {
        const src = s.rgb.map((v) => v / 255)
        const graded = sampleCube(cube, src)
        out[s.name] = src.map((v, k) => (v + (graded[k] - v) * amount) * 255)
      }
      return out as Record<string, Rgb>
    },
    { text, spots, amount },
  )
}

const rounded = (m: Record<string, Rgb>): string => JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map(Math.round)])))

/**
 * Read the monitor until every spot is within `tol` of `expected`. The frame on the
 * canvas when a change is made is the last one's, so the first reads can be stale.
 * Fails with both sets of numbers, so a miss can be read off the message.
 */
async function monitorReaches(page: Page, expected: Record<string, Rgb>, tol: number, label: string): Promise<Record<string, Rgb>> {
  const spots = PATCHES
  let last: Record<string, Rgb> = {}
  let worst = Infinity
  for (let i = 0; i < 28; i++) {
    last = await readSpots(page, spots)
    worst = Math.max(...spots.map((s) => gap(last[s.name], expected[s.name])))
    if (worst <= tol) return last
    await page.waitForTimeout(250)
  }
  throw new Error(`${label}: worst gap ${worst.toFixed(1)} over ${tol}. Monitor ${rounded(last)} but expected ${rounded(expected)}`)
}

const sourceOf = (): Record<string, Rgb> => Object.fromEntries(PATCHES.map((p) => [p.name, p.rgb]))

/** The most any spot moved from the picture as drawn. */
const movedBy = (m: Record<string, Rgb>): number => Math.max(...PATCHES.map((p) => gap(m[p.name], p.rgb)))

// ---------------------------------------------------------------------------

test('a .cube chosen in the Inspector grades the monitor the way the file says, Amount scales it, and 0 passes the picture through', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { clipId, effectId } = await chartWithLutEffect(page)
  test.info().annotations.push({ type: 'gpu', description: await gpuName(page) })

  // A LUT effect with no file draws nothing, the picture is the chart as drawn.
  await monitorReaches(page, sourceOf(), 3, 'no file yet')

  const text = cube3d('rotate', 17, ROTATE)
  await page.getByTestId('lut-file').setInputFiles(writeCube('rotate.cube', text))
  await expect(page.getByTestId('lut-name')).toHaveText('rotate.cube')
  await expect(page.getByTestId('lut-error')).toHaveCount(0)

  const full = await monitorReaches(page, await expectedFromCube(page, text, PATCHES, 1), 3, 'Amount 1')
  // The table really did something big: this is not a pass-through that happens to agree.
  expect(movedBy(full)).toBeGreaterThan(40)

  await setAmount(page, clipId, effectId, 0.5)
  await monitorReaches(page, await expectedFromCube(page, text, PATCHES, 0.5), 3, 'Amount 0.5')

  await setAmount(page, clipId, effectId, 0)
  await monitorReaches(page, sourceOf(), 2, 'Amount 0')
  fs.writeFileSync(`${VERIFY}/rotate.json`, JSON.stringify({ gpu: await gpuName(page), full }, null, 2))
})

test('the table is part of the project: it is still on the clip after the page is reloaded', async ({ page }) => {
  test.setTimeout(180_000)
  const { clipId, effectId } = await chartWithLutEffect(page)
  const text = cube3d('rotate', 9, ROTATE)
  await page.getByTestId('lut-file').setInputFiles(writeCube('rotate9.cube', text))
  await expect(page.getByTestId('lut-name')).toHaveText('rotate9.cube')
  await setAmount(page, clipId, effectId, 0.8)
  const expected = await expectedFromCube(page, text, PATCHES, 0.8)
  await monitorReaches(page, expected, 3, 'before the reload')

  // The debounced autosave (about a second) has to reach the database first.
  await page.waitForTimeout(2000)
  await page.reload()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1, { timeout: 20_000 })
  await setUI(page, { playheadS: 0.5 })
  await monitorReaches(page, expected, 3, 'after the reload')
})

test('1D tables work too, and a table with more than 256 rows is read through to its last row', async ({ page }) => {
  test.setTimeout(180_000)
  await chartWithLutEffect(page)
  const input = page.getByTestId('lut-file')

  const invert = cube1d('invert', 33, (x) => 1 - x)
  await input.setInputFiles(writeCube('invert.cube', invert))
  await expect(page.getByTestId('lut-name')).toHaveText('invert.cube')
  const inverted = await monitorReaches(page, await expectedFromCube(page, invert, PATCHES, 1), 3, '1D invert')
  expect(movedBy(inverted)).toBeGreaterThan(40)

  // 1024 rows: wider than one row of the texture the renderer stores a 1D table in.
  const squared = cube1d('squared', 1024, (x) => x * x)
  await input.setInputFiles(writeCube('squared.cube', squared))
  await expect(page.getByTestId('lut-name')).toHaveText('squared.cube')
  const dark = await monitorReaches(page, await expectedFromCube(page, squared, PATCHES, 1), 3, '1D 1024 rows')
  expect(movedBy(dark)).toBeGreaterThan(30)
})

test('the largest table the app reads (65 steps) set to the identity passes the picture through', async ({ page }) => {
  test.setTimeout(180_000)
  await chartWithLutEffect(page)
  const identity = cube3d('identity65', 65, (r, g, b) => [r, g, b])
  await page.getByTestId('lut-file').setInputFiles(writeCube('identity65.cube', identity))
  await expect(page.getByTestId('lut-name')).toHaveText('identity65.cube', { timeout: 20_000 })
  // An identity table gives the colours back to within the 8 bit rounding of the monitor.
  await monitorReaches(page, sourceOf(), 2, 'identity 65')
})

test('the export shows the same grade the monitor shows', async ({ page }) => {
  test.setTimeout(300_000)
  const { clipId, effectId } = await chartWithLutEffect(page)
  const text = cube3d('rotate', 17, ROTATE)
  await page.getByTestId('lut-file').setInputFiles(writeCube('rotate.cube', text))
  await expect(page.getByTestId('lut-name')).toHaveText('rotate.cube')
  await setAmount(page, clipId, effectId, 0.7)
  const expected = await expectedFromCube(page, text, PATCHES, 0.7)
  const onMonitor = await monitorReaches(page, expected, 3, 'monitor before the export')
  expect(movedBy(onMonitor)).toBeGreaterThan(30)

  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/lut-e2e.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(10_000)

  const fromFile = await readSpotsFromFile(page, fs.readFileSync(mp4Path), PATCHES, 0.5)
  expect(fromFile.width).toBe(1280)
  expect(fromFile.height).toBe(720)
  fs.writeFileSync(`${VERIFY}/lut-e2e.json`, JSON.stringify({ gpu: await gpuName(page), expected, onMonitor, fromFile: fromFile.spots }, null, 2))

  // Within what an H.264 round trip costs, channel by channel, against both the numbers and the monitor.
  for (const p of PATCHES) {
    expect(gap(fromFile.spots[p.name], expected[p.name]), `${p.name} in the file ${rounded(fromFile.spots)} vs the table ${rounded(expected)}`).toBeLessThan(10)
    expect(gap(fromFile.spots[p.name], onMonitor[p.name]), `${p.name} in the file vs the monitor`).toBeLessThan(10)
  }
})

test('a file that is not a LUT says why in plain words and changes nothing', async ({ page }) => {
  test.setTimeout(120_000)
  await chartWithLutEffect(page)
  const input = page.getByTestId('lut-file')
  const cases: [string, string, RegExp][] = [
    ['notes.cube', 'this is a note to myself, not a LUT\n', /LUT/],
    ['short.cube', 'LUT_3D_SIZE 3\n0 0 0\n1 1 1\n', /cut short/],
    ['huge.cube', 'LUT_3D_SIZE 99\n', /bigger than this app reads/],
  ]
  for (const [name, text, words] of cases) {
    await input.setInputFiles(writeCube(name, text))
    const error = page.getByTestId('lut-error')
    await expect(error).toBeVisible()
    await expect(error).toHaveText(words)
    // No jargon, no stack: the words a person can act on.
    await expect(error).not.toContainText(/Error:|undefined|at \w+\(/)
    await expect(page.getByTestId('lut-name')).toHaveText('No LUT chosen yet')
  }
  // The picture is the chart as drawn: nothing was applied.
  await monitorReaches(page, sourceOf(), 3, 'after broken files')

  // A good file after a bad one clears the message and loads.
  const text = cube3d('rotate', 5, ROTATE)
  await input.setInputFiles(writeCube('good.cube', text))
  await expect(page.getByTestId('lut-name')).toHaveText('good.cube')
  await expect(page.getByTestId('lut-error')).toHaveCount(0)
  await monitorReaches(page, await expectedFromCube(page, text, PATCHES, 1), 3, 'good file after bad ones')
})
