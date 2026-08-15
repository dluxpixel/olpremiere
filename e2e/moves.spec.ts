// THE MOVE BUDGET, counted for real.
//
// On 2026-08-09 his own sentence, "I want the zoom to go to the left of the
// screen, and then it zooms to the right, and then it zooms right back out",
// cost SEVENTEEN actions on the shipped build, and one of them silently ate
// another. The shelf of finished moves is supposed to cost two.
//
// Every test here counts the real interactions through one small wrapper and
// FAILS if the number goes over budget. That is the point of the file: the
// keyframes can be right and the feature can still have quietly rotted back
// toward seventeen, and no assertion about keyframe values would ever notice.
//
// The budget, from the research that specified this build:
//
//   his sentence, one clip .................. 2   (was 17)
//   his sentence, the next clip ............. 1   key
//   his sentence, a whole 20 clip Short ..... 2   and ONE undo step
//   undo a move he does not like ............ 1
//   change his mind, a different move ....... 1
//   take the move off entirely .............. 1
//   find out what is already on a clip ...... 0

import { expect, test, type Page } from '@playwright/test'

/** ui.punchDepth default: 120 percent. */
const DEPTH = 1.2
/** The aim of the travel moves, as a share of the frame, from the move table. */
const AIM_LEFT = 0.28
const AIM_RIGHT = 0.72

/**
 * A counter for what his hands actually do. Every click and every keypress in
 * these tests goes through it, so the budget is measured rather than asserted
 * from a comment.
 */
class Hands {
  moves = 0
  constructor(private page: Page) {}
  async click(testId: string): Promise<void> {
    this.moves++
    await this.page.getByTestId(testId).click()
  }
  async clickClip(index = 0): Promise<void> {
    this.moves++
    await this.page.getByTestId('clip').nth(index).click({ position: { x: 20, y: 10 } })
  }
  async press(key: string): Promise<void> {
    this.moves++
    await this.page.keyboard.press(key)
  }
}

async function seedClips(page: Page, count: number, durS = 4): Promise<void> {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
  await page.evaluate(
    async ({ count, durS }) => {
      type Clip = { id: string; inS: number; outS: number; startS: number; title?: unknown }
      type Seq = { tracks: { clips: Clip[] }[] }
      const storeMod = '/src/state/store.ts'
      const tlMod = '/src/engine/timeline.ts'
      const typesMod = '/src/engine/types.ts'
      const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
        updateActiveSequence: (label: string, fn: (seq: Seq) => Seq) => void
      }
      const { recomputeDuration } = (await import(/* @vite-ignore */ tlMod)) as {
        recomputeDuration: (seq: Seq) => Seq
      }
      const { newId } = (await import(/* @vite-ignore */ typesMod)) as { newId: () => string }
      updateActiveSequence('length for test', (sq) =>
        recomputeDuration({
          ...sq,
          tracks: sq.tracks.map((t) => {
            const seed = t.clips.find((c) => c.title)
            if (!seed) return t
            const made: Clip[] = []
            for (let i = 0; i < count; i++) {
              made.push({ ...seed, id: i === 0 ? seed.id : newId(), startS: i * durS, inS: seed.inS, outS: seed.inS + durS })
            }
            return { ...t, clips: made }
          }),
        }),
      )
    },
    { count, durS },
  )
  // Counted in the DOCUMENT, not the DOM: past a dozen clips the timeline only
  // draws what is on screen, and this is a fixture, not the thing under test.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const storeMod = '/src/state/store.ts'
        const typesMod = '/src/engine/types.ts'
        const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
          useStore: { getState: () => { project: unknown } }
        }
        const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
          activeSequence: (p: unknown) => { tracks: { clips: { title?: unknown }[] }[] }
        }
        return activeSequence(useStore.getState().project)
          .tracks.flatMap((t) => t.clips)
          .filter((c) => c.title).length
      }),
    )
    .toBe(count)
}

interface Facts {
  seqWidth: number
  scale: { t: number; value: number }[]
  posX: { t: number; value: number }[]
  undoDepth: number
  undoLabel: string | null
}

/** What the RENDERER reads on a clip, through the channel adapter, plus the undo stack. */
async function facts(page: Page, index = 0): Promise<Facts> {
  return page.evaluate(async (i) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; history: { undo: { label: string }[] } } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { width: number; tracks: { clips: { title?: unknown }[] }[] }
    }
    const { channelKeyframes } = (await import(/* @vite-ignore */ chMod)) as {
      channelKeyframes: (clip: unknown, ch: string) => readonly { t: number; value: number }[]
    }
    const state = useStore.getState()
    const seq = activeSequence(state.project)
    const clip = seq.tracks.flatMap((t) => t.clips).filter((c) => c.title)[i]
    const read = (ch: string) => channelKeyframes(clip, ch).map((k) => ({ t: k.t, value: k.value }))
    const undo = state.history.undo
    return {
      seqWidth: seq.width,
      scale: read('scale'),
      posX: read('posX'),
      undoDepth: undo.length,
      undoLabel: undo.length ? undo[undo.length - 1].label : null,
    }
  }, index)
}

/** How many clips carry a Zoom animation right now. */
async function animatedCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: unknown[] }[] }
    }
    const { isChannelAnimated } = (await import(/* @vite-ignore */ chMod)) as {
      isChannelAnimated: (clip: unknown, ch: string) => boolean
    }
    return activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .filter((c) => isChannelAnimated(c, 'scale')).length
  })
}

test('HIS SENTENCE COSTS TWO ACTIONS, and it is the move he described', async ({ page }) => {
  await seedClips(page, 1, 20)
  const hands = new Hands(page)

  // 1. He clicks the clip. 2. He clicks the move. That is the whole thing.
  await hands.clickClip()
  await hands.click('move-tile-leftThenRight')

  // Printed, not just asserted: the number is the whole point of the file, and a
  // budget that only ever shows up as a pass tells nobody how much room is left.
  console.log(`HIS SENTENCE COSTS ${hands.moves} ACTIONS (budget 2, was 17)`)
  expect(hands.moves, 'his sentence must cost 2 actions, not 17').toBeLessThanOrEqual(2)

  const f = await facts(page)
  // Six moments, and the LAST one brings the picture home: the punch out no
  // longer eats the travel, because the whole move is written in one pass.
  expect(f.scale).toHaveLength(6)
  expect(f.posX).toHaveLength(6)
  expect(f.scale[1].value).toBeCloseTo(DEPTH, 6)
  expect(f.scale[5].value).toBeCloseTo(1, 6)
  expect(f.posX[5].value).toBeCloseTo(0, 6)

  // In on the LEFT, across to the RIGHT: the exact shift the zoom pays for, and
  // the hold between them that the old build could not tell him he needed.
  const shift = (aim: number) => -(aim - 0.5) * f.seqWidth * (DEPTH - 1)
  expect(f.posX[1].value).toBeCloseTo(shift(AIM_LEFT), 3)
  expect(f.posX[2].value).toBeCloseTo(shift(AIM_LEFT), 3)
  expect(f.posX[3].value).toBeCloseTo(shift(AIM_RIGHT), 3)
  expect(f.posX[4].value).toBeCloseTo(shift(AIM_RIGHT), 3)
  expect(f.posX[1].value).toBeGreaterThan(0)
  expect(f.posX[3].value).toBeLessThan(0)

  // ONE undo step, named in his words.
  expect(f.undoLabel).toBe('Left, then right')
})

test('the same move on the NEXT clip is one key, and undo is one press', async ({ page }) => {
  await seedClips(page, 3)
  const hands = new Hands(page)
  await hands.clickClip(0)
  await hands.click('move-tile-leftThenRight')
  const after = hands.moves

  // Clip two: click along the timeline and tap the digit. The keyboard path has
  // to hold, because it is what makes a twenty clip Short bearable by hand.
  await hands.clickClip(1)
  await hands.press('6')
  expect(hands.moves - after, 'the next clip must cost at most 2, and 1 of them is the select').toBeLessThanOrEqual(2)
  expect(await animatedCount(page)).toBe(2)

  const before = (await facts(page, 1)).undoDepth
  await hands.press('Control+z')
  await expect.poll(async () => (await facts(page, 1)).undoDepth).toBe(before - 1)
  expect(await animatedCount(page)).toBe(1)
})

test('a whole 20 clip Short costs two actions and ONE undo step', async ({ page }) => {
  await seedClips(page, 20)
  const hands = new Hands(page)

  const before = (await facts(page)).undoDepth
  // Select all, click one tile.
  await hands.press('Control+a')
  await hands.click('move-tile-punchIn')
  expect(hands.moves, 'twenty clips must cost 2 actions, not 340').toBeLessThanOrEqual(2)

  await expect.poll(async () => animatedCount(page)).toBe(20)
  const f = await facts(page)
  expect(f.undoDepth, 'twenty clips is ONE undo step').toBe(before + 1)

  // And one press takes all twenty back.
  await hands.press('Control+z')
  await expect.poll(async () => animatedCount(page)).toBe(0)
})

test('changing his mind, and taking it off again, are one action each', async ({ page }) => {
  await seedClips(page, 1, 6)
  const hands = new Hands(page)
  await hands.clickClip()
  await hands.click('move-tile-leftThenRight')

  // What is on the clip, for nothing: the lit tile and the bar under the tiles.
  // Zero actions to find out, which used to be impossible.
  await expect(page.getByTestId('move-tile-leftThenRight')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('move-state')).toHaveText('Left, then right')
  await expect(page.getByTestId('move-ribbon')).toBeVisible()

  // A different move: ONE click, and it REPLACES rather than stacking.
  let at = hands.moves
  await hands.click('move-tile-pushIn')
  expect(hands.moves - at).toBe(1)
  await expect.poll(async () => (await facts(page)).scale.length).toBe(2)
  await expect(page.getByTestId('move-tile-pushIn')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('move-tile-leftThenRight')).toHaveAttribute('aria-pressed', 'false')

  // Off entirely: ONE click, and it takes the position with it, which the old
  // Clear motion did not (it cleared scale alone and left the clip sitting off
  // centre with no button left to fix it).
  at = hands.moves
  await hands.click('move-tile-none')
  expect(hands.moves - at).toBe(1)
  await expect.poll(async () => (await facts(page)).scale.length).toBe(0)
  expect((await facts(page)).posX).toHaveLength(0)
  await expect(page.getByTestId('move-state')).toHaveText('No move')
})

/**
 * ⛔ THE CAPTION UNDER THE RIBBON PROMISED A GESTURE THE CODE DID NOT HAVE.
 *
 * For a moment-long move it reads "Drag the block to move when it happens", and
 * only the 7px handle at the block's left edge did anything: he was aiming at a
 * sliver to do the thing the sentence under it described. Keyframe audit item 8.
 *
 * Driven through the block itself, and asserting the move MOVED and KEPT ITS
 * LENGTH, because a block that merely accepted the press would prove nothing.
 */
test('dragging the block of a moment move slides it without changing its length', async ({ page }) => {
  await seedClips(page, 1, 20)
  const hands = new Hands(page)
  await hands.clickClip()
  // Park the punch away from the head of the clip. A move sitting at 0 cannot
  // prove a slide: it has a wall on one side and nothing to say about the other.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ playheadS: 5 })
  })
  await hands.click('move-tile-shake')

  const times = async () => (await facts(page)).scale.map((k: { t: number }) => k.t)
  const before = await times()
  expect(before.length).toBeGreaterThan(1)
  const spanBefore = before[before.length - 1] - before[0]

  // The premise, asserted rather than assumed: the ribbon must be drawing this
  // as a MOMENT move, or the block carries no handler and everything below is
  // testing the wrong thing.
  await expect(page.getByTestId('move-ribbon-end')).toHaveCount(0)
  const block = page.getByTestId('move-ribbon-block')
  await expect(block).toBeVisible()
  const box = (await block.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await times())[0]).not.toBeCloseTo(before[0], 4)
  const after = await times()
  expect(after[0]).toBeGreaterThan(before[0]) // it went the way he dragged
  expect(after[after.length - 1] - after[0]).toBeCloseTo(spanBefore, 4) // same length
})

test('the shelf tells the truth after a hand edit, and the hand controls are one click away', async ({ page }) => {
  await seedClips(page, 1, 20)
  const hands = new Hands(page)
  await hands.clickClip()
  await hands.click('move-tile-leftThenRight')

  // The lanes are folded away by default: this is the whole point of the pass.
  await expect(page.getByTestId('punch-control')).toBeHidden()
  await page.getByTestId('tune-by-hand').click()
  await expect(page.getByTestId('punch-control')).toBeVisible()
  await expect(page.locator('[data-testid="keyframe-track"][data-channel="scale"]')).toBeVisible()

  // Nudge one diamond by hand and no tile is lit any more. The shelf never
  // claims a move the clip is not actually making.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
      updateActiveSequence: (label: string, fn: (seq: unknown) => unknown) => void
    }
    type Kf = { t: number }
    type Clip = { id: string; keyframes?: { scale?: Kf[] } }
    type Seq = { tracks: { clips: Clip[] }[] }
    const id = useStore.getState().ui.selection[0]
    updateActiveSequence('hand edit', (sq) => {
      const seq = sq as Seq
      return {
        ...seq,
        tracks: seq.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === id && c.keyframes?.scale
              ? { ...c, keyframes: { ...c.keyframes, scale: c.keyframes.scale.map((k, i) => (i === 2 ? { ...k, t: k.t + 0.5 } : k)) } }
              : c,
          ),
        })),
      }
    })
  })
  await expect(page.getByTestId('move-state')).toHaveText('Hand edited')
  await expect(page.getByTestId('move-tile-leftThenRight')).toHaveAttribute('aria-pressed', 'false')
})

// --- WHAT THE TILES SHOW -----------------------------------------------------
//
// v0.1.55 drew the same grey box with the same pale bar on all ten tiles, and
// the only thing that told Shake from Drift right was an animation that ran
// while the pointer was over the grid. So at rest, which is how the shelf spends
// almost all of its life, the feature was a word list with decoration on it.
//
// These three hold the fix to the thing he actually asked for: cover the labels
// and the ten are still ten, standing still, and nothing on the shelf moves
// while he is watching the monitor.

/** Every id on the shelf, in the order the tiles sit in. */
const TILE_IDS = [
  'none',
  'holdBig',
  'pushIn',
  'punchIn',
  'inAndOut',
  'pop',
  'leftThenRight',
  'rightThenLeft',
  'shake',
  'driftRight',
  // His ask, 2026-08-15: more presets to zoom out. Mirrors, so a glyph that came
  // out looking like the tile it mirrors would fail right here.
  'pullBack',
  'punchOut',
  'outAndIn',
] as const

/** What ONE tile actually draws: both panes of its picture, straight out of the DOM. */
async function picture(page: Page, id: string): Promise<string> {
  const stage = await page.getByTestId(`move-glyph-${id}`).innerHTML()
  const tape = await page.getByTestId(`move-tape-${id}`).innerHTML()
  return `${stage}|${tape}`
}

async function selectFirstClip(page: Page): Promise<void> {
  await page.getByTestId('clip').first().click({ position: { x: 20, y: 10 } })
  await expect(page.getByTestId('move-grid')).toBeVisible()
}

test('cover the labels and every tile is still its own picture', async ({ page }) => {
  await seedClips(page, 1, 6)
  await selectFirstClip(page)

  const drawn = new Map<string, string>()
  for (const id of TILE_IDS) {
    const key = await picture(page, id)
    const clash = drawn.get(key)
    expect(clash, `${id} draws exactly what ${clash} draws`).toBeUndefined()
    drawn.set(key, id)
  }
  expect(drawn.size, 'every tile draws its own picture').toBe(TILE_IDS.length)

  // And the selected tile is the PICTURE going accent, not a hairline border:
  // nine grey drawings and one lavender one.
  await page.getByTestId('move-tile-pushIn').click()
  await expect(page.getByTestId('move-glyph-pushIn')).toHaveClass(/text-accent/)
  await expect(page.getByTestId('move-glyph-shake')).not.toHaveClass(/text-accent/)
})

test('nothing on the shelf moves while it plays, with the pointer sitting on a tile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await seedClips(page, 1, 20)
  await selectFirstClip(page)

  // Hovering IS allowed to animate. It is the one moving part on the shelf and
  // it runs on the hovered tile alone.
  await page.getByTestId('move-tile-shake').hover()
  await expect(page.getByTestId('move-live-shake')).toHaveCount(1)

  const playheadS = async (): Promise<number> =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { ui: { playheadS: number } } }
      }
      return useStore.getState().ui.playheadS
    })

  await page.keyboard.press('Space')
  // The pointer has not moved. The loop still has to stand down: the shelf is on
  // screen for the whole of playback, and the Inspector around it already returns
  // a sentinel rather than re-render at frame rate.
  await expect(page.locator('[data-testid^="move-live-"]')).toHaveCount(0)
  const before = await picture(page, 'shake')
  const t0 = await playheadS()
  await page.waitForTimeout(600)
  expect(await playheadS(), 'the transport really did run').toBeGreaterThan(t0)
  expect(await picture(page, 'shake'), 'a tile must not redraw while the transport runs').toBe(before)
  await page.keyboard.press('Space')
})

test('reduced motion gets the same pictures, and the digits still pick a move', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seedClips(page, 1, 6)
  await selectFirstClip(page)

  // No loop at all, which is exactly why the still tile has to be the whole
  // picture rather than the first frame of one.
  await page.getByTestId('move-tile-shake').hover()
  await expect(page.locator('[data-testid^="move-live-"]')).toHaveCount(0)
  const drawn = new Set<string>()
  for (const id of TILE_IDS) drawn.add(await picture(page, id))
  expect(drawn.size, 'still one picture each with the motion off').toBe(TILE_IDS.length)

  // And the keyboard path is untouched: the digits still put a move on the clip.
  await page.keyboard.press('3')
  await expect(page.getByTestId('move-tile-punchIn')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('move-state')).toHaveText('Punch in')
})
