// Drag a clip's edge into its neighbour and the overlap is a crossfade.
//
// The Vegas gesture, borrowed on 2026-09-15 after reading what editors say
// they love about that timeline. The arithmetic is pinned in
// src/engine/overlapCrossfade.test.ts; what only a browser can show is the
// wiring: the edge strip starts the drag, the readout says Crossfade once the
// pointer is past the cut, both clips draw the mark when it lands, and the two
// clips still meet at a cut with no overlap in the data.

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

test("the second clip's head dragged into the first makes a crossfade the length of the overlap", async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)

  // One cut: two clips from one piece of media, so each still has the frames
  // the other gave up, which is what a crossfade is made of.
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
  await expect(page.getByText(/^Crossfade/)).toBeVisible()
  await page.mouse.up()

  const [a, b] = await clips(page)
  // A gave up its tail and B took the same half second at its head.
  expect(b.startS).toBeLessThan(before[1].startS)
  expect(b.inS).toBeLessThan(before[1].inS)
  // They still meet at a cut: no overlap in the data, the dissolve is a transition on B.
  expect(a.startS + (a.outS - a.inS)).toBeCloseTo(b.startS, 3)
  expect(b.transitionIn?.type).toBe('crossDissolve')
  expect(b.transitionIn?.durationS).toBeCloseTo(before[1].startS - b.startS, 3)
  expect(b.transitionIn!.durationS).toBeGreaterThanOrEqual(0.4)

  // Both halves of the dissolve are drawn, on the clip that owns it and the one it crosses.
  await expect(second.getByTestId('transition-in-mark')).toBeVisible()
  await expect(vclip(page).first().getByTestId('transition-out-mark')).toBeVisible()
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
