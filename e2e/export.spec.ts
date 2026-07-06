import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/export'

// The fixture is red for source t<1s and blue after. Two back-to-back copies
// on V1 give a ~4s sequence: red → blue → red → blue. The golden test decodes
// the exported MP4 and samples center pixels in each region.

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
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
  await page.getByTestId('export-bitrate').selectOption('2') // 5 Mbps

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
