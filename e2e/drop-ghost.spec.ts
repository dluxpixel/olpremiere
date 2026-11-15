// The drop preview: dragging media from the bin over the timeline shows a ghost
// clip as long as the clip will be, on the lane it will land on, and the drop
// puts the clip exactly where the ghost was.
//
// The geometry and the ghost's source (the same pure insert the drop runs) are
// pinned in src/components/useTimelineDrop.test.tsx and timelineDrop.test.ts;
// a browser is needed for the rest: the ghost really paints at the right size,
// and the clip the drop makes lands under it.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { parkModules, type ParkedWindow } from './storeWrites'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const OUT = 'test-results'

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true })
})

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

/** The imported asset's length and the timeline zoom, straight from the store. */
async function lengthAndZoom(page: Page): Promise<{ durationS: number; pxPerS: number }> {
  await parkModules(page, ['/src/state/store.ts'])
  return page.evaluate(() => {
    const { useStore } = (window as unknown as ParkedWindow).__e2eMods['/src/state/store.ts'] as {
      useStore: { getState: () => { project: { assets: Record<string, { durationS: number }> }; ui: { pxPerS: number } } }
    }
    const s = useStore.getState()
    return { durationS: Object.values(s.project.assets)[0].durationS, pxPerS: s.ui.pxPerS }
  })
}

/**
 * Drive a real HTML5 drag from the asset card onto the lanes. Playwright's
 * mouse-based dragTo does not populate dataTransfer for custom MIME types, so
 * dispatch the events with a DataTransfer we build ourselves (as effects.spec.ts
 * does). One DataTransfer is kept on window for the whole drag, like a real one.
 * The pointer aims `atS` seconds into the content, on the bottom video lane.
 */
async function fire(page: Page, type: 'dragstart' | 'dragover' | 'drop' | 'dragend', atS: number): Promise<void> {
  await page.evaluate(
    ({ type, atS }) => {
      const w = window as unknown as { __dropGhostDt?: DataTransfer }
      const card = document.querySelector('[data-testid="asset-card"]') as HTMLElement
      const lanes = document.querySelector('[data-testid="timeline-lanes"]') as HTMLElement
      const content = lanes.firstElementChild as HTMLElement
      // The bottom video lane is the one just above the 2px divider before the audio lanes.
      const lane = content.querySelector(':scope > .h-\\[2px\\]')!.previousElementSibling as HTMLElement
      const laneRect = lane.getBoundingClientRect()
      const pxPerS = (window as unknown as { __dropGhostPx: number }).__dropGhostPx
      const clientX = content.getBoundingClientRect().left + atS * pxPerS
      const clientY = laneRect.top + laneRect.height / 2
      if (type === 'dragstart') w.__dropGhostDt = new DataTransfer()
      const opts = { dataTransfer: w.__dropGhostDt, bubbles: true, cancelable: true, clientX, clientY }
      const target = type === 'dragstart' || type === 'dragend' ? card : lanes
      target.dispatchEvent(new DragEvent(type, opts))
    },
    { type, atS },
  )
}

/** Left, width and top of each element, top to bottom. */
async function boxes(page: Page, testId: string): Promise<{ x: number; width: number; y: number }[]> {
  const all = await page.getByTestId(testId).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left, width: r.width, y: r.top }
    }),
  )
  return all.sort((a, b) => a.y - b.y)
}

test('a bin drag shows a ghost as long as the clip, and the drop lands the clip under it', async ({ page }) => {
  await boot(page)
  const { durationS, pxPerS } = await lengthAndZoom(page)
  await page.evaluate((px) => ((window as unknown as { __dropGhostPx: number }).__dropGhostPx = px), pxPerS)
  const atS = 3

  await fire(page, 'dragstart', atS)
  await fire(page, 'dragover', atS)

  const ghosts = page.getByTestId('drop-ghost')
  await expect(ghosts.first()).toBeVisible()
  const hover = await boxes(page, 'drop-ghost')
  for (const g of hover) expect(Math.abs(g.width - durationS * pxPerS)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: `${OUT}/drop-ghost-hover.png` })

  await fire(page, 'drop', atS)
  await expect(page.locator('[data-testid="clip"]').first()).toBeVisible()
  await expect(ghosts).toHaveCount(0)

  // Every ghost had a clip under it: same left edge, same length, same lane order.
  const clips = await boxes(page, 'clip')
  expect(clips).toHaveLength(hover.length)
  hover.forEach((g, i) => {
    expect(Math.abs(clips[i].x - g.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(clips[i].width - g.width)).toBeLessThanOrEqual(2)
  })
  await page.screenshot({ path: `${OUT}/drop-ghost-dropped.png` })
})

test('the ghost goes when the drag ends without a drop', async ({ page }) => {
  await boot(page)
  const { pxPerS } = await lengthAndZoom(page)
  await page.evaluate((px) => ((window as unknown as { __dropGhostPx: number }).__dropGhostPx = px), pxPerS)

  await fire(page, 'dragstart', 2)
  await fire(page, 'dragover', 2)
  await expect(page.getByTestId('drop-ghost').first()).toBeVisible()

  await fire(page, 'dragend', 2)
  await expect(page.getByTestId('drop-ghost')).toHaveCount(0)
  await expect(page.locator('[data-testid="clip"]')).toHaveCount(0)
})
