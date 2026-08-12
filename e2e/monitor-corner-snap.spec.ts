// His words, 2026-08-12: "Make it so it fits to the corner when I'm moving the
// video. Also, when I'm moving multiple texts using right-click and drag text,
// make it so it has these auto points too."
//
// The monitor snapped to the frame CENTRE and nothing else, so a clip could be
// nudged toward a corner by eye and never actually land on it.
//
// ⛔ THE ASSERTION IS NOT "IT ENDED NEAR THE CORNER", because following the
// pointer would pass that. Two drags that end a few pixels APART must finish at
// the IDENTICAL transform: only a snap can do that, and it needs no knowledge of
// the clip's box maths, which is unit tested separately in
// `engine/snapTransform.test.ts`.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function addClipAndShrink(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click()
  // Half size, so the clip's box is genuinely inside the frame and its EDGES are
  // somewhere other than the frame's own. At scale 1 it fills the frame and an
  // edge snap would be indistinguishable from the centre snap that already
  // existed, which would make this test pass without testing anything.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    updateActiveSequence('test: shrink', (s) => {
      const sq = s as { tracks: { kind: string; clips: { transform: Record<string, number> }[] }[] }
      return {
        ...sq,
        tracks: sq.tracks.map((t) =>
          t.kind === 'video'
            ? { ...t, clips: t.clips.map((c) => ({ ...c, transform: { ...c.transform, scale: 0.5, x: 0, y: 0 } })) }
            : t,
        ),
      }
    })
  })
  await expect(page.getByTestId('gizmo-body')).toBeVisible()
}

async function readXY(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { transform: { x: number; y: number } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const c = seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips)[0]
    return { x: c.transform.x, y: c.transform.y }
  })
}

/** Drag the gizmo body far toward the top-left, stopping `off` px short. */
async function dragTowardCorner(page: Page, off: number): Promise<void> {
  const body = page.getByTestId('gizmo-body')
  await body.hover()
  const b = (await body.boundingBox())!
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Overshoot well past the corner, then come back to just inside it, so the
  // pointer finishes in the snap zone rather than outside the frame.
  await page.mouse.move(from.x - b.width, from.y - b.height, { steps: 10 })
  await page.mouse.move(from.x - b.width / 2 - 1 + off, from.y - b.height / 2 - 1 + off, { steps: 6 })
}

test('moving the video fits it to the corner, and shows the guides while it holds', async ({ page }) => {
  await addClipAndShrink(page)

  await dragTowardCorner(page, 0)
  // The guides are the visible half of the feature: he has to be able to SEE
  // that it caught, not just find out when he lets go.
  await expect(page.getByTestId('snap-guide-x')).toBeVisible()
  await expect(page.getByTestId('snap-guide-y')).toBeVisible()
  await page.mouse.up()
  const first = await readXY(page)

  // Released, so the guides go away rather than lingering over the picture.
  await expect(page.getByTestId('snap-guide-x')).toHaveCount(0)
  await expect(page.getByTestId('snap-guide-y')).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await readXY(page)).x).toBe(0)

  // ⛔ A DIFFERENT ENDING POINT, THE SAME RESTING PLACE. 4px of pointer travel
  // that changes nothing is what "it fits to the corner" actually means.
  await dragTowardCorner(page, 4)
  await page.mouse.up()
  const second = await readXY(page)

  expect(second.x).toBeCloseTo(first.x, 6)
  expect(second.y).toBeCloseTo(first.y, 6)
  // And it really travelled: a snap that never moved the clip would pass the
  // equality above trivially.
  expect(Math.abs(first.x)).toBeGreaterThan(1)
  expect(Math.abs(first.y)).toBeGreaterThan(1)
})
