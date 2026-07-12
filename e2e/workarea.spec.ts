// The work area (in/out) and exporting just that range (spec §5.6, §4.6 step 1).

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

// See export.spec.ts: headless Chromium has a save picker that a test cannot
// drive. Shadowing it takes the buffered download path.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/workarea'

// The fixture is RED for source t < 1s and BLUE after. One clip on V1 gives a
// ~2s sequence. Marking in at 1.2s means a correct export starts on BLUE.

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

const DEFAULT_PX_PER_S = 60

async function addClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** Park the playhead by clicking the ruler, then press a transport key. */
async function markAt(page: Page, tS: number, key: 'i' | 'o'): Promise<void> {
  await page.getByTestId('ruler').click({ position: { x: tS * DEFAULT_PX_PER_S, y: 10 } })
  await page.keyboard.press(key)
}

async function points(page: Page): Promise<{ inS?: number; outS?: number }> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { inPointS?: number; outPointS?: number }
    }
    const seq = activeSequence(useStore.getState().project)
    return { inS: seq.inPointS, outS: seq.outPointS }
  })
}

test('I and O mark the work area, and it shows on the ruler', async ({ page }) => {
  await addClip(page)
  await expect(page.getByTestId('work-area')).toHaveCount(0)

  await markAt(page, 0.5, 'i')
  await expect(page.getByTestId('work-area')).toBeVisible()
  await expect(page.getByTestId('work-area-in')).toBeVisible()

  await markAt(page, 1.5, 'o')
  const p = await points(page)
  expect(p.inS).toBeCloseTo(0.5, 1)
  expect(p.outS).toBeCloseTo(1.5, 1)
  await page.getByTestId('ruler').screenshot({ path: `${VERIFY}/work-area.png` })
})

test('Alt+X clears the work area', async ({ page }) => {
  await addClip(page)
  await markAt(page, 0.5, 'i')
  await markAt(page, 1.5, 'o')
  await expect(page.getByTestId('work-area')).toBeVisible()

  await page.keyboard.press('Alt+x')
  await expect(page.getByTestId('work-area')).toHaveCount(0)
  expect(await points(page)).toEqual({ inS: undefined, outS: undefined })
})

test('dropping the in point past the out point clears the out point', async ({ page }) => {
  await addClip(page)
  await markAt(page, 0.4, 'o')
  await markAt(page, 1.2, 'i') // past it
  const p = await points(page)
  expect(p.inS).toBeCloseTo(1.2, 1)
  expect(p.outS).toBeUndefined()
})

test('the export dialog offers the work area, and defaults to it', async ({ page }) => {
  await addClip(page)

  // With no work area the range picker is disabled and reads "entire sequence".
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-range')).toBeDisabled()
  await expect(page.getByTestId('export-range')).toHaveValue('sequence')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByTestId('export-range')).toHaveCount(0)

  await markAt(page, 1.2, 'i')
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-range')).toBeEnabled()
  await expect(page.getByTestId('export-range')).toHaveValue('workArea')
})

test('exporting the work area renders only that range, starting AT the in point', async ({ page }) => {
  test.setTimeout(180_000)
  await addClip(page)

  // Full-sequence duration first, so the trimmed export can be compared to it.
  const fullDurationS = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { durationS: number }
    }
    return activeSequence(useStore.getState().project).durationS
  })
  expect(fullDurationS).toBeGreaterThan(1.5)

  // Mark in inside the BLUE half of the fixture.
  await markAt(page, 1.2, 'i')

  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-range')).toHaveValue('workArea')
  await page.getByTestId('export-resolution').selectOption('sd') // SD
  await page.getByTestId('export-bitrate').selectOption('low')

  const dl = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const mp4Path = `${VERIFY}/workarea.mp4`
  await download.saveAs(mp4Path)

  const b64 = fs.readFileSync(mp4Path).toString('base64')
  const result = await page.evaluate(async (src) => {
    const bytes = Uint8Array.from(atob(src), (c) => c.charCodeAt(0))
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('decode failed'))
    })
    // Sample the very first frame of the exported file.
    video.currentTime = 0.05
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve()
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)
    const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return { duration: video.duration, rgb: [d[0], d[1], d[2]] }
  }, b64)

  // The trimmed file is roughly (full - 1.2)s, not the whole sequence.
  expect(result.duration).toBeLessThan(fullDurationS - 0.5)
  expect(result.duration).toBeGreaterThan(0.3)

  // And it OPENS on blue. If the range were ignored, or if the render were
  // padded with startS of leading frames, frame 0 would be red or black.
  const [r, , b] = result.rgb
  expect(b).toBeGreaterThan(100)
  expect(b).toBeGreaterThan(r + 40)
})
