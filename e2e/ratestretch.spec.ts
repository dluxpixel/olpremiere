// Rate stretch: Alt+drag a clip edge to retime it (speed changes, the source
// window stays put). Plain edge-drag must still be a trim.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function addClip(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.find((t) => t.kind === 'video')!.clips[0].id
  })
}

async function clipState(page: Page, id: string) {
  return page.evaluate(async (clipId) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; speed: number; inS: number; outS: number; startS: number }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!
    return { speed: clip.speed, inS: clip.inS, outS: clip.outS, startS: clip.startS }
  }, id)
}

/** Drag an edge handle horizontally by `dx`, optionally holding Alt. */
async function dragEdge(page: Page, edge: 'in' | 'out', dx: number, alt: boolean): Promise<void> {
  const clip = page.locator('[data-clip-kind="video"]')
  await clip.hover() // handles appear on hover
  const handle = clip.getByTestId(`trim-${edge}`)
  // Hover the HANDLE too, then re-read: the clip hover stabilises the clip, but only this checks
  // that the press point itself is hit-testable and its own box has settled.
  await handle.hover()
  const box = (await handle.boundingBox())!
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY, { steps: 8 })
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
}

test('Alt+drag the out edge inward retimes the clip instead of trimming it', async ({ page }) => {
  const id = await addClip(page)
  const before = await clipState(page, id)
  expect(before.speed).toBe(1)

  const width0 = (await page.locator('[data-clip-kind="video"]').boundingBox())!.width
  await dragEdge(page, 'out', -Math.round(width0 / 2), true) // halve the length

  const after = await clipState(page, id)
  expect(after.speed).toBeGreaterThan(1.5) // sped up...
  expect(after.inS).toBe(before.inS) // ...but NOT trimmed
  expect(after.outS).toBe(before.outS)
  expect(after.startS).toBe(before.startS)

  // Settled end state: the retime commits to the store on pointerup but the DOM width lands on a
  // later render. A retime that never armed keeps the original width and still fails here.
  await expect
    .poll(async () => (await page.locator('[data-clip-kind="video"]').boundingBox())!.width)
    .toBeLessThan(width0 * 0.7)
})

test('rate stretch is one undo step', async ({ page }) => {
  const id = await addClip(page)
  const width0 = (await page.locator('[data-clip-kind="video"]').boundingBox())!.width
  await dragEdge(page, 'out', -Math.round(width0 / 2), true)
  expect((await clipState(page, id)).speed).toBeGreaterThan(1.5)

  await page.keyboard.press('Control+z')
  const undone = await clipState(page, id)
  expect(undone.speed).toBe(1)
})

test('a plain edge drag still TRIMS (the source window moves)', async ({ page }) => {
  const id = await addClip(page)
  const before = await clipState(page, id)

  const width0 = (await page.locator('[data-clip-kind="video"]').boundingBox())!.width
  await dragEdge(page, 'out', -Math.round(width0 / 2), false)

  const after = await clipState(page, id)
  expect(after.speed).toBe(1) // trims never touch speed
  expect(after.outS).toBeLessThan(before.outS) // the source window shrank
})
