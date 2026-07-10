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

const VERIFY = '_verify/phase5'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

/** Add a title via the toolbar button and return its clip id. */
async function addTitle(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; title?: unknown }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.title)!.id
  })
}

async function updateTitle(page: Page, clipId: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ({ clipId, patch }) => {
      const mod = '/src/state/titleActions.ts'
      const { updateTitle } = (await import(/* @vite-ignore */ mod)) as {
        updateTitle: (id: string, p: Record<string, unknown>) => void
      }
      updateTitle(clipId, patch)
    },
    { clipId, patch },
  )
}

async function previewPixel(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const s = document.createElement('canvas')
      s.width = c.width
      s.height = c.height
      const ctx = s.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { fx, fy },
  )
}

/** Brightest luma across a horizontal row (proves text strokes are present). */
async function previewRowMaxLuma(page: Page, fy: number): Promise<number> {
  return page.evaluate(({ fy }) => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const s = document.createElement('canvas')
    s.width = c.width
    s.height = c.height
    const ctx = s.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const row = ctx.getImageData(0, Math.floor(c.height * fy), c.width, 1).data
    let max = 0
    for (let i = 0; i < row.length; i += 4) max = Math.max(max, (row[i] + row[i + 1] + row[i + 2]) / 3)
    return max
  }, { fy })
}

async function exportPixel(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('2') // SD 640×360
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const path = `${VERIFY}/title.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')
  return page.evaluate(
    async ({ b64, fx, fy }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error('decode failed'))
      })
      video.currentTime = 1
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
    { b64, fx, fy },
  )
}

const near = (a: number, b: number, tol = 36) => Math.abs(a - b) <= tol

test('title creation (button + T shortcut) and Inspector title controls', async ({ page }) => {
  await addTitle(page)
  await expect(page.getByTestId('clip')).toContainText('Title')
  await page.getByTestId('clip').click()
  await expect(page.getByTestId('title-text')).toBeVisible()
  await page.getByTestId('panel-right').screenshot({ path: `${VERIFY}/title-controls.png` })

  // The T shortcut adds a second title (focus the app first so the keymap sees it).
  await page.locator('body').click()
  await page.keyboard.press('t')
  await expect(page.getByTestId('clip')).toHaveCount(2)
})

test('a background shape renders identically in preview and export', async ({ page }) => {
  const clipId = await addTitle(page)
  // A solid box covering the frame → a font-independent solid pixel to compare.
  await updateTitle(page, clipId, {
    text: '',
    box: { color: 'rgb(34, 204, 136)', paddingPx: 400, radiusPx: 0 },
  })
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } }) // 1s, inside the title
  await expect
    .poll(async () => (await previewPixel(page, 0.5, 0.5))[1], { timeout: 8_000 })
    .toBeGreaterThan(150) // green channel high
  const pv = await previewPixel(page, 0.5, 0.5)
  expect(pv[1]).toBeGreaterThan(150)
  expect(pv[0]).toBeLessThan(120)
  await page.screenshot({ path: `${VERIFY}/shape-preview.png` })

  const ex = await exportPixel(page, 0.5, 0.5)
  expect(near(pv[0], ex[0])).toBeTruthy()
  expect(near(pv[1], ex[1])).toBeTruthy()
  expect(near(pv[2], ex[2])).toBeTruthy()
})

test('title text is drawn (bright strokes) in preview and export', async ({ page }) => {
  const clipId = await addTitle(page)
  await updateTitle(page, clipId, { text: 'HELLO', color: '#ffffff', fontSizePx: 200 })
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } })
  await expect.poll(async () => previewRowMaxLuma(page, 0.5), { timeout: 8_000 }).toBeGreaterThan(180)

  // Export and confirm the text band also has bright pixels.
  const bright = await (async () => {
    await page.getByTestId('export-open').click()
    await page.getByTestId('export-resolution').selectOption('2')
    const dl = page.waitForEvent('download', { timeout: 120_000 })
    await page.getByTestId('export-start').click()
    const d = await dl
    const path = `${VERIFY}/text.mp4`
    await d.saveAs(path)
    const b64 = fs.readFileSync(path).toString('base64')
    return page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const video = document.createElement('video')
      video.muted = true
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
      await new Promise<void>((res) => {
        video.onloadedmetadata = () => res()
      })
      video.currentTime = 1
      await new Promise<void>((res) => {
        video.onseeked = () => res()
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      const row = canvas.getContext('2d')!.getImageData(0, Math.floor(canvas.height * 0.5), canvas.width, 1).data
      let max = 0
      for (let i = 0; i < row.length; i += 4) max = Math.max(max, (row[i] + row[i + 1] + row[i + 2]) / 3)
      return max
    }, b64)
  })()
  expect(bright).toBeGreaterThan(150)
})

test('safe-margins overlay toggles in the monitor', async ({ page }) => {
  await addTitle(page)
  await expect(page.getByTestId('safe-margins')).toHaveCount(0)
  await page.getByTestId('safe-margins-toggle').click()
  await expect(page.getByTestId('safe-margins')).toBeVisible()
  await page.screenshot({ path: `${VERIFY}/safe-margins.png` })
  await page.getByTestId('safe-margins-toggle').click()
  await expect(page.getByTestId('safe-margins')).toHaveCount(0)
})
