// Type text right on the video, like TikTok: double click a title in the monitor,
// type, press Escape. The words land on the title (the Inspector's text box shows
// them) and the picture is still the real raster, with a lavender caret on it.
//
// The behaviour is pinned in src/components/MonitorTextEdit.test.tsx; this is the
// browser's view of it: a real double click, a real keyboard, a real screenshot.

import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/** Where the middle of the first title's ink is on the screen, in page px. */
async function titleInkCentre(page: Page): Promise<{ x: number; y: number }> {
  const canvas = (await page.getByTestId('program-canvas').boundingBox())!
  const uv = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const rasterMod = '/src/engine/render/titleRaster.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        width: number
        height: number
        tracks: { clips: { title?: unknown }[] }[]
      }
    }
    const { titleInkBoxUV } = (await import(/* @vite-ignore */ rasterMod)) as {
      titleInkBoxUV: (
        def: unknown,
        w: number,
        h: number,
      ) => { u0: number; v0: number; u1: number; v1: number } | null
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)!
    return titleInkBoxUV(clip.title, seq.width, seq.height)
  })
  expect(uv).not.toBeNull()
  return {
    x: canvas.x + ((uv!.u0 + uv!.u1) / 2) * canvas.width,
    y: canvas.y + ((uv!.v0 + uv!.v1) / 2) * canvas.height,
  }
}

test('double click a title in the monitor, type a word, Escape: the title has the word', async ({ page }) => {
  await page.goto('/')
  // Add a title the way the shelf does: a double click on its row puts it at the playhead.
  await page.getByRole('tab', { name: 'Effects' }).click()
  const row = page.locator('[data-testid="title-item"][data-payload="caption-bar"]')
  await expect(row).toBeVisible()
  await row.dblclick()
  await expect(page.locator('[data-clip-kind="title"]')).toHaveCount(1)

  // Past the fade in, so the words are fully on the picture. A seek, nothing more.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
    }
    useStore.getState().setUI({ playheadS: 1 })
  })

  const at = await titleInkCentre(page)
  await page.mouse.dblclick(at.x, at.y)

  // The field is over the title, focused, and its words are see-through: the picture underneath is
  // the real raster.
  const field = page.getByTestId('text-edit-field')
  await expect(field).toBeFocused()
  await expect(field).toHaveCSS('color', 'rgba(0, 0, 0, 0)')

  await page.keyboard.press('End')
  await page.keyboard.type(' WORD')
  fs.mkdirSync('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/type-on-video.png' })

  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)

  // The Inspector's own text box shows what was typed, so both doors write the one title.
  await expect(page.getByTestId('title-text')).toHaveValue(/ WORD$/)
})
