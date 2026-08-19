// Who owns the first six pixels of a clip.
//
// ⛔ THIS IS A HIT TEST, WHICH IS WHY IT HAS TO RUN IN A BROWSER. The bug it
// pins was invisible to every unit test and to a screenshot alike: the fade dot
// and the trim strip are both drawn, both correct, and both in the right place.
// What was wrong was which one the pointer reached. Found by the design sweep of
// 2026-08-18.
//
// ⛔ THE DEFECT IS THE OPPOSITE OF WHAT IT LOOKS LIKE, and only a bench showed
// which way round it went. The fade dot is 10px centred on its value, so at a
// fade of zero it sat entirely inside the 6px trim strip, and it carried z-10
// while the strip carried nothing. That reads as "the dot steals the trim".
// It does not: the old geometry was put back on 2026-08-18 and the drag at the
// clip head trimmed correctly, before and after.
//
// What was actually broken is the other half: **a fade could not be started at
// all.** The only handle for it lived under the trim strip, so pressing there
// trimmed, every time, and the only way to get a fade in was to already have
// one. The fix moves the handle clear of the strip.
//
// So this file pins BOTH directions on purpose. Either one alone would have let
// a later session "fix" the wrong one back.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/**
 * What the pointer would actually hit at a point, named by its testid.
 *
 * ⛔ `page.evaluate` RUNS IN THE BROWSER, so everything it needs is passed in or
 * declared inside the callback. Reads `elementFromPoint` because that is the
 * same answer the pointer gets, rather than trusting the rectangles to agree.
 */
async function hitAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py)
      if (!el) return null
      const owner = el.closest('[data-testid]')
      return owner?.getAttribute('data-testid') ?? el.tagName.toLowerCase()
    },
    [x, y],
  )
}

/** The active sequence's clips, so the test can ask what the drag actually did. */
async function clips(page: Page) {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { id: string; inS: number; fadeInS?: number }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, trackKind: t.kind })))
  })
}

/**
 * ⛔ THE GESTURE, NOT THE RECTANGLES. An earlier version of this test asked
 * `elementFromPoint` what sat at the clip's head and asserted `trim-in`. It
 * passed against the BROKEN code as well as the fixed code, so it proved
 * nothing: what the pointer hits and what the drag does are two different
 * questions, and only the second one is the defect. Benched on 2026-08-18 by
 * putting the old geometry back and watching this file stay green.
 */
test('dragging the head of a clip trims it, and does not fade it', async ({ page }) => {
  await boot(page)
  const clip = page.locator('[data-clip-kind="video"]').first()
  const box = (await clip.boundingBox())!
  expect(box.width).toBeGreaterThan(32) // the branch where the fade dots exist at all
  const before = (await clips(page)).find((c) => c.trackKind === 'video')!

  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y) // hover so the edge affordances render
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 24, y, { steps: 8 })
  await page.mouse.up()

  const after = (await clips(page)).find((c) => c.trackKind === 'video')!
  // A trim advances the source in-point. A fade would have left inS alone and
  // written fadeInS instead, which is the wrong edit and costs him an undo.
  expect(after.inS).toBeGreaterThan(before.inS)
  expect(after.fadeInS ?? 0).toBe(before.fadeInS ?? 0)
})

/**
 * ⛔ THIS IS THE ONE THAT CARRIES THE DEFECT. It fails against the old geometry
 * and passes against the new one; the trim test above passes against both. If
 * this file is ever cut down to one test, keep this one.
 */
test('a fade can be started from zero, because its handle is clear of the trim strip', async ({ page }) => {
  await boot(page)
  const clip = page.locator('[data-clip-kind="video"]').first()
  const box = (await clip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  // The fix parks a zero fade at the trim strip's edge rather than on top of it,
  // so the dot has to still be grabbable or this traded one broken gesture for
  // another. Its centre is at 6, its box spans 1..11, and 6..11 is clear.
  expect(await hitAt(page, box.x + 9, box.y + 4)).toBe('fade-in-handle')
})
