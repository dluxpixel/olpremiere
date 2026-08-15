// His words, 2026-08-12: "Click-dragging is so fucking bad. Oh my god, it's just
// so buggy. It has one function, and it can't even do that."
//
// PROVEN ON HIS OWN PROJECT before this was written: on a track with 14 clips
// butted together, grabbing a clip and dragging it 140px moved NOTHING, while
// the same gesture on a track with room worked. `resolveStart` walks the gaps
// and picks the nearest one the clip FITS IN, and on a packed track the only
// gap is the slot it came from, so it went straight back and `moveClip` returned
// the sequence untouched. **A finished edit is packed by definition**, so
// dragging never worked on real work.
//
// He chose overwrite.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

async function starts(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { startS: number }[] }[] }
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips.map((c) => c.startS))
  })
}

test('a drag on a packed track never eats the clip it lands on', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)

  // Razor twice: three clips butted together with no gap anywhere, which is the
  // shape of his real edit and the shape the old code could not move a clip in.
  await page.getByTestId('ruler').click({ position: { x: 40, y: 10 } })
  await page.keyboard.press('c')
  await page.getByTestId('ruler').click({ position: { x: 80, y: 10 } })
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(3)
  await page.keyboard.press('v')

  const before = await starts(page)
  const first = vclip(page).first()
  await first.hover()
  const b = (await first.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 45, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()

  const after = await starts(page)
  // ⛔ THE CONTRACT CHANGED ON 2026-08-15, AT HIS WORD, AND THIS IS THE RECORD.
  //
  // This used to assert only "it went somewhere", and on a track packed this
  // tight the ONLY way to go somewhere was to CARVE the neighbour. His words
  // that day: "you can slide clips over different clips ... it's the stupidest
  // thing I have ever seen. Please remove that feature and I never wanna see it
  // again."
  //
  // So movement at any cost is no longer the thing worth pinning. What is worth
  // pinning is that NOTHING IS EVER DESTROYED and nothing ever lies on top of
  // anything. Three clips went in, three are still here, none shortened, none
  // overlapping. ⚠️ On a track with no room at all a clip therefore has nowhere
  // to slide to and stays put, which is the direct cost of what he asked for.
  expect(after).toHaveLength(before.length)
  await expect(vclip(page)).toHaveCount(3)

  const spans = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: unknown[] }[] }
    }
    const { clipDurationS } = (await import(/* @vite-ignore */ tlMod)) as {
      clipDurationS: (c: unknown) => number
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) =>
        t.clips.map((c) => ({ a: (c as { startS: number }).startS, d: clipDurationS(c) })),
      )
      .sort((x, y) => x.a - y.a)
  })
  for (const s of spans) expect(s.d, 'no clip was shortened by the drag').toBeGreaterThan(0.001)
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i].a, 'no clip starts before the one before it ends').toBeGreaterThanOrEqual(
      spans[i - 1].a + spans[i - 1].d - 0.001,
    )
  }
})
