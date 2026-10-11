// The TikTok and Reels guides, and hold to compare (his asks, 2026-10-08: "TikTok and Reels
// guides plus hold to compare").
//
// What a person would check, in the order they would check it:
//   - on a tall shape the guides can be switched on in the Frame menu and sit over the picture,
//   - Reels draws different areas than TikTok,
//   - on a wide shape they are gone and the menu says why, and they come back on a tall one,
//   - holding R (or the Before button) shows the picture without its effects, on real canvas
//     pixels, with a badge saying so, and letting go brings the effects back exactly,
//   - none of it is an edit: the undo stack is the same length.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { ffmpegAvailable, runFfmpeg } from './exportHelpers'
import { addEffect } from './addEffect'

test.skip(!ffmpegAvailable(), 'needs the bundled ffmpeg (vendor/ffmpeg), which a fresh worktree does not have')

const VERIFY = '_verify/guides'
const SRC = `${VERIFY}/grid-1920x1080.mp4`

test.beforeAll(async () => {
  fs.mkdirSync(VERIFY, { recursive: true })
  const r = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0xb07848:s=1920x1080:r=30:d=2,drawgrid=w=60:h=60:t=6:c=0xf0d090',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30', SRC,
  ])
  expect(r.code, r.err.slice(-400)).toBe(0)
})

async function open(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(SRC)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** The Frame menu, opened. */
async function frameMenu(page: Page): Promise<void> {
  await page.getByTestId('frame-settings-button').click()
  await expect(page.getByTestId('frame-settings-menu')).toBeVisible()
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('frame-settings-menu')).toBeHidden()
}

/** Copy the monitor canvas into a page variable, so two moments can be compared in the page itself. */
async function snap(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const src = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(src, 0, 0)
    ;(window as unknown as Record<string, ImageData>)[n] = ctx.getImageData(0, 0, c.width, c.height)
  }, name)
}

/** Mean absolute difference, per colour channel out of 255, between two snapshots. */
async function diff(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(([x, y]) => {
    const w = window as unknown as Record<string, ImageData>
    const p = w[x].data
    const q = w[y].data
    let sum = 0
    let n = 0
    for (let i = 0; i < p.length; i += 4) {
      sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])
      n += 3
    }
    return sum / n
  }, [a, b])
}

/** The share of pixels in a snapshot that are not black, so a blank canvas cannot pass for a picture. */
async function litShare(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    const d = (window as unknown as Record<string, ImageData>)[n].data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++
    return lit / (d.length / 4)
  }, name)
}

const undoDepth = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { history: { undo: unknown[] } } }
    }
    return useStore.getState().history.undo.length
  })

test('the app guides sit over a tall picture, switch app, and say why they are gone on a wide one', async ({ page }) => {
  await open(page)
  await page.getByTestId('format-select').selectOption('9:16')
  await frameMenu(page)
  await page.getByTestId('app-guides-toggle').check()
  await closeMenu(page)

  const guides = page.getByTestId('app-guides')
  await expect(guides).toBeVisible()
  await expect(guides).toHaveAttribute('data-app', 'tiktok')
  const box = (await guides.boundingBox())!
  const heightOf = async (k: string) => (await page.getByTestId(`app-guide-${k}`).boundingBox())!.height
  // TikTok on 1080 x 1920: 150 at the top, 440 at the bottom.
  expect(await heightOf('top')).toBeCloseTo((150 / 1920) * box.height, 0)
  expect(await heightOf('bottom')).toBeCloseTo((440 / 1920) * box.height, 0)

  await frameMenu(page)
  await page.getByTestId('app-guides-reels').click()
  await closeMenu(page)
  await expect(guides).toHaveAttribute('data-app', 'reels')
  expect(await heightOf('top')).toBeCloseTo((220 / 1920) * box.height, 0)
  expect(await heightOf('bottom')).toBeCloseTo((420 / 1920) * box.height, 0)

  await page.getByTestId('format-select').selectOption('16:9')
  await expect(page.getByTestId('app-guides')).toHaveCount(0)
  await frameMenu(page)
  const reason = 'App guides are for tall videos. Switch the shape to 9:16 or Phone to see them.'
  await expect(page.getByTestId('app-guides-hint')).toHaveText(reason)
  await expect(page.getByTestId('app-guides-toggle').locator('xpath=ancestor::label')).toHaveAttribute('title', reason)
  await closeMenu(page)

  await page.getByTestId('format-select').selectOption('phone')
  await expect(page.getByTestId('app-guides')).toBeVisible()
  // Phone: the Reels bottom band loses the app bar's 228 px, so 192 of 2112.
  const phoneBox = (await page.getByTestId('app-guides').boundingBox())!
  expect(await heightOf('bottom')).toBeCloseTo((192 / 2112) * phoneBox.height, 0)
})

/**
 * A clip with an effect that visibly changes the picture, and three snapshots to hold against.
 *
 * ⛔ THE EFFECT MUST SHOW. Gaussian Blur is added at a radius of 0, so it changes nothing, and a
 * hold test built on it passes or fails on nothing at all (it did, 2026-10-11: the held picture
 * was identical to the real one because the real one had no visible effect). Vignette is added at
 * 0.5, which darkens the corners, and the first thing checked here is that the real canvas really
 * differs from the canvas without it.
 */
async function clipWithVisibleEffect(page: Page): Promise<{ undo: number }> {
  await open(page)
  await page.locator('[data-clip-kind="video"]').click()
  await snap(page, 'plain')
  expect(await litShare(page, 'plain')).toBeGreaterThan(0.9)
  await addEffect(page, 'vignette')
  const undo = await undoDepth(page)
  await snap(page, 'real')
  expect(await diff(page, 'plain', 'real')).toBeGreaterThan(1)
  return { undo }
}

test('holding R shows the picture without its effects, and letting go brings them back, with no undo step', async ({ page }) => {
  const { undo } = await clipWithVisibleEffect(page)

  await page.keyboard.down('r')
  await expect(page.getByTestId('before-badge')).toBeVisible()
  await snap(page, 'held')
  // The held picture is the one without the effect, and not the real one.
  expect(await diff(page, 'plain', 'held')).toBeLessThan(0.01)
  expect(await diff(page, 'real', 'held')).toBeGreaterThan(1)

  await page.keyboard.up('r')
  await expect(page.getByTestId('before-badge')).toHaveCount(0)
  await snap(page, 'back')
  expect(await diff(page, 'real', 'back')).toBeLessThan(0.01)
  expect(await diff(page, 'plain', 'back')).toBeGreaterThan(1)
  expect(await undoDepth(page)).toBe(undo)
})

test('the Before button holds while the pointer is down and lets go when it comes up', async ({ page }) => {
  const { undo } = await clipWithVisibleEffect(page)

  const b = (await page.getByTestId('before-hold').boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('before-badge')).toBeVisible()
  await snap(page, 'held')
  expect(await diff(page, 'plain', 'held')).toBeLessThan(0.01)
  expect(await diff(page, 'real', 'held')).toBeGreaterThan(1)

  await page.mouse.up()
  await expect(page.getByTestId('before-badge')).toHaveCount(0)
  await snap(page, 'back')
  expect(await diff(page, 'real', 'back')).toBeLessThan(0.01)
  expect(await diff(page, 'plain', 'back')).toBeGreaterThan(1)
  expect(await undoDepth(page)).toBe(undo)
})
