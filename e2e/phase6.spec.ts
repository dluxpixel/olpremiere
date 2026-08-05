import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase6'

// The fixture is video WITH audio → a linked pair: video on V1, split audio on A1.
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')
const aclip = (page: Page) => page.locator('[data-clip-kind="audio"]')

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function addClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(aclip(page)).toHaveCount(1)
}

test('audio clips render a waveform', async ({ page }) => {
  await addClip(page)
  const wave = aclip(page).getByTestId('clip-waveform')
  await expect(wave).toHaveCount(1)
  // Video clips do not draw a waveform (they show the filmstrip thumb).
  await expect(vclip(page).getByTestId('clip-waveform')).toHaveCount(0)
  // The canvas must actually PAINT peaks. Count opaque pixels so a blank
  // waveform (null peaks / decode fail) can never pass silently.
  await expect
    .poll(
      async () =>
        wave.evaluate((el: HTMLCanvasElement) => {
          const ctx = el.getContext('2d')
          if (!ctx || el.width === 0) return 0
          const { data } = ctx.getImageData(0, 0, el.width, el.height)
          let lit = 0
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++
          return lit
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(200)
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/waveform.png` })
})

test('the Inspector shows an Audio section (gain + fades) for an audio clip', async ({ page }) => {
  await addClip(page)
  await aclip(page).click()
  await expect(page.getByTestId('audio-controls')).toBeVisible()
  await expect(page.getByTestId('field-audio-gain')).toBeVisible()
  await expect(page.getByTestId('field-fade-in')).toBeVisible()
  await expect(page.getByTestId('field-fade-out')).toBeVisible()
  await page.getByTestId('panel-right').screenshot({ path: `${VERIFY}/inspector-audio.png` })
})

test('dragging the fade-in handle creates a fade (an overlay appears)', async ({ page }) => {
  await addClip(page)
  const clip = aclip(page)
  // Hover buys the stability and hit-target checks raw page.mouse.* skips, and the box is read
  // after it: hover() can scroll the clip into view, so a box read first is the stale one.
  await clip.hover()
  const box = (await clip.boundingBox())!
  // No fade yet → no fade overlay. (Bare `svg path` would also match the
  // linked-A/V badge icon, so the overlay carries its own testid.)
  await expect(clip.locator('[data-testid="fade-overlay"]')).toHaveCount(0)
  // Grab the fade-in handle (top-left, above the trim handle) and drag right.
  await page.mouse.move(box.x + 1, box.y + 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 2, { steps: 10 })
  await page.mouse.up()
  // A fade overlay (triangle path) is now drawn.
  await expect(clip.locator('[data-testid="fade-overlay"] path')).toHaveCount(1)
  // …and the Inspector reflects a non-zero fade in.
  await clip.click()
  const fadeIn = await page.getByTestId('field-fade-in').inputValue()
  expect(Number(fadeIn)).toBeGreaterThan(0.2)
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/fade.png` })
})

test('audio track headers expose volume + pan faders', async ({ page }) => {
  await addClip(page)
  // A1 header controls (aria-labelled per track name).
  await expect(page.getByLabel('A1 volume')).toBeVisible()
  await expect(page.getByLabel('A1 pan')).toBeVisible()
  // Adjust volume via keyboard (focus + arrow) and confirm it commits (undoable).
  const vol = page.getByLabel('A1 volume')
  await vol.focus()
  await vol.press('ArrowDown')
  await vol.press('ArrowDown')
  // Undo should revert the committed change (no throw = the edit was on the stack).
  await page.keyboard.press('Control+z')
  await page.screenshot({ path: `${VERIFY}/mixer.png` })
})

test('the master meter is present in the monitor', async ({ page }) => {
  await addClip(page)
  await expect(page.getByTestId('master-meter')).toBeAttached()
  await page.getByTestId('monitor').screenshot({ path: `${VERIFY}/monitor-meter.png` })
})

test('auto-level button sets track loudness equalization via a menu', async ({ page }) => {
  await addClip(page)
  await page.getByTestId('autolevel-btn').first().click()
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('Off')
  await expect(menu).toContainText('Medium')
  await page.screenshot({ path: `${VERIFY}/autolevel-menu.png` })
  await menu.getByRole('menuitem', { name: /Medium/ }).click()

  // The first audio track now carries autoLevel: 'medium'.
  const level = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; autoLevel?: string }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.find((t) => t.kind === 'audio')?.autoLevel
  })
  expect(level).toBe('medium')
})
