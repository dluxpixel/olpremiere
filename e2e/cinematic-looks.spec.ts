// The cinematic looks, end to end: picked from the Looks shelf onto TWO selected
// clips, seen on the program monitor, and exported. The exported file has to show
// the same picture the monitor showed, because both are drawn by the one shared
// renderer (effects/looks.ts, render/glRenderer.ts).

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { shrinkSequence } from './exportHelpers'

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
