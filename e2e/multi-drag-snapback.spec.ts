// His words, 2026-08-12: "Click-dragging is so fucking bad. Oh my god, it's just
// so buggy. It has one function, and it can't even do that."
//
// DRAGGING A MULTI-SELECTION FOUGHT HIM. The snap points excluded the grabbed
// clip and its link group, for the right reason: a partner travelling with the
// drag would otherwise offer its OLD edges as targets and yank the drag back to
// where it started. **The clips carried in `others` travel too, and they were
// still in the points.** So every carried clip's original edges pulled the whole
// selection back toward the spot it was trying to leave.
//
// The more clips he selected, the worse it got, which is why it reads as "it has
// one function and it can't even do that".

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

/** Two video clips butted together on V1, both selected. */
async function twoSelectedClips(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
  // Razor at 1s, so there are two clips whose shared edge is a snap point
  // sitting exactly where the drag is trying to leave.
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } })
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(2)
  await page.keyboard.press('Control+a')
}

async function startsOf(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { startS: number }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips.map((c) => c.startS))
  })
}

test('dragging a multi-selection goes where it is dragged, instead of being pulled back', async ({ page }) => {
  await twoSelectedClips(page)
  const before = await startsOf(page)

  const first = vclip(page).first()
  await first.hover()
  const b = (await first.boundingBox())!
  // 100px right. At the default 60px/s that is a shove of well over a second,
  // far larger than any snap threshold, so nothing here is a near miss.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 100, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()

  const after = await startsOf(page)

  // ⛔ BOTH clips moved, and by the SAME amount: the selection kept its shape.
  const deltas = after.map((a, i) => a - before[i])
  expect(deltas.length).toBe(2)
  expect(deltas[0]).toBeGreaterThan(0.9)
  expect(Math.abs(deltas[1] - deltas[0])).toBeLessThan(0.02)

  // And it really landed near where it was dragged rather than being dragged
  // back onto the edge it started from.
  expect(Math.abs(deltas[0] - 100 / 60)).toBeLessThan(0.25)
})
