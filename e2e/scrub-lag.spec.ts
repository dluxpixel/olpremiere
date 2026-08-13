// HIS WORDS, carried unchanged from the handoff: "scrubbing with the playhead is
// still laggy". Nothing had ever been measured on it, so this measures it.
//
// ⛔ WHAT IT MEASURES IS THE COALESCING, NOT THE FRAME RATE. A pointer device
// reports far faster than a screen redraws: an ordinary mouse is 125 Hz and a
// gaming mouse is 1000. The ruler used to call `scrubTo` on EVERY pointermove,
// and each call is a store write plus a React render of a timeline holding every
// clip. So on his hardware the work was up to eight times what the screen could
// ever show, and the extra was pure lag.
//
// The assertion is therefore about how many STORE WRITES a burst of pointer
// events produces, which is a property that holds on any machine, rather than a
// millisecond budget, which would be a different number on every box and would
// have to be re-tuned forever. Monitor.tsx already caps its own redraw for
// exactly this reason; the timeline did not.

import { expect, test } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

test('scrubbing the ruler coalesces to one update per frame, not one per pointer event', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Count every distinct playhead value the store is asked to hold.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        subscribe: (cb: (s: { ui: { playheadS: number } }) => void) => () => void
      }
    }
    const w = window as unknown as { __scrubWrites: number }
    w.__scrubWrites = 0
    let last = -1
    useStore.subscribe((s) => {
      if (s.ui.playheadS !== last) {
        last = s.ui.playheadS
        w.__scrubWrites++
      }
    })
  })

  const ruler = page.getByTestId('ruler')
  const box = (await ruler.boundingBox())!
  const y = box.y + 8

  // ⛔ THE BURST IS DISPATCHED FROM INSIDE THE PAGE, IN ONE SYNCHRONOUS LOOP,
  // and that detail is the whole test. Driving it with `page.mouse.move` proves
  // nothing: each of those is a round trip slow enough that a frame runs between
  // every event, so even uncoalesced code writes once per frame and the numbers
  // look identical. A real mouse does not wait for a frame between reports, and
  // neither does this.
  await page.mouse.move(box.x + 20, y)
  await page.mouse.down()
  const MOVES = 60
  await page.evaluate(
    ({ startX, y, moves }) => {
      const ruler = document.querySelector('[data-testid="ruler"]')!
      for (let i = 1; i <= moves; i++) {
        ruler.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            pointerType: 'mouse',
            bubbles: true,
            clientX: startX + i * 4,
            clientY: y,
          }),
        )
      }
    },
    { startX: box.x + 20, y, moves: MOVES },
  )
  await page.mouse.up()

  // Let any frame still owed actually run, so the last write is counted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

  const writes = await page.evaluate(() => (window as unknown as { __scrubWrites: number }).__scrubWrites)

  // ⛔ THE POINT OF THE WHOLE TEST. Uncoalesced this is one write per move, so
  // it lands at or above MOVES. Coalesced it is one per animation frame, and a
  // burst dispatched this fast spans far fewer frames than it has events.
  expect(
    writes,
    `store writes for ${MOVES} pointer moves: uncoalesced scrubbing writes once per EVENT, ` +
      `which on a 1000 Hz mouse is eight times what the screen can show and is the lag he reported`,
  ).toBeLessThan(MOVES)

  // And it still actually scrubbed: the playhead has to have gone somewhere, or
  // a test that "passes" by doing nothing at all would look identical.
  const playhead = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
    return useStore.getState().ui.playheadS
  })
  expect(playhead, 'the scrub actually moved the playhead').toBeGreaterThan(0)
})
