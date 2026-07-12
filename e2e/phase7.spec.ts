import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

// Headless Chromium HAS showSaveFilePicker, and a real OS picker cannot be driven
// from a test. Shadowing it exercises the documented Firefox path: buffer the file
// and hand it to the browser as a download. The streaming-to-disk path has its own
// test in export.spec.ts, backed by a real OPFS file handle.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase7'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function addClip(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
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

async function exportSample(page: Page, tS: number, fx: number, fy: number): Promise<[number, number, number]> {
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('sd')
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const path = `${VERIFY}/out.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')
  return page.evaluate(
    async ({ b64, tS, fx, fy }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
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
      const d = ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { b64, tS, fx, fy },
  )
}

/** Sample the LAST-exported file again at a different time, without re-exporting
 * (a second exportSample would be blocked by the still-open export dialog). */
async function sampleExportedAt(page: Page, tS: number, fx: number, fy: number): Promise<[number, number, number]> {
  const b64 = fs.readFileSync(`${VERIFY}/out.mp4`).toString('base64')
  return page.evaluate(
    async ({ b64, tS, fx, fy }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
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
      const d = ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { b64, tS, fx, fy },
  )
}

async function setSpeed(page: Page, clipId: string, speed: number): Promise<void> {
  await page.evaluate(
    async ({ clipId, speed }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const { setClipSpeed } = (await import(/* @vite-ignore */ editsMod)) as {
        setClipSpeed: (id: string, s: number) => void
      }
      setClipSpeed(clipId, speed)
    },
    { clipId, speed },
  )
}

const near = (a: number, b: number, tol = 40) => Math.abs(a - b) <= tol

test('applying the colour effects exposes lift/gamma/gain/temperature/tint', async ({ page }) => {
  await addClip(page)

  // Colour is an APPLIED effect now, not an always-on panel section: a fresh
  // clip carries an empty stack, exactly like Premiere.
  await expect(page.getByTestId('effect-stack-empty')).toBeVisible()
  await expect(page.getByTestId('channel-lift')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.locator('[data-testid="effect-item"][data-payload="colorWheels"]').dblclick()
  await page.locator('[data-testid="effect-item"][data-payload="whiteBalance"]').dblclick()

  await expect(page.getByTestId('channel-lift')).toBeVisible()
  await expect(page.getByTestId('channel-gamma')).toBeVisible()
  await expect(page.getByTestId('channel-gain')).toBeVisible()
  await expect(page.getByTestId('channel-temperature')).toBeVisible()
  await expect(page.getByTestId('channel-tint')).toBeVisible()
  await page.getByTestId('panel-right').screenshot({ path: `${VERIFY}/color-controls.png` })
})

test('white-balance (temperature) shifts the image the same way in preview and export', async ({ page }) => {
  const clipId = await addClip(page)
  // Park in the BLUE region (source t > 1s → x≈90 @60px/s).
  await page.getByTestId('ruler').click({ position: { x: 90, y: 10 } })
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[2], { timeout: 10_000 })
    .toBeGreaterThan(120) // blue channel present
  const base = await previewPixel(page, 0.5, 0.5)

  // Cool it hard: red should drop, blue should rise.
  await setChannel(page, clipId, 'temperature', -1)
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
    .toBeLessThan(base[0]) // red reduced by cooling
  const pv = await previewPixel(page, 0.5, 0.5)
  expect(pv[2]).toBeGreaterThanOrEqual(base[2] - 5) // blue held or raised

  const ex = await exportSample(page, 1.5, 0.5, 0.5)
  // Identity: the graded pixel matches in the decoded MP4.
  expect(near(pv[0], ex[0])).toBeTruthy()
  expect(near(pv[1], ex[1])).toBeTruthy()
  expect(near(pv[2], ex[2])).toBeTruthy()
  await page.screenshot({ path: `${VERIFY}/color-graded.png` })
})

test('speeding a clip up shrinks its timeline width', async ({ page }) => {
  const clipId = await addClip(page)
  const clip = page.locator('[data-clip-kind="video"]')
  const before = (await clip.boundingBox())!
  await setSpeed(page, clipId, 2)
  await expect
    .poll(async () => (await clip.boundingBox())!.width, { timeout: 5_000 })
    .toBeLessThan(before.width - 20)
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/speed.png` })
})

test('reverse plays the clip backward in preview and export', async ({ page }) => {
  await addClip(page)
  // Park near the head (source ≈ 0.2s → RED forward).
  await page.getByTestId('ruler').click({ position: { x: 12, y: 10 } })
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[0], { timeout: 10_000 })
    .toBeGreaterThan(120) // red forward

  // Toggle reverse via the Inspector button.
  await page.getByTestId('reverse-toggle').click()
  // Now the head samples the END of the source (t≈1.8s → BLUE).
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[2], { timeout: 10_000 })
    .toBeGreaterThan(120) // blue after reverse
  const pv = await previewPixel(page, 0.5, 0.5)
  const ex = await exportSample(page, 0.2, 0.5, 0.5)
  expect(near(pv[0], ex[0])).toBeTruthy()
  expect(near(pv[1], ex[1])).toBeTruthy()
  expect(near(pv[2], ex[2])).toBeTruthy()

  // The export must WALK the source backward, not freeze on the end frame. The
  // fixture is red for source t<1s, blue after; a full reversed ~2s clip maps a
  // LATE output time → an EARLY source time = RED. A frozen-last-frame bug would
  // show blue there. (Re-sample the same exported file — no second export.)
  const late = await sampleExportedAt(page, 1.6, 0.5, 0.5)
  expect(late[0]).toBeGreaterThan(late[2])
})

async function readScale(page: Page, clipId: string): Promise<number> {
  return page.evaluate(
    async (clipId) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { clips: { id: string; transform: { scale: number } }[] }[] }
      }
      const seq = activeSequence(useStore.getState().project)
      return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.transform.scale
    },
    clipId,
  )
}

test('drag a corner handle in the preview to scale the selected clip', async ({ page }) => {
  const clipId = await addClip(page)
  const gizmo = page.getByTestId('transform-gizmo')
  await expect(gizmo).toBeVisible()
  await page.screenshot({ path: `${VERIFY}/gizmo.png` })

  const before = await readScale(page, clipId)
  // Drag the bottom-right handle outward (away from center) → scale up.
  const handle = page.getByTestId('gizmo-handle-2')
  const b = (await handle.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 90, b.y + 90, { steps: 12 })
  await page.mouse.up()

  const after = await readScale(page, clipId)
  expect(after).toBeGreaterThan(before + 0.1)
  // Undo restores the original scale (single history step).
  await page.keyboard.press('Control+z')
  expect(await readScale(page, clipId)).toBeCloseTo(before, 3)
})

test('clicking a clip in the preview selects it and shows the gizmo', async ({ page }) => {
  const clipId = await addClip(page)
  // Deselect, so the gizmo is hidden to start.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ selection: [] })
  })
  await expect(page.getByTestId('gizmo-body')).toHaveCount(0)

  // Click the video in the preview → it selects and the gizmo appears.
  const canvas = (await page.getByTestId('program-canvas').boundingBox())!
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await expect(page.getByTestId('gizmo-body')).toBeVisible()

  const sel = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection
  })
  expect(sel).toEqual([clipId])
})
