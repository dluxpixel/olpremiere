import { expect, test } from '@playwright/test'
import fs from 'node:fs'

// Headless Chromium HAS showSaveFilePicker, and a real OS picker cannot be driven
// from a test. Shadowing it by default exercises the documented Firefox path:
// buffer the file and hand it to the browser as a download. The first test below
// re-stubs it with a REAL OPFS handle to cover the streaming-to-disk path.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/export'

// The fixture is red for source t<1s and blue after. Two back-to-back copies
// on V1 give a ~4s sequence: red → blue → red → blue. The golden test decodes
// the exported MP4 and samples center pixels in each region.

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

test('streaming export writes straight to the chosen file, and it decodes', async ({ page }) => {
  test.setTimeout(180_000)

  // Hand the app a REAL FileSystemFileHandle (from OPFS, which needs no picker),
  // so the worker exercises the true createWritable + stream-to-disk path rather
  // than a mock. addInitScript calls run in order, so this overrides beforeEach.
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getFileHandle('streamed.mp4', { create: true })
    }
  })

  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('2') // SD 640×360
  await page.getByTestId('export-bitrate').selectOption('low')

  // No download event fires: nothing was buffered in memory to hand back.
  await page.getByTestId('export-start').click()
  await expect(page.getByText('where you chose.')).toBeVisible({ timeout: 150_000 })

  // Read the file back out of OPFS and prove it is a real, decodable MP4.
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('streamed.mp4')
    const file = await handle.getFile()
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(file)
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('streamed MP4 failed to decode'))
    })
    return { size: file.size, width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  })

  expect(result.size).toBeGreaterThan(20_000)
  expect(result.width).toBe(640)
  expect(result.height).toBe(360)
  // moov sits at the END of a streamed file. A decoder handed the whole file
  // still reads the duration; this assertion fails if the target is mis-wired.
  expect(result.duration).toBeGreaterThan(1)
})

test('Maximum quality (1:1) exports a valid, decodable MP4', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('2') // SD keeps CI encoding fast
  await page.getByTestId('export-bitrate').selectOption('max') // the new highest-quality option

  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-start').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/max-quality.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(20_000)

  const meta = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res()
      video.onerror = () => rej(new Error('Maximum-quality MP4 failed to decode'))
    })
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  }, fs.readFileSync(mp4Path).toString('base64'))
  expect(meta.width).toBe(640)
  expect(meta.height).toBe(360)
  expect(meta.duration).toBeGreaterThan(1)
})

test('golden export: the MP4 matches the composited sequence', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('asset-card').dblclick() // resolves to the gap after clip 1
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('2') // SD 640×360
  await page.getByTestId('export-bitrate').selectOption('low') // 5 Mbps

  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-start').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/golden.mp4`
  await download.saveAs(mp4Path)
  await page.screenshot({ path: `${VERIFY}/export-done.png` })

  const stat = fs.statSync(mp4Path)
  expect(stat.size).toBeGreaterThan(20_000)

  // Decode the exported file back in the browser and sample pixels.
  const b64 = fs.readFileSync(mp4Path).toString('base64')
  const result = await page.evaluate(async (b64src) => {
    const bytes = Uint8Array.from(atob(b64src), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('exported MP4 failed to decode'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const c2d = canvas.getContext('2d')!
    const sample = async (t: number): Promise<number[]> => {
      video.currentTime = t
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
      })
      c2d.drawImage(video, 0, 0)
      const d = c2d.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      ).data
      return [d[0], d[1], d[2]]
    }
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      atHalf: await sample(0.5), // clip 1, source 0.5s → red
      atMidBlue: await sample(1.6), // clip 1, source 1.6s → blue
      atClip2: await sample(2.45), // clip 2, source ~0.45s → red
    }
  }, b64)

  expect(result.width).toBe(640)
  expect(result.height).toBe(360)
  expect(result.duration).toBeGreaterThan(3.2)
  expect(result.duration).toBeLessThan(4.8)

  const [r1, g1, b1] = result.atHalf
  expect(r1).toBeGreaterThan(160) // #e63946 red
  expect(g1).toBeLessThan(120)
  expect(b1).toBeLessThan(120)

  const [r2, , b2] = result.atMidBlue
  expect(b2).toBeGreaterThan(120) // #2b6cb0 blue
  expect(r2).toBeLessThan(110)

  const [r3, g3, b3] = result.atClip2
  expect(r3).toBeGreaterThan(160) // red again in clip 2
  expect(g3).toBeLessThan(120)
  expect(b3).toBeLessThan(120)
})

test('export cancel returns to settings without a file', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-start').click()
  // Cancel as soon as the progress UI appears.
  await page.getByTestId('export-cancel').click({ timeout: 10_000 })
  await expect(page.getByTestId('export-start')).toBeVisible({ timeout: 10_000 })
})
