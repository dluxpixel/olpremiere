import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase8'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function importAndAdd(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

test('keyboard help overlay lists shortcuts and closes on Escape', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('help-open').click()
  const help = page.getByTestId('keyboard-help')
  await expect(help).toBeVisible()
  await expect(help).toContainText('Play / Pause')
  await expect(help).toContainText('Cut at playhead')
  await expect(help).toContainText('Ripple delete')
  await page.screenshot({ path: `${VERIFY}/keyboard-help.png` })
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  // The `?` shortcut opens it too.
  await page.keyboard.press('Shift+/')
  await expect(page.getByTestId('keyboard-help')).toBeVisible()
})

test('crash recovery: a reload restores the autosaved project', async ({ page }) => {
  await importAndAdd(page)
  // Let the debounced autosave (~1s) flush to IndexedDB.
  await page.waitForTimeout(1500)
  await page.reload()
  // Asset + clip come back from IndexedDB with no user action.
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('unsupported files surface an honest error toast', async ({ page }) => {
  await page.goto('/')
  const bad = `${VERIFY}/notmedia.txt`
  fs.writeFileSync(bad, 'this is not a media file')
  await page.getByTestId('media-file-input').setInputFiles(bad)
  await expect(page.getByTestId('toast')).toContainText(/unsupported|import failed/i, { timeout: 15_000 })
})

test('9:16 Shorts format makes the sequence vertical and fills the frame', async ({ page }) => {
  await importAndAdd(page)
  const before = (await page.getByTestId('program-canvas').boundingBox())!
  expect(before.width).toBeGreaterThan(before.height) // starts 16:9

  await page.getByTestId('format-select').selectOption('9:16')

  // The program canvas is now portrait.
  await expect
    .poll(
      async () => {
        const b = await page.getByTestId('program-canvas').boundingBox()
        return b ? b.height > b.width : false
      },
      { timeout: 5_000 },
    )
    .toBe(true)

  // The sequence flipped to 9:16 and the clip was scaled up to fill it.
  const state = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        width: number
        height: number
        tracks: { clips: { transform: { scale: number } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return { w: seq.width, h: seq.height, scale: seq.tracks.flatMap((t) => t.clips)[0].transform.scale }
  })
  expect(state.h).toBeGreaterThan(state.w)
  expect(state.scale).toBeGreaterThan(1.5) // scaled to cover the vertical frame
  await page.screenshot({ path: `${VERIFY}/shorts-format.png` })
})

test('the blank header space adds a video or audio track', async ({ page }) => {
  await page.goto('/')
  const names = async () =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { name: string }[] }
      }
      return activeSequence(useStore.getState().project).tracks.map((t) => t.name)
    })
  expect(await names()).toEqual(['V1', 'V2', 'A1', 'A2'])

  await page.getByTestId('add-audio-track').click()
  expect(await names()).toContain('A3')

  await page.getByTestId('add-video-track').click()
  const after = await names()
  expect(after).toContain('V3')
  // A video track stays in the video block (before any audio track).
  expect(after.indexOf('V3')).toBeLessThan(after.indexOf('A1'))
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/add-track.png` })
})
