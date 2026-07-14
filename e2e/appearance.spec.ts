import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

// Firefox download path (see phase5): a real save picker can't be driven headless.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
})

const VERIFY = '_verify/appearance'
test.beforeAll(() => fs.mkdirSync(VERIFY, { recursive: true }))

async function addTitle(page: Page): Promise<string> {
  await page.getByTestId('add-title').click()
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
    const titles = seq.tracks.flatMap((t) => t.clips).filter((c) => c.title)
    return titles[titles.length - 1]!.id
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

async function setPlayhead(page: Page, s: number): Promise<void> {
  await page.evaluate(async (s) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (u: { playheadS: number }) => void } }
    }
    useStore.getState().setUI({ playheadS: s })
  }, s)
}

interface ClipData {
  appearance: { in?: string; out?: string; durS?: number } | null
  opacityKf: { t: number; value: number }[] | null
  scaleKf: { t: number; value: number }[] | null
  fontFamily: string | null
  fontSizePx: number | null
}

async function clipData(page: Page, clipId: string): Promise<ClipData> {
  return page.evaluate(async (clipId) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: {
          clips: {
            id: string
            appearance?: { in?: string; out?: string; durS?: number }
            title?: { fontFamily: string; fontSizePx: number }
            keyframes?: { opacity?: { t: number; value: number }[]; scale?: { t: number; value: number }[] }
          }[]
        }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const c = seq.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)
    return {
      appearance: c?.appearance ?? null,
      opacityKf: c?.keyframes?.opacity ?? null,
      scaleKf: c?.keyframes?.scale ?? null,
      fontFamily: c?.title?.fontFamily ?? null,
      fontSizePx: c?.title?.fontSizePx ?? null,
    }
  }, clipId)
}

/** Brightest luma across a horizontal row of the program monitor. */
async function rowMaxLuma(page: Page, fy: number): Promise<number> {
  return page.evaluate((fy) => {
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
  }, fy)
}

/** Strongest "redness" (R − max(G,B)) across a program-monitor row. */
async function rowMaxRedness(page: Page, fy: number): Promise<number> {
  return page.evaluate((fy) => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const s = document.createElement('canvas')
    s.width = c.width
    s.height = c.height
    const ctx = s.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const row = ctx.getImageData(0, Math.floor(c.height * fy), c.width, 1).data
    let max = 0
    for (let i = 0; i < row.length; i += 4) max = Math.max(max, row[i] - Math.max(row[i + 1], row[i + 2]))
    return max
  }, fy)
}

test('entrance preset compiles to keyframes and animates in the preview', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await updateTitle(page, id, { text: 'HELLO', color: '#ffffff', fontSizePx: 200 })

  // Right-click the clip → Entrance ▸ Pop / Bang.
  await page.getByTestId('clip').click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await menu.getByRole('menuitem', { name: 'Entrance' }).hover()
  await menu.getByRole('menuitem', { name: /Pop/ }).click()

  const data = await clipData(page, id)
  expect(data.appearance?.in).toBe('pop')
  expect(data.opacityKf?.[0].value).toBeCloseTo(0, 5) // starts invisible
  expect(data.scaleKf).not.toBeNull() // pop also drives scale

  // Mid-clip: fully visible (bright text). Start-of-clip: near-invisible.
  await setPlayhead(page, 1)
  await expect.poll(() => rowMaxLuma(page, 0.5), { timeout: 8_000 }).toBeGreaterThan(180)
  const mid = await rowMaxLuma(page, 0.5)

  await setPlayhead(page, 0.01)
  await expect.poll(() => rowMaxLuma(page, 0.5), { timeout: 8_000 }).toBeLessThan(120)
  const start = await rowMaxLuma(page, 0.5)
  expect(mid - start).toBeGreaterThan(80)
  await page.screenshot({ path: `${VERIFY}/pop-start.png` })
})

test('save as default carries the appearance to new title clips', async ({ page }) => {
  await page.goto('/')
  const first = await addTitle(page)
  await page.getByTestId('clip').first().click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await menu.getByRole('menuitem', { name: 'Exit' }).hover()
  await menu.getByRole('menuitem', { name: /Fade out/ }).click()
  expect((await clipData(page, first)).appearance?.out).toBe('fadeOut')

  // Save the current appearance as the default for new text (now under Animation ▸).
  await page.getByTestId('clip').first().click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Animation' }).hover()
  await menu.getByRole('menuitem', { name: /Save as default/ }).click()

  // A brand-new title inherits it.
  const second = await addTitle(page)
  expect(second).not.toBe(first)
  expect((await clipData(page, second)).appearance?.out).toBe('fadeOut')
})

test('the Minecraft font renders in both preview and export (worker font path)', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await updateTitle(page, id, {
    text: 'MINE',
    color: '#ffffff',
    fontSizePx: 220,
    fontFamily: "'Monocraft', 'Courier New', monospace",
  })
  await setPlayhead(page, 1)
  await expect.poll(() => rowMaxLuma(page, 0.5), { timeout: 8_000 }).toBeGreaterThan(150)
  await page.screenshot({ path: `${VERIFY}/minecraft-preview.png` })

  // Export (buffered download path) and confirm the text band is bright there too
  // — proving the font loaded in the worker's FontFaceSet without crashing.
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('sd') // SD 640×360
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const path = `${VERIFY}/minecraft.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')
  const bright = await page.evaluate(async (b64) => {
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
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const row = canvas.getContext('2d')!.getImageData(0, Math.floor(canvas.height * 0.5), canvas.width, 1).data
    let max = 0
    for (let i = 0; i < row.length; i += 4) max = Math.max(max, (row[i] + row[i + 1] + row[i + 2]) / 3)
    return max
  }, b64)
  expect(bright).toBeGreaterThan(150)
})

test('right-click Font and Size restyle the title', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  const menu = page.getByTestId('context-menu')

  await page.getByTestId('clip').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Font' }).hover()
  await menu.getByRole('menuitem', { name: 'Minecraft' }).click()
  expect((await clipData(page, id)).fontFamily).toContain('Monocraft')

  await page.getByTestId('clip').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Size' }).hover()
  await menu.getByRole('menuitem', { name: /Large/ }).click()
  expect((await clipData(page, id)).fontSizePx).toBe(160)
})

test('animation speed shrinks the entrance window', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  const menu = page.getByTestId('context-menu')

  await page.getByTestId('clip').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Entrance' }).hover()
  await menu.getByRole('menuitem', { name: /Fade in/ }).click()
  const normalEnd = (await clipData(page, id)).opacityKf!.at(-1)!.t
  expect(normalEnd).toBeCloseTo(0.5, 2)

  await page.getByTestId('clip').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Animation' }).hover()
  await menu.getByRole('menuitem', { name: 'Speed: Fast' }).click()
  const d = await clipData(page, id)
  expect(d.appearance?.durS).toBeCloseTo(0.25, 5)
  expect(d.opacityKf!.at(-1)!.t).toBeCloseTo(0.25, 2) // window halved
})

test('right-click IN the preview opens the clip menu, and the gizmo survives an animation', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await updateTitle(page, id, { text: 'HELLO', fontSizePx: 200 })
  await setPlayhead(page, 2) // settled part of the title

  // Right-click the title in the program monitor → its menu (Font/Entrance/…).
  // The selected title shows the gizmo over the canvas; right-clicking it opens
  // the same in-preview menu.
  await expect(page.getByTestId('gizmo-body')).toBeVisible()
  await page.getByTestId('gizmo-body').click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Entrance' }).hover()
  await menu.getByRole('menuitem', { name: /Bounce/ }).click()
  expect((await clipData(page, id)).appearance?.in).toBe('bounce')

  // The drag gizmo is STILL available on an animated clip (it recompiles on drag).
  await expect(page.getByTestId('gizmo-body')).toBeVisible()
})

test('a text outline renders in preview AND export, and its color is editable', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await updateTitle(page, id, {
    text: 'HELLO',
    color: '#ffffff', // white fill
    fontSizePx: 200,
    outline: { color: 'rgb(255,0,0)', widthPx: 24 }, // red outline
  })
  await setPlayhead(page, 1)
  // A strong red edge (the outline) around the white glyphs, in the preview.
  await expect.poll(() => rowMaxRedness(page, 0.5), { timeout: 8_000 }).toBeGreaterThan(120)
  await page.screenshot({ path: `${VERIFY}/outline.png` })

  // The same red outline survives export (preview == export via the one raster).
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-resolution').selectOption('sd') // SD 640×360
  const dl = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByTestId('export-start').click()
  const download = await dl
  const path = `${VERIFY}/outline.mp4`
  await download.saveAs(path)
  const b64 = fs.readFileSync(path).toString('base64')
  const redness = await page.evaluate(async (b64) => {
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
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const row = canvas.getContext('2d')!.getImageData(0, Math.floor(canvas.height * 0.5), canvas.width, 1).data
    let max = 0
    for (let i = 0; i < row.length; i += 4) max = Math.max(max, row[i] - Math.max(row[i + 1], row[i + 2]))
    return max
  }, b64)
  expect(redness).toBeGreaterThan(80) // SD + H.264 chroma is softer, but clearly red
})

test('the Minecraft font renders Czech diacritics', async ({ page }) => {
  await page.goto('/')
  const id = await addTitle(page)
  await updateTitle(page, id, {
    text: 'PŘÍLIŠ ŽLUŤOUČKÝ KŮŇ',
    color: '#ffffff',
    fontSizePx: 90,
    fontFamily: "'Monocraft', 'Courier New', monospace",
  })
  await setPlayhead(page, 1)
  // Bright strokes across the text row prove the accented glyphs rasterized.
  await expect.poll(() => rowMaxLuma(page, 0.5), { timeout: 8_000 }).toBeGreaterThan(150)
  await page.screenshot({ path: `${VERIFY}/czech.png` })
})
