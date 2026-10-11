// His ask, 2026-08-14, with a Shorts screenshot: 16:9 gameplay in a 9:16 frame
// leaves black bars top and bottom, and he wants the soft blurred fill instead.
//
// ⛔ THE RESOLVER TEST IS NOT THIS TEST. resolve.test.ts proves a backdrop op is
// emitted with the right geometry. It cannot prove the screen stopped being
// black, because a canvas is exactly as full whether or not anything covers it,
// and this repo has already shipped a feature that was drawn and invisible
// (D82, the waveform under the filmstrip). So this reads the real pixels out of
// the real WebGL preview, in BOTH states, and the OFF case is half the proof:
// without it, a test that finds light in the bars proves nothing about whether
// the switch did it.

import { expect, test, type Page } from '@playwright/test'
import { parkModules, type ParkedWindow } from './storeWrites'

const FIXTURE = 'e2e/.fixtures/clip.webm'

/**
 * The brightest pixel of EVERY row of the program monitor, 0..255, top to bottom.
 *
 * ⛔ IT REPAINTS FIRST (2026-10-06), the way stylize-pack's `px` does: bump the
 * preview epoch and wait two frames, so the read is of the store as it is NOW and
 * never of a frame painted before the last change. This file used to wait 400 to
 * 500 ms after each change and read once, the shape that failed
 * dissolve-linear-light until it polled.
 */
async function rowsMaxLuma(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const previewMod = '/src/engine/preview.ts'
    const { invalidatePreview } = (await import(/* @vite-ignore */ previewMod)) as { invalidatePreview: () => void }
    invalidatePreview()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const s = document.createElement('canvas')
    s.width = c.width
    s.height = c.height
    s.getContext('2d')!.drawImage(c, 0, 0)
    const data = s.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    const rows: number[] = []
    for (let y = 0; y < c.height; y++) {
      let max = 0
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        max = Math.max(max, (data[i] + data[i + 1] + data[i + 2]) / 3)
      }
      rows.push(max)
    }
    return rows
  })
}

/** Brightest pixel across one row, `fy` being a fraction of the frame height. */
async function rowMaxLuma(page: Page, fy: number): Promise<number> {
  const rows = await rowsMaxLuma(page)
  return rows[Math.floor(rows.length * fy)]
}

/** The clip fixture's timecode is white on red, and nothing else on the monitor gets this bright. */
const TIMECODE_FLOOR = 200
const rowsAbove = (rows: number[], floor: number): number[] => rows.flatMap((v, i) => (v > floor ? [i] : []))

/**
 * The four frame settings live behind the Frame button since 2026-09-13: the bar
 * under the picture held eleven controls in an overflow-hidden cell and clipped
 * them off the end. Opening the menu is what a person now does, so the specs do
 * it too rather than reaching past the interface.
 */
async function setBlurBackground(page: Page, on: boolean): Promise<void> {
  await page.getByTestId('frame-settings-button').click()
  const toggle = page.getByTestId('blur-background-toggle')
  await expect(toggle).toBeVisible()
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on)
  expect(await toggle.isChecked()).toBe(on)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('frame-settings-menu')).toHaveCount(0)
}

test('the blurred background fills the bars a wide clip leaves in a Shorts frame', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // A 9:16 Shorts frame, which is where he hits this. The format switch refits
  // clips, so the clip is put back to a plain contain fit afterwards: the bars
  // are the thing under test and a refit would have already removed them.
  await page.getByTestId('format-select').selectOption('9:16')
  await parkModules(page, ['/src/state/store.ts', '/src/engine/types.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = mods[storeMod] as {
      useStore: { getState: () => { project: unknown; dispatch: (l: string, f: (p: unknown) => unknown) => void } }
    }
    const { activeSequence, defaultTransform } = mods[typesMod] as {
      activeSequence: (p: unknown) => { id: string; tracks: { clips: unknown[] }[] }
      defaultTransform: () => unknown
    }
    useStore.getState().dispatch('test: reset transform', (p) => {
      const proj = p as { sequences: Record<string, unknown> }
      const seq = activeSequence(p) as unknown as {
        id: string
        tracks: { kind: string; clips: { transform: unknown }[] }[]
      }
      const tracks = seq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, transform: defaultTransform() })),
      }))
      return { ...proj, sequences: { ...proj.sequences, [seq.id]: { ...seq, tracks } } }
    })
  })

  // OFF: the top of the frame is a black bar. This half is what makes the ON
  // half mean anything. Polled on BOTH rows at once: a canvas just resized for
  // the new frame is blank, and blank satisfies "the bar is black" on its own.
  await setBlurBackground(page, false)
  await expect
    .poll(async () => (await rowMaxLuma(page, 0.04)) < 12 && (await rowMaxLuma(page, 0.5)) > 20, { timeout: 10_000 })
    .toBe(true)
  const barOff = await rowMaxLuma(page, 0.04)
  const middleOff = await rowMaxLuma(page, 0.5)
  expect(middleOff).toBeGreaterThan(20) // there is a picture at all
  expect(barOff).toBeLessThan(12) // ...and the bar is black

  // ON: the same row now carries the blurred picture.
  await setBlurBackground(page, true)
  await expect.poll(async () => rowMaxLuma(page, 0.04), { timeout: 10_000 }).toBeGreaterThan(barOff + 15)

  // Where the clip's own timecode is drawn now (the fixture is flat red with a white
  // timecode in its top left corner, and the blurred copy behind it is too soft to
  // reach this brightness), so the zoom below has something to move.
  let timecodeRows: number[] = []
  await expect
    .poll(async () => (timecodeRows = rowsAbove(await rowsMaxLuma(page), TIMECODE_FLOOR)).length, { timeout: 10_000, message: 'the clip timecode never showed' })
    .toBeGreaterThan(0)

  // And it SURVIVES A ZOOM OUT, which is the thing he actually asked for: the
  // clip shrinks away from the edges and the frame stays filled, not black.
  await parkModules(page, ['/src/state/store.ts', '/src/engine/types.ts'])
  await page.evaluate(() => {
    const mods = (window as unknown as ParkedWindow).__e2eMods
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = mods[storeMod] as {
      useStore: { getState: () => { project: unknown; dispatch: (l: string, f: (p: unknown) => unknown) => void } }
    }
    const { activeSequence } = mods[typesMod] as {
      activeSequence: (p: unknown) => unknown
    }
    useStore.getState().dispatch('test: zoom out', (p) => {
      const proj = p as { sequences: Record<string, unknown> }
      const seq = activeSequence(p) as { id: string; tracks: { clips: { transform: { scale: number } }[] }[] }
      const tracks = seq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, transform: { ...c.transform, scale: 0.4 } })),
      }))
      return { ...proj, sequences: { ...proj.sequences, [seq.id]: { ...seq, tracks } } }
    })
  })

  // ⛔ THE ZOOM HAS TO BE ON THE MONITOR BEFORE THE BAND IS READ. The band is
  // already filled before the zoom (the blur is on), so "the band is bright" is true of
  // the stale frame and of the zoomed one alike, and a poll on it returns at once
  // having seen nothing: a backdrop that shrank with the clip stayed green once the
  // monitor painted a few seconds late. What the zoom changes is where the clip's
  // sharp timecode sits, so the poll is for it to LEAVE the rows it was read on.
  await expect.poll(async () => rowsAbove(await rowsMaxLuma(page), TIMECODE_FLOOR).filter((r) => timecodeRows.includes(r)).length, { timeout: 10_000 }).toBe(0)

  // Halfway between the shrunken clip's edge and the frame edge: black before
  // this feature, blurred picture now.
  expect(await rowMaxLuma(page, 0.18)).toBeGreaterThan(barOff + 15)
})
