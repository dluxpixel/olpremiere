import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import { shrinkSequence } from './exportHelpers'

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

  // Export has no settings: the raster follows the sequence, so a small
  // sequence is how this test asks for a small file.
  await shrinkSequence(page)

  // No download event fires: nothing was buffered in memory to hand back.
  await page.getByTestId('export-open').click()
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

test('a 1080p timeline exports at 1080p - no upscale', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // An HD (1080p) timeline is raised one tier to 1440p (the YouTube sweet spot)
  // automatically, with no dialog and nothing to choose. This is also the only
  // export test above H.264 level 4.0 in landscape, and the CQP path at HD.
  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/upscale-1440p.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(20_000)

  const meta = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res()
      video.onerror = () => rej(new Error('1440p MP4 failed to decode'))
    })
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  }, fs.readFileSync(mp4Path).toString('base64'))
  expect(meta.width).toBe(1920)
  expect(meta.height).toBe(1080)
  expect(meta.duration).toBeGreaterThan(1)

  // The audio must be AAC, not Opus. Chrome's AAC encoder refuses 256 kbps and
  // above, and the plan asks for 320k at HD, so the codec probe used to fall
  // through to OPUS INSIDE AN MP4: a file most players and phones play silently.
  // Every HD export he made was mute while the SD golden one was fine. Checked on
  // the container bytes, so it holds without a decoder that tolerates either.
  const container = fs.readFileSync(mp4Path).toString('latin1')
  expect(container).toContain('mp4a')
  expect(container).not.toContain('dOps') // the Opus-in-MP4 sample entry
})

test('a 9:16 Shorts sequence exports at its own portrait size (the crash case)', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Switch to a vertical Shorts sequence, the format of the real-world crash.
  await page.getByTestId('format-select').selectOption('9:16')

  // Portrait timelines get a true VERTICAL upscale: 1440×2560, never a
  // stretched landscape frame, with nothing to choose.
  const downloadPromise = page.waitForEvent('download', { timeout: 280_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  const mp4Path = `${VERIFY}/portrait-1440p.mp4`
  await download.saveAs(mp4Path)
  expect(fs.statSync(mp4Path).size).toBeGreaterThan(20_000)

  const meta = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const video = document.createElement('video')
    video.muted = true
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res()
      video.onerror = () => rej(new Error('portrait 1440p MP4 failed to decode'))
    })
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration }
  }, fs.readFileSync(mp4Path).toString('base64'))
  expect(meta.width).toBe(1080)
  expect(meta.height).toBe(1920)
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

  await shrinkSequence(page) // 640×360, the golden raster

  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-open').click()
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

test('export cancel closes the dialog without a file', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  await shrinkSequence(page)
  await page.getByTestId('export-open').click()
  // Cancel as soon as the progress UI appears.
  await page.getByTestId('export-cancel').click({ timeout: 10_000 })
  await expect(page.getByTestId('export-dialog')).toHaveCount(0, { timeout: 10_000 })
})

/**
 * ⛔ THE ONE THING NOTHING IN THIS REPO MEASURED, 2026-08-27.
 *
 * There is a real perf gate: `perfGuard.test.ts` benches the frame resolver, the
 * snap points and the drag preview, and `play-cost`, `scrub-cost`, `play-latency`
 * and `edit-cost-at-scale` bench the picture end to end. Every one of them was
 * green through the week his editor was holding 3.9 GB with 4 GB free of 32, and
 * green through the day he said *"this app is going completely shit."* They
 * measure TIME. Nothing measured MEMORY, so 960 MB of fixed cache budget grew
 * under them without a single red run.
 *
 * An export is where this bites hardest and where it is easiest to catch: it runs
 * for minutes, touches every cache the app owns, and is the one operation whose
 * cost is supposed to be flat in its own length. `MAX_ENCODE_QUEUE = 4` and
 * `FRAME_CREDIT = 3` bound the encoder by construction; this asserts the rest of
 * the app does not quietly grow beside them.
 *
 * ⚠️ IT IS A TRIPWIRE, NOT A BENCHMARK. It reads the page's memory rather than
 * the process, so it will never see a GPU texture, or anything the export worker
 * holds (a separate heap, and gone when the worker ends).
 *
 * ⛔ AND FOR ITS FIRST SIX WEEKS IT COULD NOT FAIL (found 2026-10-06). It read
 * `performance.memory`, which without --enable-precise-memory-info Chromium
 * buckets and refreshes about every 20 minutes, so "before" and "after" a five
 * second export were the same cached number: 25/25, 30/30, 32/32, 32/32, 28/28,
 * grew 0 on every logged run. It reads the heap over the DevTools protocol now,
 * after a garbage collection, and first proves it can see a deliberate 50 MB, both
 * as JavaScript values and as a buffer (the JS heap alone missed buffers). The budget is
 * deliberately loose: it is here to catch an order-of-magnitude regression, the
 * kind that reaches him, not to police a few MB. If it trips, something started
 * holding on to whole frames or whole buffers. Find that; do not raise the number
 * without a measurement written down here.
 */
test('an export does not grow the heap without bound', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')

  // What the page still holds after a full collection: retained memory, which is
  // what "grows without bound" means, and never garbage that is merely uncollected.
  //
  // ⛔ THE JS HEAP ALONE IS BLIND TO BUFFERS (found 2026-10-07). `usedSize` counts
  // JavaScript objects, but the bytes of an ArrayBuffer, a typed array or a frame's
  // pixels live in backing storage outside it, so the first version of this read
  // a page that kept a 32 MB buffer for every progress report of the export (about
  // 1.5 GB) as "before 20 MB, after 20 MB, grew 0 MB". Whole frames and whole
  // buffers are the leak this exists for, so the reading is the JS heap plus the
  // buffers' backing storage plus Blink's own heap, where DOM objects live.
  const cdp = await page.context().newCDPSession(page)
  const heapMb = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage')
    const { usedSize, embedderHeapUsedSize, backingStorageSize } = await cdp.send('Runtime.getHeapUsage')
    return Math.round((usedSize + embedderHeapUsedSize + backingStorageSize) / 1048576)
  }

  // THE INSTRUMENT PROVES IT CAN SEE FIRST: 50 MB held on the page has to show, and
  // has to go again once it is let go, both as plain JavaScript values and as a
  // buffer. A reading that cannot move is how this test stayed green for six weeks.
  type Ballast = { __ballast?: unknown }
  const sees = async (what: string, hold: () => void): Promise<void> => {
    const base = await heapMb()
    await page.evaluate(hold)
    const held = await heapMb()
    await page.evaluate(() => {
      delete (window as unknown as Ballast).__ballast
    })
    const released = await heapMb()
    console.log(`[export heap] instrument check, ${what}: ${base} MB, holding 50 MB ${held} MB, let go ${released} MB`)
    expect(held - base, `the reading must see 50 MB of ${what} being held`).toBeGreaterThanOrEqual(40)
    expect(held - released, `and see the ${what} let go`).toBeGreaterThanOrEqual(40)
  }
  await sees('JavaScript values', () => {
    ;(window as unknown as Ballast).__ballast = Array.from({ length: 6_553_600 }, (_, i) => i + 0.5)
  })
  await sees('buffer', () => {
    ;(window as unknown as Ballast).__ballast = new Uint8Array(52_428_800).fill(1)
  })

  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  // Four clips, so the sweep opens and closes several providers rather than one.
  for (let i = 0; i < 4; i++) await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(4)
  await shrinkSequence(page)

  const before = await heapMb()

  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 })
  await page.getByTestId('export-open').click()
  const download = await downloadPromise
  await download.saveAs(`${VERIFY}/heap.mp4`)

  const after = await heapMb()
  const grew = after - before

  // Reported on every run, pass or fail. A number in the log is what lets a
  // later session see a trend instead of only a breach, which is the whole
  // reason the cache growth went unnoticed for a week.
  console.log(`[export heap] before ${before} MB, after ${after} MB, grew ${grew} MB, budget 150 MB`)

  // MEASURED 2026-08-27 ON THIS FIXTURE: before 25 MB, after 25 MB, grew 0. That
  // reading was the cached number (see above), so it proved nothing.
  //
  // MEASURED 2026-10-07 AND 2026-10-08 WITH THIS READING, ON THIS FIXTURE (about 235
  // frames at 640x360): before 38 MB, after 38 MB, grew 0, on both runs. What it
  // catches at 150 MB, each tried on purpose: the page keeping one frame for every
  // frame exported, grew 220 MB, red; a 32 MB buffer per progress report, grew
  // 1526 MB, red. What it lets through: one frame kept for every fifth frame
  // exported, grew 45 MB, green. The number is unchanged. If this ever trips,
  // something began holding whole frames or whole buffers; find that rather than
  // raising the number.
  expect(grew).toBeLessThan(150)
})
