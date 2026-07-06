import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase4'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function addClip(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  // Select the clip and return its id.
  const clipId = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.flatMap((t) => t.clips)[0].id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
  await expect(page.getByTestId('panel-right')).toContainText('clip.webm')
  return clipId
}

async function setChannel(page: Page, clipId: string, channel: string, value: number): Promise<void> {
  await page.evaluate(
    async ({ clipId, channel, value }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const { setChannel } = (await import(/* @vite-ignore */ editsMod)) as {
        setChannel: (id: string, ch: string, v: number) => void
      }
      setChannel(clipId, channel, value)
    },
    { clipId, channel, value },
  )
}

/** Sample the WebGL program canvas at a fractional position via a 2D scratch copy. */
async function previewPixel(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = c.width
      scratch.height = c.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { fx, fy },
  )
}

/** Export once (SD 640×360) and sample the decoded MP4 at several fractional positions. */
async function exportSamples(
  page: Page,
  tS: number,
  positions: [number, number][],
): Promise<[number, number, number][]> {
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('2')
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const path = `${VERIFY}/out.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')
  return page.evaluate(
    async ({ b64, tS, positions }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'video/mp4' })
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(blob)
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error('decode failed'))
      })
      video.currentTime = tS
      await new Promise<void>((res) => {
        video.onseeked = () => res()
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)
      return positions.map(([fx, fy]) => {
        const d = ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data
        return [d[0], d[1], d[2]] as [number, number, number]
      })
    },
    { b64, tS, positions },
  )
}

const near = (a: number, b: number, tol = 40) => Math.abs(a - b) <= tol

test('transform scale renders identically in preview and export', async ({ page }) => {
  const clipId = await addClip(page)
  await setChannel(page, clipId, 'scale', 0.5)
  // Park the playhead in the red region (source < 1s).
  await page.getByTestId('ruler').click({ position: { x: 30, y: 10 } }) // 0.5s

  // At scale 0.5 the image occupies the centre half → 12% from the left is black
  // letterbox, centre is red. Poll to let the frame cache decode.
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
    .toBeGreaterThan(140)
  const pvCenter = await previewPixel(page, 0.5, 0.5)
  const pvEdge = await previewPixel(page, 0.12, 0.5)
  expect(pvCenter[0]).toBeGreaterThan(140) // red centre
  expect(pvEdge[0] + pvEdge[1] + pvEdge[2]).toBeLessThan(90) // black letterbox
  await page.screenshot({ path: `${VERIFY}/scaled-preview.png` })

  const [exCenter, exEdge] = await exportSamples(page, 0.5, [
    [0.5, 0.5],
    [0.12, 0.5],
  ])
  expect(exCenter[0]).toBeGreaterThan(140) // red centre in export too
  expect(exEdge[0] + exEdge[1] + exEdge[2]).toBeLessThan(90) // black edge in export

  // Identity: preview and export agree per channel.
  expect(near(pvCenter[0], exCenter[0])).toBeTruthy()
  expect(near(pvCenter[1], exCenter[1])).toBeTruthy()
  expect(near(pvCenter[2], exCenter[2])).toBeTruthy()
})

test('brightness filter darkens preview and export by the same amount', async ({ page }) => {
  const clipId = await addClip(page)
  await page.getByTestId('ruler').click({ position: { x: 30, y: 10 } }) // 0.5s, red

  const base = await (async () => {
    await expect
      .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
      .toBeGreaterThan(140)
    return previewPixel(page, 0.5, 0.5)
  })()

  await setChannel(page, clipId, 'brightness', -0.5)
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
    .toBeLessThan(base[0] - 20)
  const pv = await previewPixel(page, 0.5, 0.5)
  const [ex] = await exportSamples(page, 0.5, [[0.5, 0.5]])
  expect(near(pv[0], ex[0])).toBeTruthy()
  expect(near(pv[1], ex[1])).toBeTruthy()
  expect(near(pv[2], ex[2])).toBeTruthy()
  await page.screenshot({ path: `${VERIFY}/brightness.png` })
})

test('Effect Controls: stopwatch keyframes a channel and the lane shows a diamond', async ({ page }) => {
  const clipId = await addClip(page)
  await expect(page.getByTestId('channel-scale')).toBeVisible()
  await page.getByTestId('stopwatch-scale').click()
  await expect(page.getByTestId('stopwatch-scale')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('keyframe-lane')).toBeVisible()
  await expect(page.getByTestId('keyframe').first()).toBeVisible()

  // The clip now carries a scale keyframe.
  const animated = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; keyframes?: Record<string, unknown[]> }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
    return (clip?.keyframes?.scale?.length ?? 0) > 0
  }, clipId)
  expect(animated).toBeTruthy()
  await page.getByTestId('panel-right').screenshot({ path: `${VERIFY}/effect-controls.png` })
})

test('transition dropdown applies a cross-dissolve to a two-clip cut', async ({ page }) => {
  await addClip(page)
  await page.getByTestId('asset-card').dblclick() // second clip after the first
  const vclip = page.locator('[data-clip-kind="video"]')
  await expect(vclip).toHaveCount(2)
  await vclip.nth(1).click()
  await page.getByTestId('transition-in').selectOption('crossDissolve')

  const has = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { transitionIn?: { type: string } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).some((c) => c.transitionIn?.type === 'crossDissolve')
  })
  expect(has).toBeTruthy()
})
