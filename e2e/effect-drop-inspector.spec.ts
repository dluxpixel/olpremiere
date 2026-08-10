// Dragging an effect from the Effects panel onto the INSPECTOR (2026-08-10).
//
// THE BUG THIS EXISTS FOR. The Inspector's empty effect card has said, in
// words, "No effects applied. Drag one from the Effects panel, or double-click
// it" since the day it was written, and nothing was listening: EffectControls
// carried no onDrop and no onDragOver at all. Double-click worked. The drag
// died, silently, in the one place the sentence points at.
//
// WHY IT HAS TO BE A BROWSER TEST. There was no broken unit to catch. Every
// function involved was correct; the wiring between them did not exist, and a
// promise with nothing behind it is invisible to a unit test by construction.
// The repo has been bitten by this class twice this week (a shipped feature
// deleted rather than moved, caught only by a spec that clicked the button; a
// shelf of tiles that all drew the same picture at rest). So this file performs
// the gesture instead of calling the action - effectDrop.test.ts already drives
// the action - and the two halves cover different failures.
//
// THE DRAG IS REAL ON BOTH ENDS. The payload comes out of the Effects panel
// row's own onDragStart, never out of a DataTransfer this file fabricates, so a
// row that stops putting an effect on the drag fails here too. The event shape
// is the one effects.spec.ts already uses for the clip drop (dispatch DragEvent
// with a DataTransfer: Playwright's mouse-driven dragTo cannot carry a custom
// MIME type, and the MIME is the whole contract). The one addition is that the
// drag is held OPEN across calls, on window.__fxDrag, so the mid-drag "I will
// take this" hint can be asserted BEFORE the release. A drop target that only
// answers after the fact is half the original bug.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/effect-drop'
const EFFECT_MIME = 'application/x-olpremiere-effect'

type Kf = { t: number; value: number; ease: string; curve?: number[] }
type Fx = { id: string; type: string; params: Record<string, unknown>; enabled: boolean }
interface ClipShot {
  id: string
  effects: Fx[]
  [key: string]: unknown
}

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

// --- the app, with clips on it ----------------------------------------------

/**
 * Import the fixture, drop `count` copies on the timeline, then open the
 * Effects tab (which is where the drag has to start from). Returns the video
 * clip ids; the imported webm carries linked audio, and an audio clip never
 * takes a visual effect.
 */
async function openWithClips(page: Page, count = 1): Promise<string[]> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  for (let i = 0; i < count; i++) {
    await page.getByTestId('asset-card').dblclick()
    await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(i + 1)
  }
  await page.getByRole('tab', { name: 'Effects' }).click()
  await expect(page.getByTestId('effect-item').first()).toBeVisible()
  return videoClipIds(page)
}

async function videoClipIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    // The literal-specifier indirection every spec here uses: a plain string
    // would make tsc try to resolve these browser-only paths at build time.
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
      .map((c) => c.id)
  })
}

async function select(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (sel) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (patch: unknown) => void } }
    }
    useStore.getState().setUI({ selection: sel })
  }, ids)
}

/** The clip's effect stack, straight from the store, in stack order. */
async function stack(page: Page, clipId: string): Promise<{ id: string; type: string }[]> {
  return page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; effects: { id: string; type: string }[] }[] }[]
      }
    }
    const clip = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id)
    return (clip?.effects ?? []).map((e) => ({ id: e.id, type: e.type }))
  }, clipId)
}

const stackTypes = async (page: Page, clipId: string): Promise<string[]> =>
  (await stack(page, clipId)).map((e) => e.type)

// --- the drag itself ---------------------------------------------------------

/**
 * Pick an effect up off its row in the Effects panel. The row's OWN dragstart
 * handler fills the DataTransfer, and this refuses to continue if it comes back
 * empty or carrying something else: the source half of the promise is as real a
 * failure as the target half, and this file must not paper over it by writing
 * the payload itself.
 */
async function pickUp(page: Page, payload: string): Promise<void> {
  const row = page.locator(`[data-testid="effect-item"][data-payload="${payload}"]`)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('draggable', 'true')
  await page.evaluate(
    ({ payload, mime }) => {
      const el = document.querySelector(`[data-testid="effect-item"][data-payload="${payload}"]`)
      if (!el) throw new Error(`no Effects panel row for "${payload}"`)
      const dt = new DataTransfer()
      el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      if (!dt.types.includes(mime)) throw new Error(`the "${payload}" row put no effect on the drag`)
      const carried = dt.getData(mime)
      if (carried !== payload) throw new Error(`the "${payload}" row dragged "${carried}" instead`)
      // Held open so the hint can be read mid-gesture, before the release.
      ;(window as unknown as { __fxDrag?: DataTransfer }).__fxDrag = dt
    },
    { payload, mime: EFFECT_MIME },
  )
}

/**
 * Move the held drag over a target. Returns whether the target ACCEPTED it:
 * preventDefault on dragover is the acceptance, and without it the browser
 * shows "no drop" and never fires a drop event at all, which is exactly what
 * this panel used to do.
 */
async function dragOver(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const dt = (window as unknown as { __fxDrag?: DataTransfer }).__fxDrag
    if (!dt) throw new Error('no drag is in flight')
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) throw new Error(`no drop target "${id}" on the page`)
    const r = el.getBoundingClientRect()
    const ev = new DragEvent('dragover', {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }, testId)
}

/** Let go over a target. */
async function release(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as { __fxDrag?: DataTransfer }
    const dt = w.__fxDrag
    if (!dt) throw new Error('no drag is in flight')
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) throw new Error(`no drop target "${id}" on the page`)
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    )
    w.__fxDrag = undefined
  }, testId)
}

/** The whole gesture, refusing to continue if the target will not take it. */
async function dragEffectOnto(page: Page, payload: string, testId: string): Promise<void> {
  await pickUp(page, payload)
  expect(await dragOver(page, testId), `"${testId}" refused the "${payload}" drag`).toBe(true)
  await release(page, testId)
}

// --- his keyframes, the ones a drop must not touch ---------------------------
//
// Awkward times, off-integer values, a mix of eases and one hand-shaped curve,
// all inside the 2s fixture: anything that rounds, re-times, re-eases or drops
// the curve shows up as a difference rather than as an equal count.

const SCALE_KFS: Kf[] = [
  { t: 0.05, value: 1, ease: 'easeOut' },
  { t: 0.7333, value: 1.42, ease: 'easeInOut', curve: [0.2, 0, 0.35, 1] },
  { t: 1.9, value: 0.98, ease: 'linear' },
]
const POS_X_KFS: Kf[] = [
  { t: 0, value: -140, ease: 'linear' },
  { t: 1.25, value: 37.5, ease: 'hold' },
]
const POS_Y_KFS: Kf[] = [
  { t: 0.5, value: 12, ease: 'easeIn' },
  { t: 1.6, value: -8.75, ease: 'easeOut' },
]
/** An effect param that is ALREADY animated: this one materialises a Gaussian Blur. */
const BLUR_KFS: Kf[] = [
  { t: 0.1, value: 0, ease: 'linear' },
  { t: 1.4, value: 14.5, ease: 'easeInOut' },
]

async function seedKeyframes(page: Page, clipId: string): Promise<void> {
  await page.evaluate(
    async ({ clipId, scale, posX, posY, blur }) => {
      type C = { id: string }
      type Seq = { tracks: { clips: C[] }[] }
      const chMod = '/src/engine/effects/channels.ts'
      const storeMod = '/src/state/store.ts'
      const { withChannelKeyframes } = (await import(/* @vite-ignore */ chMod)) as {
        withChannelKeyframes: (clip: C, channel: string, kfs: Kf[]) => C
      }
      const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
        updateActiveSequence: (label: string, fn: (seq: Seq) => Seq) => void
      }
      const shape = (c: C): C =>
        withChannelKeyframes(
          withChannelKeyframes(
            withChannelKeyframes(withChannelKeyframes(c, 'scale', scale), 'posX', posX),
            'posY',
            posY,
          ),
          'blur',
          blur,
        )
      updateActiveSequence('seed keyframes', (sq) => ({
        ...sq,
        tracks: sq.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? shape(c) : c)),
        })),
      }))
    },
    { clipId, scale: SCALE_KFS, posX: POS_X_KFS, posY: POS_Y_KFS, blur: BLUR_KFS },
  )
}

/** What the app itself reports for each animated channel. */
async function channels(page: Page, clipId: string): Promise<Record<string, Kf[]>> {
  return page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const { channelKeyframes } = (await import(/* @vite-ignore */ chMod)) as {
      channelKeyframes: (clip: unknown, channel: string) => Kf[]
    }
    const clip = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id)
    const read = (ch: string): Kf[] => channelKeyframes(clip, ch).map((k) => ({ ...k }))
    return { scale: read('scale'), posX: read('posX'), posY: read('posY'), blur: read('blur') }
  }, clipId)
}

/** The whole clip as plain data, so "nothing else moved" can be said literally. */
async function clipSnapshot(page: Page, clipId: string): Promise<ClipShot> {
  return page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const clip = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id)
    if (!clip) throw new Error(`clip ${id} is gone`)
    return structuredClone(clip) as unknown as ClipShot
  }, clipId)
}

// --- the specs ---------------------------------------------------------------

test('a drag from the Effects panel onto the Inspector lands the effect he dragged', async ({ page }) => {
  const [clipId] = await openWithClips(page)
  await select(page, [clipId])
  // The sentence that made the promise is on screen, and the stack is empty.
  await expect(page.getByTestId('effect-stack-empty')).toContainText('Drag one from the Effects panel')
  expect(await stackTypes(page, clipId)).toEqual([])

  await dragEffectOnto(page, 'vignette', 'effect-stack')

  // It landed, it is a Vignette and not merely "an effect", and the empty state
  // is gone.
  await expect(page.getByTestId('effect-stack-empty')).toHaveCount(0)
  await expect(page.locator('[data-testid="effect-card"][data-effect-type="vignette"]')).toBeVisible()
  await expect(page.getByTestId('effect-card')).toHaveCount(1)
  await expect(page.getByTestId('effect-card')).toContainText('Vignette')
  expect(await stackTypes(page, clipId)).toEqual(['vignette'])

  // ONE undo takes it away: the drop is a single command, the same one the
  // double-click and the right-click menu record.
  await page.keyboard.press('Control+z')
  expect(await stackTypes(page, clipId)).toEqual([])
})

test('the Inspector shows it will accept BEFORE he lets go, and stops once he has', async ({ page }) => {
  const [clipId] = await openWithClips(page)
  await select(page, [clipId])
  const section = page.getByTestId('effect-stack')
  const card = page.getByTestId('effect-stack-empty')
  await section.scrollIntoViewIfNeeded()
  await expect(section).not.toHaveAttribute('data-drop-hot', 'true')
  const atRest = await card.screenshot({ path: `${VERIFY}/empty-card-rest.png` })

  await pickUp(page, 'vignette')
  expect(await dragOver(page, 'effect-stack')).toBe(true)

  // The section takes the drop, and the card he is actually aiming at is what
  // answers him.
  await expect(section).toHaveAttribute('data-drop-hot', 'true')
  await expect(card).toHaveAttribute('data-drop-hot', 'true')
  // And it must DRAW differently, not just carry an attribute. A shelf of tiles
  // in this app once all drew the same picture while their state said otherwise.
  await expect
    .poll(async () => (await card.screenshot()).equals(atRest), {
      message: 'the drop hint changed no pixels',
    })
    .toBe(false)
  await card.screenshot({ path: `${VERIFY}/empty-card-hot.png` })

  await release(page, 'effect-stack')

  await expect(section).not.toHaveAttribute('data-drop-hot', 'true')
  expect(await stackTypes(page, clipId)).toEqual(['vignette'])
})

test('with no clip selected the drop is refused OUT LOUD, not swallowed', async ({ page }) => {
  // The exact gesture he made. It used to end in nothing at all, with no reason
  // given, which is the complaint.
  const [clipId] = await openWithClips(page)
  await select(page, [])
  const empty = page.getByTestId('inspector-empty')
  await expect(empty).toBeVisible()
  const refusal = page.getByTestId('toast').filter({ hasText: 'Select a clip first' })
  await expect(refusal).toHaveCount(0)

  await pickUp(page, 'vignette')
  // It ACCEPTS the gesture rather than refusing under the cursor: a drag that
  // dies with no explanation is the thing being fixed, so the explanation has
  // to be reachable.
  expect(await dragOver(page, 'inspector-empty')).toBe(true)
  await expect(empty).toHaveAttribute('data-drop-hot', 'true')
  await release(page, 'inspector-empty')

  await expect(refusal).toBeVisible()
  // Refused, not half-applied: nothing landed anywhere.
  expect(await stackTypes(page, clipId)).toEqual([])
})

test('a second drop adds to the stack and leaves the order he arranged alone', async ({ page }) => {
  const [clipId] = await openWithClips(page)
  await select(page, [clipId])

  await dragEffectOnto(page, 'saturation', 'effect-stack')
  await dragEffectOnto(page, 'vignette', 'effect-stack')
  // Added, not replaced, and not shuffled: both are there, in the order they
  // were dropped.
  expect(await stackTypes(page, clipId)).toEqual(['saturation', 'vignette'])
  await expect(page.getByTestId('effect-card')).toHaveCount(2)

  // He rearranges them by hand, away from the canonical order...
  await page.getByTestId('effect-card').last().getByTestId('effect-up').click()
  expect(await stackTypes(page, clipId)).toEqual(['vignette', 'saturation'])
  const his = (await stack(page, clipId)).map((e) => e.id)

  // ...and a third drop must not undo that. The stack is his.
  await dragEffectOnto(page, 'gaussianBlur', 'effect-stack')

  const after = await stack(page, clipId)
  expect(after.map((e) => e.type)).toEqual(['vignette', 'saturation', 'gaussianBlur'])
  // Same instances, still in HIS order; the newcomer was simply added.
  expect(after.filter((e) => his.includes(e.id)).map((e) => e.id)).toEqual(his)
  await expect(page.getByTestId('effect-card')).toHaveCount(3)
})

test('a clip full of keyframes keeps every one of them, values and times', async ({ page }) => {
  const [clipId] = await openWithClips(page)
  await select(page, [clipId])
  // Keyframed transform channels AND an already keyframed effect param (the
  // blur channel materialises a Gaussian Blur and animates its radius).
  await seedKeyframes(page, clipId)
  const before = await clipSnapshot(page, clipId)
  expect(before.effects).toHaveLength(1)
  expect((await channels(page, clipId)).blur).toEqual(BLUR_KFS)

  await dragEffectOnto(page, 'vignette', 'effect-stack')

  const after = await clipSnapshot(page, clipId)
  const now = await channels(page, clipId)
  // Times AND values AND eases AND the hand-shaped curve, per channel.
  expect(now.scale).toEqual(SCALE_KFS)
  expect(now.posX).toEqual(POS_X_KFS)
  expect(now.posY).toEqual(POS_Y_KFS)
  expect(now.blur).toEqual(BLUR_KFS)
  // Spelled out once so a change to the fixture cannot quietly weaken it: the
  // moments, and the numbers on them, are what he would lose.
  expect(now.scale.map((k) => [k.t, k.value])).toEqual([
    [0.05, 1],
    [0.7333, 1.42],
    [1.9, 0.98],
  ])
  expect(now.scale[1].curve).toEqual([0.2, 0, 0.35, 1])

  // The animated instance itself is untouched, byte for byte, even though the
  // newcomer sorts in FRONT of it. Its keyframes live on the instance, so an
  // instance that was rebuilt rather than kept would lose them.
  const hisIds = before.effects.map((e) => e.id)
  expect(after.effects.filter((e) => hisIds.includes(e.id))).toEqual(before.effects)
  expect(after.effects).toHaveLength(before.effects.length + 1)
  expect(after.effects.some((e) => e.type === 'vignette')).toBe(true)
  // And nothing else about the clip moved either: transform, opacity, trim,
  // the lot. Only `effects` grew.
  expect({ ...after, effects: [] }).toEqual({ ...before, effects: [] })
})

test('with two clips selected the drop lands on both, in one undo step', async ({ page }) => {
  // Same panel, same promise: an effect that lands on one clip but is refused
  // the moment a second is selected is the same broken promise in a new place.
  const ids = await openWithClips(page, 2)
  expect(ids).toHaveLength(2)
  await select(page, ids)
  const multi = page.getByTestId('multi-effects')
  await expect(multi).toBeVisible()

  await pickUp(page, 'vignette')
  expect(await dragOver(page, 'multi-effects')).toBe(true)
  await expect(multi).toHaveAttribute('data-drop-hot', 'true')
  await release(page, 'multi-effects')

  for (const id of ids) expect(await stackTypes(page, id)).toEqual(['vignette'])

  await page.keyboard.press('Control+z')
  for (const id of ids) expect(await stackTypes(page, id)).toEqual([])
})
