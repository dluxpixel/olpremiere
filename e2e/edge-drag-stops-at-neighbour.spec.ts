// A clip's edge dragged into its neighbour STOPS AT THE CUT, like any trim.
//
// From 2026-09-15 to 2026-10-03 it did not: the overlap became a crossfade, a
// gesture borrowed from Vegas. His words on 2026-10-03: "please remove the sony
// vegas feature that when you slide the clip through antother clip it adds a
// transition". On top of the dissolve he never asked for, pulling a head into
// the previous clip shortened that clip on the picture only, so a linked pair
// fell out of sync. The engine side is pinned in timelineGestures.test.ts; this
// file is the real pointer on the real edge strip.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

interface Row {
  startS: number
  inS: number
  outS: number
  transitionIn?: { type: string; durationS: number }
}

async function clips(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: Row[] }[] }
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips.map((c) => ({ startS: c.startS, inS: c.inS, outS: c.outS, transitionIn: c.transitionIn })))
  })
}

test("the second clip's head dragged into the first stops at the cut: no dissolve, the first clip keeps every frame", async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)

  // One cut: two clips from one piece of media, so each still has the frames
  // the other gave up, which is exactly what the old gesture crossfaded.
  await page.getByTestId('ruler').click({ position: { x: 80, y: 10 } })
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(2)
  await page.keyboard.press('v')

  const before = await clips(page)
  const second = vclip(page).nth(1)
  const box = (await second.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y) // hover so the edge affordances render
  await page.mouse.move(box.x + 2, y) // the head trim strip
  await page.mouse.down()
  await page.mouse.move(box.x - 30, y, { steps: 10 }) // half a second into the first clip at 60 px/s
  await expect(page.getByText(/^Crossfade/)).toHaveCount(0)
  await page.mouse.up()

  const [a, b] = await clips(page)
  // Nothing crossed the cut: the first clip is untouched and the second still starts on it.
  expect(a).toEqual(before[0])
  expect(b.startS).toBeCloseTo(before[1].startS, 6)
  expect(b.transitionIn).toBeUndefined()
  expect(a.startS + (a.outS - a.inS)).toBeCloseTo(b.startS, 6)
  await expect(second.getByTestId('transition-in-mark')).toHaveCount(0)
})

test('a drag that stops short of the neighbour is the plain trim it always was', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
  await page.getByTestId('ruler').click({ position: { x: 80, y: 10 } })
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(2)
  await page.keyboard.press('v')

  const before = await clips(page)
  const second = vclip(page).nth(1)
  const box = (await second.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 30, y, { steps: 10 }) // away from the first clip
  await expect(page.getByText(/^Crossfade/)).toHaveCount(0)
  await page.mouse.up()

  const [a, b] = await clips(page)
  expect(a).toEqual(before[0])
  expect(b.startS).toBeGreaterThan(before[1].startS)
  expect(b.transitionIn).toBeUndefined()
})
