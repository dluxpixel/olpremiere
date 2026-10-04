// Time reads like a stopwatch, and C on a clip that starts between frames,
// 2026-10-03. His words, with three screenshots: *"It says 3:29, and then it
// goes to 4:00"* (a drag readout counting frames), *"I can't cut. When I click
// C, it won't cut in this frame, even though I'm on another frame"*, and the
// ruler zoomed all the way in reading "00:06:27" then "00:07:00".
//
// The engine and the store prove the rules (src/engine/timecode.test.ts,
// src/engine/frameGrid.test.ts, src/state/cutOffGrid.test.ts). What only a
// browser shows is the wiring: the real ruler, the real readouts, the real
// timecode field, and the real C key.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const CLOCK = /^\d+:\d\d\.\d\d$/

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

async function setUI(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (patch: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

async function playheadS(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
    return useStore.getState().ui.playheadS
  })
}

/** V1's clips, start and end in FRAMES of the 30 fps edit. */
async function v1Frames(page: Page): Promise<{ id: string; start: number; end: number }[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence, clipEndS } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { fps: number; tracks: { kind: string; clips: { id: string; startS: number }[] }[] }
      clipEndS: (c: unknown) => number
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks[0]!.clips.map((c) => ({
      id: c.id,
      start: +(c.startS * seq.fps).toFixed(2),
      end: +(clipEndS(c) * seq.fps).toFixed(2),
    }))
  })
}

/**
 * His edit in miniature: V1 holds two pieces of one take, flush at frame 20.54
 * of a 30 fps edit, the way every edit after his 2.5x clip sat between two
 * frames. The sound is lifted off so V1 is the whole story.
 */
async function seedOffGridEdit(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence, useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: Seq) => Seq) => void
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    type C = { id: string; startS: number; inS: number; outS: number; linkId?: string }
    type Seq = { fps: number; tracks: { kind: string; clips: C[] }[] }
    const edge = 20.54 / 30
    updateActiveSequence('seed', (s) => {
      const v = s.tracks[0]!.clips[0]!
      const piece = (id: string, startS: number, inS: number, outS: number): C => ({ ...v, id, startS, inS, outS, linkId: undefined })
      return {
        ...s,
        fps: 30,
        tracks: s.tracks.map((t, i) =>
          i === 0
            ? { ...t, clips: [piece('left', 0, 0, edge), piece('right', edge, edge, edge + 0.25)] }
            : t.kind === 'audio'
              ? { ...t, clips: [] }
              : t,
        ),
      }
    })
    useStore.getState().setUI({ selection: [] })
  })
}

test('C beside an edit that sits between two frames: cuts where it can, says why where it cannot', async ({ page }) => {
  await boot(page)
  await seedOffGridEdit(page)
  expect(await v1Frames(page)).toEqual([
    { id: 'left', start: 0, end: 20.54 },
    { id: 'right', start: 20.54, end: 28.04 },
  ])
  const toast = page.getByTestId('toast')

  // His screenshot: the right piece selected, the playhead on frame 21, drawn
  // half a frame inside it. Frame 21 is the first frame it shows.
  await setUI(page, { selection: ['right'], playheadS: 21 / 30 })
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('c')
  await expect(toast.filter({ hasText: 'first frame of the clip' })).toBeVisible()
  expect(await v1Frames(page)).toHaveLength(2)

  // One frame back, nothing selected: the left piece still shows frame 20, so
  // C cuts it there, leaving a piece that shows exactly that frame.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft')
  expect(Math.round((await playheadS(page)) * 30)).toBe(20)
  await page.keyboard.press('c')
  await expect.poll(async () => (await v1Frames(page)).length).toBe(3)
  expect((await v1Frames(page)).map((c) => c.start)).toEqual([0, 20, 20.54])

  // Two frames on, inside the right piece: C cuts it, as it always did.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await setUI(page, { selection: ['right'] })
  await page.keyboard.press('c')
  await expect.poll(async () => (await v1Frames(page)).length).toBe(4)
})

test('the ruler zoomed all the way in reads seconds with hundredths, every label once', async ({ page }) => {
  await boot(page)
  await setUI(page, { pxPerS: 800 })
  const labels = page.getByTestId('ruler').locator('span.font-numeric')
  await expect(labels.first()).toBeVisible()
  const texts = (await labels.allTextContents()).map((t) => t.trim())
  expect(texts.length).toBeGreaterThan(3)
  for (const t of texts) expect(t).toMatch(CLOCK)
  expect(new Set(texts).size).toBe(texts.length)
  // Round steps of a tenth: 0:00.00, 0:00.10, 0:00.20 ...
  expect(texts.slice(0, 3)).toEqual(['0:00.00', '0:00.10', '0:00.20'])
})

test('the playhead reads 0:03.97 then 0:04.00, and the field takes both the new and the old way of typing it', async ({ page }) => {
  await boot(page)
  await seedOffGridEdit(page)
  const timecode = page.getByTestId('monitor-timecode')
  // A typed time clamps to the end of the edit: give it room past 4 s.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: { durationS: number }) => unknown) => void
    }
    updateActiveSequence('long', (s) => ({ ...s, durationS: 10 }))
  })
  await setUI(page, { playheadS: 119 / 30 })
  await expect(timecode).toHaveText('0:03.97')
  await setUI(page, { playheadS: 120 / 30 })
  await expect(timecode).toHaveText('0:04.00')

  await timecode.click()
  const input = page.getByTestId('monitor-timecode-input')
  await expect(input).toHaveValue('0:04.00')
  await input.fill('0:01.50')
  await input.press('Enter')
  expect(await playheadS(page)).toBeCloseTo(1.5, 9)
  await expect(timecode).toHaveText('0:01.50')

  // The old HH:MM:SS:FF still types, and lands on the very same frame.
  await timecode.click()
  await page.getByTestId('monitor-timecode-input').fill('00:00:02:15')
  await page.getByTestId('monitor-timecode-input').press('Enter')
  expect(await playheadS(page)).toBeCloseTo(2.5, 9)
  await expect(timecode).toHaveText('0:02.50')
})

test('a trim readout says seconds with hundredths and a signed change in seconds, no frame count', async ({ page }) => {
  await boot(page)
  const clip = page.locator('[data-clip-kind="video"]').first()
  const box = (await clip.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 26, y, { steps: 8 })
  const tip = page.getByText(/^\d+:\d\d\.\d\d\s+[+-]\d+\.\d\ds$/)
  await expect(tip).toBeVisible()
  await page.mouse.up()
})
