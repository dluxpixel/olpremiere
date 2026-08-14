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

const FIXTURE = 'e2e/.fixtures/clip.webm'

/** Brightest pixel across a row of the program monitor, 0..255. */
async function rowMaxLuma(page: Page, fy: number): Promise<number> {
  return page.evaluate((fy) => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const s = document.createElement('canvas')
    s.width = c.width
    s.height = c.height
    s.getContext('2d')!.drawImage(c, 0, 0)
    const row = s.getContext('2d')!.getImageData(0, Math.floor(c.height * fy), c.width, 1).data
    let max = 0
    for (let i = 0; i < row.length; i += 4) max = Math.max(max, (row[i] + row[i + 1] + row[i + 2]) / 3)
    return max
  }, fy)
}

async function setBlurBackground(page: Page, on: boolean): Promise<void> {
  const toggle = page.getByTestId('blur-background-toggle')
  // IconButton omits aria-pressed entirely when it is off rather than writing
  // "false", so absent IS off and a plain string compare gets it backwards.
  const isOn = async (): Promise<boolean> => (await toggle.getAttribute('aria-pressed')) === 'true'
  if ((await isOn()) !== on) await toggle.click()
  expect(await isOn()).toBe(on)
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
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; dispatch: (l: string, f: (p: unknown) => unknown) => void } }
    }
    const { activeSequence, defaultTransform } = (await import(/* @vite-ignore */ typesMod)) as {
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
  await page.waitForTimeout(400)

  // OFF: the top of the frame is a black bar. This half is what makes the ON
  // half mean anything.
  await setBlurBackground(page, false)
  await page.waitForTimeout(500)
  const barOff = await rowMaxLuma(page, 0.04)
  const middleOff = await rowMaxLuma(page, 0.5)
  expect(middleOff).toBeGreaterThan(20) // there is a picture at all
  expect(barOff).toBeLessThan(12) // ...and the bar is black

  // ON: the same row now carries the blurred picture.
  await setBlurBackground(page, true)
  await page.waitForTimeout(500)
  const barOn = await rowMaxLuma(page, 0.04)
  expect(barOn).toBeGreaterThan(barOff + 15)

  // And it SURVIVES A ZOOM OUT, which is the thing he actually asked for: the
  // clip shrinks away from the edges and the frame stays filled, not black.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; dispatch: (l: string, f: (p: unknown) => unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
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
  await page.waitForTimeout(500)

  // Halfway between the shrunken clip's edge and the frame edge: black before
  // this feature, blurred picture now.
  const zoomedOutEdge = await rowMaxLuma(page, 0.18)
  expect(zoomedOutEdge).toBeGreaterThan(barOff + 15)
})
