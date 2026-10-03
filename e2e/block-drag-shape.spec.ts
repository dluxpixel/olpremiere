// ⛔ A SELECTION DRAGGED WITH THE REAL MOUSE LANDS IN THE SAME SHAPE, 2026-10-03.
//
// His words that day: "sometimes when i drag audio or video clips lanes it deleted the clip behind
// it fix that, and lastly the dragging feature is still so shit! ... make it so when i select
// multiple stuff and drag it anywhere it actually works and stays in the SAME SHAPE as when i
// dragged it".
//
// The engine rules are pinned in src/engine/blockMove.test.ts and checked against thousands of
// random timelines in src/components/clipDrag.property.test.ts. What only a browser can show is
// that the real pointer, the real lanes and the real release land exactly that: these tests press,
// move and let go like his hand does and then read the store.
//
// Title clips are used so every clip has an exact, known length with no media to load.

import { expect, test, type Page } from '@playwright/test'

interface Spot {
  lane: string
  startS: number
  endS: number
}

/** Seed the active sequence: three video lanes and the default audio lanes, clips by lane name. */
async function seed(page: Page, lanes: Record<string, [id: string, startS: number, durS: number][]>, selection: string[]) {
  await page.evaluate(
    async ({ lanes, selection }) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const tlMod = '/src/engine/timeline.ts'
      const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { setUI: (p: unknown) => void } }
        updateActiveSequence: (label: string, fn: (s: Record<string, unknown>) => Record<string, unknown>) => void
      }
      const types = (await import(/* @vite-ignore */ typesMod)) as {
        newTrack: (kind: string, name: string) => Record<string, unknown>
        newTitleClip: (def: unknown, startS: number, durS: number) => Record<string, unknown>
        defaultTitleDef: (text: string) => unknown
      }
      const { recomputeDuration } = (await import(/* @vite-ignore */ tlMod)) as {
        recomputeDuration: (s: Record<string, unknown>) => Record<string, unknown>
      }
      updateActiveSequence('seed', (sq) => {
        const audio = (sq.tracks as { kind: string }[]).filter((t) => t.kind === 'audio')
        const video = ['V1', 'V2', 'V3'].map((name) => ({
          ...types.newTrack('video', name),
          clips: (lanes[name] ?? []).map(([id, startS, durS]) => ({
            ...types.newTitleClip(types.defaultTitleDef(id), startS, durS),
            id,
          })),
        }))
        return recomputeDuration({ ...sq, tracks: [...video, ...audio] })
      })
      useStore.getState().setUI({ selection, playheadS: 0 })
    },
    { lanes, selection },
  )
}

async function spots(page: Page): Promise<Record<string, Spot>> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence, clipEndS } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { name: string; clips: { id: string; startS: number }[] }[] }
      clipEndS: (c: unknown) => number
    }
    const out: Record<string, { lane: string; startS: number; endS: number }> = {}
    for (const t of activeSequence(useStore.getState().project).tracks) {
      for (const c of t.clips) out[c.id] = { lane: t.name, startS: +c.startS.toFixed(4), endS: +clipEndS(c).toFixed(4) }
    }
    return out
  })
}

async function selectionNow(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { ui: { selection: string[] } } } }
    return [...useStore.getState().ui.selection].sort()
  })
}

async function pxPerS(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { ui: { pxPerS: number } } } }
    return useStore.getState().ui.pxPerS
  })
}

const box = async (page: Page, id: string) => {
  const b = await page.locator(`[data-clip-id="${id}"]`).boundingBox()
  if (!b) throw new Error(`clip ${id} is not on screen`)
  return b
}

const LANE: Record<string, number> = { V1: 0, V2: 1, V3: 2 }

test('a four clip selection over two lanes, dragged up a lane and later past an obstacle, lands in exactly its shape', async ({ page }) => {
  await page.goto('/')
  // V1: a b. V2: c d. V3: the wall, which he did NOT select. All four of his clips are selected.
  await seed(page, { V1: [['a', 1, 2], ['b', 4, 1]], V2: [['c', 2, 2], ['d', 5, 1]], V3: [['wall', 9, 2]] }, ['a', 'b', 'c', 'd'])
  await expect(page.locator('[data-clip-id="wall"]')).toBeVisible()
  const before = await spots(page)
  const pps = await pxPerS(page)

  // Grab c on V2 and drag it up onto V3 (the wall's lane) and 4 s later.
  const c = await box(page, 'c')
  const wall = await box(page, 'wall')
  const x0 = c.x + c.width / 2
  const y0 = c.y + c.height / 2
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + 4 * pps, wall.y + wall.height / 2, { steps: 16 })
  await page.mouse.up()

  const after = await spots(page)
  // Every clip of the block moved by ONE time delta and ONE lane.
  const dT = after.c!.startS - before.c!.startS
  for (const id of ['a', 'b', 'c', 'd']) {
    expect(after[id]!.startS - before[id]!.startS, `${id} moved with the block`).toBeCloseTo(dT, 3)
    expect(after[id]!.endS - after[id]!.startS, `${id} kept its length`).toBeCloseTo(before[id]!.endS - before[id]!.startS, 3)
    expect(LANE[after[id]!.lane]! - LANE[before[id]!.lane]!, `${id} moved up one lane`).toBe(1)
  }
  // At +4 s, d would sit on the wall. The nearest spot the whole block fits is +3 s, with d butted
  // against the wall, and nothing was squeezed, split or left behind to get there.
  expect(dT).toBeCloseTo(3, 3)
  expect(after.wall).toEqual(before.wall)
  expect(after.d!.endS).toBeCloseTo(after.wall!.startS, 3)
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())

  // One drag, one undo, everything back where it was.
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  expect(await spots(page)).toEqual(before)
})

test("a clip dropped onto another lane never deletes the clip behind it, his 'deleted the clip behind it'", async ({ page }) => {
  await page.goto('/')
  // V1 packed with three cuts, an overlay on V2 right above the middle one.
  await seed(page, { V1: [['k1', 0, 2], ['k2', 2, 2], ['k3', 4, 2]], V2: [['ov', 2, 2]] }, [])
  const before = await spots(page)
  const pps = await pxPerS(page)
  const ov = await box(page, 'ov')
  const k2 = await box(page, 'k2')
  await page.mouse.move(ov.x + ov.width / 2, ov.y + ov.height / 2)
  await page.mouse.down()
  // Down onto V1 and half a second right: the old drag carved k2 out right here.
  await page.mouse.move(ov.x + ov.width / 2 + 0.5 * pps, k2.y + k2.height / 2, { steps: 12 })
  await page.mouse.up()

  const after = await spots(page)
  for (const id of ['k1', 'k2', 'k3']) expect(after[id], `${id} untouched`).toEqual(before[id])
  // V1 has no room where he let go, so the overlay goes to the nearest spot it fits: after k3.
  expect(after.ov).toEqual({ lane: 'V1', startS: 6, endS: 8 })
})

test('Shift held while grabbing one clip of a selection drags the whole selection and keeps it selected', async ({ page }) => {
  await page.goto('/')
  await seed(page, { V1: [['p', 0, 1], ['q', 2, 1], ['r', 4, 1]] }, ['p', 'q', 'r'])
  const before = await spots(page)
  const pps = await pxPerS(page)
  const q = await box(page, 'q')
  await page.keyboard.down('Shift')
  await page.mouse.move(q.x + q.width / 2, q.y + q.height / 2)
  await page.mouse.down()
  await page.mouse.move(q.x + q.width / 2 + 2 * pps, q.y + q.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.up('Shift')

  const after = await spots(page)
  for (const id of ['p', 'q', 'r']) expect(after[id]!.startS - before[id]!.startS, `${id} moved +2s`).toBeCloseTo(2, 3)
  expect(await selectionNow(page)).toEqual(['p', 'q', 'r'])
})

test('dragging past the top lane takes the selection as high as it can go, not back to where it started', async ({ page }) => {
  await page.goto('/')
  await seed(page, { V1: [['g', 0, 2]], V2: [['y', 0, 2]] }, ['g', 'y'])
  const g = await box(page, 'g')
  const ruler = await page.getByTestId('ruler').boundingBox()
  if (!ruler) throw new Error('no ruler')
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  // Up past every lane, onto the ruler: 10px above the top video lane.
  await page.mouse.move(g.x + g.width / 2, ruler.y + ruler.height - 10, { steps: 16 })
  await page.mouse.up()

  const after = await spots(page)
  // The top lane is V3. y is one lane above g, so the block can rise one lane and no more,
  // and it keeps its two lanes apart.
  expect(after.g).toEqual({ lane: 'V2', startS: 0, endS: 2 })
  expect(after.y).toEqual({ lane: 'V3', startS: 0, endS: 2 })
})

/** Set UI state (zoom, snapping) the way the toolbar does. */
async function ui(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (patch) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { setUI: (p: unknown) => void } } }
    useStore.getState().setUI(patch)
  }, patch)
}

async function undoDepth(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { history: { undo: unknown[] } } } }
    return useStore.getState().history.undo.length
  })
}

// ⛔ A CLICK IS A CLICK, 2026-10-03. Measured that day with the real mouse: a press whose hand
// drifted ONE pixel before letting go committed a move on 28 of 36 clicks across six zooms, up to
// a whole second zoomed out (the snap reaches 8 px), and a linked video clicked with nothing
// selected slid off its own sound. A clip gesture now starts only once the hand leaves the slop.
test('a click whose hand wobbles a pixel or two never moves anything, at any zoom', async ({ page }) => {
  await page.goto('/')
  for (const zoom of [4, 10, 60]) {
    for (const wobble of [1, 2, 3]) {
      await seed(page, { V1: [['v', 3, 2]], V2: [['x', 4, 2]] }, [])
      await ui(page, { pxPerS: zoom, snapping: true })
      await expect(page.locator('[data-clip-id="v"]')).toBeVisible()
      const before = await spots(page)
      const depth = await undoDepth(page)
      const v = await box(page, 'v')
      const x = v.x + v.width * 0.4
      const y = v.y + v.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + wobble, y)
      await page.mouse.up()
      expect(await spots(page), `zoom ${zoom}, wobble ${wobble}px`).toEqual(before)
      expect(await undoDepth(page), `zoom ${zoom}, wobble ${wobble}px: nothing to undo`).toBe(depth)
    }
  }
})

// ⛔ NO FLIGHT TO A LANE WITH NO ROOM NEAR HIS HAND, 2026-10-03. Measured that day: an overlay
// pulled down onto a packed V1 landed 50 s away, off the screen. It now stays on its own lane under
// his hand, nothing on V1 touched, and the preview showed exactly that.
test('an overlay pulled onto a packed lane with no room near the hand stays on its own lane, under the hand', async ({ page }) => {
  await page.goto('/')
  const cuts: [string, number, number][] = Array.from({ length: 30 }, (_, i) => [`k${i}`, i * 2, 2])
  await seed(page, { V1: cuts, V2: [['ov', 10, 2]] }, [])
  await ui(page, { snapping: false })
  const before = await spots(page)
  const pps = await pxPerS(page)
  const ov = await box(page, 'ov')
  const k5 = await box(page, 'k5')
  await page.mouse.move(ov.x + ov.width / 2, ov.y + ov.height / 2)
  await page.mouse.down()
  await page.mouse.move(ov.x + ov.width / 2 + 0.5 * pps, k5.y + k5.height / 2, { steps: 12 })
  // The preview is on screen, on V2, half a second on: where it will land.
  const drawn = await box(page, 'ov')
  expect(Math.abs(drawn.x - (ov.x + 0.5 * pps))).toBeLessThan(2)
  expect(Math.abs(drawn.y - ov.y)).toBeLessThan(2)
  await page.mouse.up()
  const after = await spots(page)
  for (const [id] of cuts) expect(after[id], `${id} untouched`).toEqual(before[id])
  expect(after.ov).toEqual({ lane: 'V2', startS: 10.5, endS: 12.5 })
})

// ⛔ HIS WHEEL SCROLLS THE LANES, THE CLIP STAYS IN HIS HAND, 2026-10-03. Measured that day: a clip
// held while the wheel scrolled the lanes 600 px sideways was left 600 px behind the pointer, and
// letting go dropped it 10 s from his hand.
test('scrolling the lanes with the wheel mid-drag keeps the clip under the pointer', async ({ page }) => {
  await page.goto('/')
  const far: [string, number, number][] = Array.from({ length: 40 }, (_, i) => [`t${i}`, i * 3, 2])
  await seed(page, { V1: far, V2: [['g', 2, 2]] }, [])
  await ui(page, { snapping: false })
  const pps = await pxPerS(page)
  const g = await box(page, 'g')
  const x0 = g.x + g.width / 2
  const y0 = g.y + g.height / 2
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + 100, y0, { steps: 8 })
  const scrollLeft = () => page.evaluate(() => (document.querySelector('[data-testid="timeline-lanes"]') as HTMLElement).scrollLeft)
  const left0 = await scrollLeft()
  await page.mouse.wheel(600, 0)
  await expect.poll(scrollLeft).toBeGreaterThan(left0 + 500)
  const by = (await scrollLeft()) - left0
  // The clip is still under the pointer: its left edge sits where it did relative to the hand.
  const held = await box(page, 'g')
  expect(Math.abs(held.x - (g.x + 100))).toBeLessThan(2 + pps / 30)
  await page.mouse.up()
  const after = await spots(page)
  expect(after.g!.lane).toBe('V2')
  expect(after.g!.startS).toBeCloseTo(2 + (100 + by) / pps, 1)
})
