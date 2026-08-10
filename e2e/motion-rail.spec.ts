// The motion desk, driven the way he drives it: park the playhead on a 20 second
// clip, punch in, zoom the rail until the 5 frame rise is a thumb's width, click
// the RAIL BETWEEN the two diamonds, and shape that move in the curve editor.
//
// This is the only thing that proves the panel opens. The unit suite proves the
// maths of every piece separately - bezierEase, punchOutClip, the ruler mapping,
// segmentIndexAt - and not one of those tests puts a diamond on screen, let
// alone two far enough apart to click between.
//
// The rail zoom is the load-bearing part and it gets asserted as a MEASUREMENT,
// not quoted from the design note: KeyframeLane used to render 240px wide with a
// 76px label gutter, so a 5 frame punch on a 20 second clip was under two pixels
// and could not be grabbed at all. Test one measures that premise first (on a
// fitted rail the two diamonds OVERLAP, so there is no rail between them to
// click), then earns the click by zooming, then clicks it.
//
// Tests two and three pin the two verbs the app could not express before the
// motion pass: punch OUT at an arbitrary moment mid clip, and cut punch.
//
// NOT COVERED HERE, deliberately and on the record: the plan's "copy both
// keyframes, paste onto the next clip". No such verb exists in the app. Ctrl+C
// and Ctrl+V are bound to copySelection / pasteAtPlayhead, which move whole
// CLIPS; the rail collects a multi-select (MotionRail's picks) but nothing
// consumes it for copy or paste, and state/clipboard.ts never mentions a
// keyframe. Writing that test would mean calling engine helpers from inside the
// spec, which is the drag-test mistake this repo has already paid for twice, so
// it is left unwritten and reported instead.

import { expect, test, type Page } from '@playwright/test'

/** The sequence default, and the frame grid every keyframe here snaps to. */
const FPS = 30
/** ui.punchRiseFrames default: 5 frames is the 200ms rise at 30fps. */
const RISE_S = 5 / FPS
/** ui.punchDepth default. */
const DEPTH = 1.2
/** The rail between two diamonds, in px, that counts as a thumb's width. */
const GRABBABLE_PX = 40

async function setUI(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (x: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

/**
 * A title on the timeline, stretched to the 20 seconds his brief describes.
 *
 * The stretch is FIXTURE, not the thing under test: 20 seconds is the length
 * that makes a 5 frame rise two pixels wide on a fitted rail, which is the whole
 * reason the rail zooms at all. Same shape of setup nudge linked-delete.spec.ts
 * makes when it parks a take at 3s rather than dragging it there.
 */
async function addTwentySecondClip(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('add-title').click()
  await expect(page.getByTestId('clip')).toHaveCount(1)
  return page.evaluate(async (durationS) => {
    type Clip = { id: string; inS: number; outS: number; title?: unknown }
    type Seq = { tracks: { clips: Clip[] }[] }
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
      updateActiveSequence: (label: string, fn: (seq: Seq) => Seq) => void
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => Seq
    }
    const { recomputeDuration } = (await import(/* @vite-ignore */ tlMod)) as {
      recomputeDuration: (seq: Seq) => Seq
    }
    updateActiveSequence('length for test', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.title ? { ...c, outS: c.inS + durationS } : c)),
        })),
      }),
    )
    return activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.title)!.id
  }, 20)
}

/** Select the title for real, the way he does: click it on the timeline. */
async function selectTheClip(page: Page): Promise<void> {
  await page.getByTestId('clip').click({ position: { x: 20, y: 10 } })
}

interface ScaleKey {
  t: number
  value: number
  ease: string
  curve: number[] | null
}

/** Every Zoom keyframe as the RENDERER reads it, through the channel adapter. */
async function scaleKeys(page: Page): Promise<ScaleKey[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: unknown }[] }[] }
    }
    const { channelKeyframes } = (await import(/* @vite-ignore */ chMod)) as {
      channelKeyframes: (
        clip: unknown,
        ch: string,
      ) => readonly { t: number; value: number; ease: string; curve?: number[] }[]
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)
    return channelKeyframes(clip, 'scale').map((k) => ({
      t: k.t,
      value: k.value,
      ease: k.ease,
      curve: k.curve ? [...k.curve] : null,
    }))
  })
}

/**
 * What the app itself resolves the Zoom to at each LOCAL time, plus the clip's
 * static base. Never a curve re-implemented in the spec: this is the same
 * resolveChannel the preview and the exporter both reach through.
 */
async function resolvedScale(page: Page, localTs: number[]): Promise<{ base: number; at: number[] }> {
  return page.evaluate(async (ts) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: unknown }[] }[] }
    }
    const { channelBase, resolveChannel } = (await import(/* @vite-ignore */ chMod)) as {
      channelBase: (clip: unknown, ch: string) => number
      resolveChannel: (clip: unknown, ch: string, localT: number) => number
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.title)
    return { base: channelBase(clip, 'scale'), at: ts.map((t) => resolveChannel(clip, 'scale', t)) }
  }, localTs)
}

/**
 * Pixels of clickable rail between the first two Zoom diamonds, measured off the
 * rendered DOM. NEGATIVE means their boxes overlap and there is nothing between
 * them to click, which is exactly the state a fitted 20 second rail is in.
 */
async function railGapPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lane = document.querySelector('[data-testid="keyframe-track"][data-channel="scale"]')
    if (!lane) throw new Error('no Zoom lane on the rail')
    const marks = [...lane.querySelectorAll('[data-testid="keyframe"]')]
    if (marks.length < 2) throw new Error(`expected two Zoom diamonds, found ${marks.length}`)
    const a = marks[0].getBoundingClientRect()
    const b = marks[1].getBoundingClientRect()
    return b.left - a.right
  })
}

/**
 * Where the punch sits, as an x inside the ruler. Zooming about this point is
 * what keeps the move he is aiming at under the cursor instead of sliding it out
 * of the window a notch at a time.
 */
async function punchXInRuler(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lane = document.querySelector('[data-testid="keyframe-track"][data-channel="scale"]')
    const ruler = document.querySelector('[data-testid="motion-rail-ruler"]')
    if (!lane || !ruler) throw new Error('no rail')
    const first = lane.querySelector('[data-testid="keyframe"]')
    if (!first) throw new Error('no Zoom diamond')
    const d = first.getBoundingClientRect()
    const r = ruler.getBoundingClientRect()
    return Math.min(Math.max(d.left + d.width / 2 - r.left, 1), Math.max(1, r.width - 1))
  })
}


/**
 * The lanes, the curve editor and the punch buttons are hand controls now: they
 * fold away under the move shelf's 'Tune it by hand' so the panel opens on ten
 * finished moves instead of on a desk of parameters. Everything below is still
 * exactly one click away, and this is that click.
 */
async function openHandControls(page: Page): Promise<void> {
  const toggle = page.getByTestId('tune-by-hand')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

test('zooming the rail earns the click between two diamonds, and that segment opens the curve editor', async ({
  page,
}) => {
  await addTwentySecondClip(page)
  await selectTheClip(page)
  await openHandControls(page)
  await setUI(page, { playheadS: 4 })

  // One click. The frame rises to 120 percent over 5 frames and STAYS there for
  // the remaining 16 seconds, so the Zoom lane carries exactly two diamonds.
  await page.getByTestId('punch-apply').click()

  const lane = page.locator('[data-testid="keyframe-track"][data-channel="scale"]')
  await expect(lane).toBeVisible()
  const diamonds = lane.getByTestId('keyframe')
  await expect(diamonds).toHaveCount(2)

  // Fit the whole 20 seconds first, with the rail's own double-click. The rail
  // fits ONCE per clip on purpose (it must not throw his zoom away every time a
  // panel resizes), and this clip was stretched after it opened, so the fit has
  // to be asked for rather than assumed. It is also the honest starting point
  // for the measurement below.
  const ruler = page.getByTestId('motion-rail-ruler')
  await ruler.dblclick()

  // THE PREMISE, measured. On a rail fitted to a 20 second clip, 5 frames is a
  // couple of pixels, so the two diamonds do not merely sit close: their boxes
  // OVERLAP, and there is no rail between them to click at all. Everything below
  // is what the zoom is for.
  expect(await railGapPx(page)).toBeLessThan(0)

  // So he scrolls the ruler, with the pointer on the punch. zoomAt holds the time
  // under the cursor still, so the move opens up around itself rather than
  // sliding off the edge.
  for (let i = 0; i < 40 && (await railGapPx(page)) < GRABBABLE_PX; i++) {
    await ruler.hover({ position: { x: await punchXInRuler(page), y: 10 } })
    await page.mouse.wheel(0, -120)
  }
  expect(await railGapPx(page)).toBeGreaterThanOrEqual(GRABBABLE_PX)
  // Both diamonds are still on the rail: zooming toward the punch kept it in view.
  await expect(diamonds).toHaveCount(2)

  // Now click the middle of that rail. Not a diamond - the SEGMENT between two,
  // which is the gesture the whole design turns on. Hover first, then read the
  // boxes: hover runs the actionability and hit-target checks raw page.mouse.*
  // skips, and it can scroll the lane, which would stale a midpoint measured
  // before it.
  await diamonds.first().hover()
  const a = await diamonds.nth(0).boundingBox()
  const b = await diamonds.nth(1).boundingBox()
  if (!a || !b) throw new Error('no geometry')
  await page.mouse.click((a.x + a.width + b.x) / 2, a.y + a.height / 2)

  // The move he clicked, highlighted the length it actually runs, and a curve
  // editor headed with its real numbers.
  await expect(lane.getByTestId('keyframe-segment')).toBeVisible()
  await expect(page.getByTestId('curve-editor')).toBeVisible()
  await expect(page.getByTestId('curve-editor-header')).toHaveText('Zoom 100 to 120 over 5f')

  // The punch wrote the Snap curve, and the chip claiming to be Snap agrees with
  // it: one MOTION_CURVES table, read by the preset builder and the editor alike.
  await expect(page.getByTestId('curve-chip-snapIn')).toHaveAttribute('aria-pressed', 'true')

  // Then shape it into something else and back, because a chip that only ever
  // agreed with what was already stored would prove nothing. Overshoot travels
  // past the target on purpose, which is why y is left unclamped.
  await page.getByTestId('curve-chip-overshoot').click()
  await expect.poll(async () => (await scaleKeys(page))[0].curve).toEqual([0.34, 1.56, 0.64, 1])
  await page.getByTestId('curve-chip-snapIn').click()
  await expect.poll(async () => (await scaleKeys(page))[0].curve).toEqual([0.16, 1, 0.3, 1])

  // Shaping the segment retimed nothing and added nothing: same two diamonds,
  // same numbers, same header.
  const keys = await scaleKeys(page)
  expect(keys).toHaveLength(2)
  expect(keys[0].value).toBeCloseTo(1, 6)
  expect(keys[1].value).toBeCloseTo(DEPTH, 6)
  expect(keys[1].t - keys[0].t).toBeCloseTo(RISE_S, 6)
  await expect(page.getByTestId('curve-editor-header')).toHaveText('Zoom 100 to 120 over 5f')
})

test('punch out at an arbitrary moment mid clip falls to base size and HOLDS there', async ({ page }) => {
  await addTwentySecondClip(page)
  await selectTheClip(page)
  await openHandControls(page)

  // Punch in four seconds in, on the key.
  await setUI(page, { playheadS: 4 })
  await page.keyboard.press('p')
  await expect.poll(async () => (await scaleKeys(page)).length).toBe(2)

  // Then out again at 11.4s: not a round number, not a beat, not the end of the
  // clip. "Punch out at any time in the clip" is the verb, and Shift+P is the key
  // he named for it.
  await setUI(page, { playheadS: 11.4 })
  await page.keyboard.press('Shift+P')
  await expect.poll(async () => (await scaleKeys(page)).length).toBe(4)

  const keys = await scaleKeys(page)
  expect(keys[2].t).toBeCloseTo(11.4, 6)
  const landing = keys[3].t
  expect(landing - keys[2].t).toBeCloseTo(RISE_S, 6)
  // The fall leaves on the same snap curve the rise arrived on.
  expect(keys[2].curve).toEqual([0.16, 1, 0.3, 1])

  // What the app itself resolves, across the whole clip. The tail is the point:
  // it lands on base and STAYS on base to the last frame, rather than sliding
  // anywhere on its own the way the old four knot envelope did.
  const probe = await resolvedScale(page, [4, 4 + RISE_S, 8, 11.4, landing, landing + 0.5, 15, 19.9])
  expect(probe.base).toBeCloseTo(1, 6)
  expect(probe.at[0]).toBeCloseTo(1, 6) // the punch has not started
  expect(probe.at[1]).toBeCloseTo(DEPTH, 6) // arrived
  expect(probe.at[2]).toBeCloseTo(DEPTH, 6) // holding, four seconds later
  expect(probe.at[3]).toBeCloseTo(DEPTH, 6) // still holding where the fall starts
  expect(probe.at[4]).toBeCloseTo(probe.base, 6) // landed exactly on the clip's own base
  expect(probe.at[5]).toBeCloseTo(probe.base, 6)
  expect(probe.at[6]).toBeCloseTo(probe.base, 6)
  expect(probe.at[7]).toBeCloseTo(probe.base, 6) // and holds to the tail of the clip

  // The landing keyframe IS base, not a value that happens to resolve near it:
  // anything else drifts a little further from the clip's defined framing on
  // every punch in and out, and the drift only shows up on export.
  expect(keys[3].value).toBeCloseTo(probe.base, 9)
})

/** The split halves of the linked pair, with the Zoom facts of each video half. */
async function splitHalves(page: Page): Promise<{
  video: { id: string; startS: number; animated: boolean; base: number; at: number[] }[]
  audio: { id: string; startS: number }[]
}> {
  return page.evaluate(async () => {
    type Clip = { id: string; startS: number; inS: number; outS: number; speed: number }
    type Track = { kind: string; clips: Clip[] }
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const chMod = '/src/engine/effects/channels.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: Track[] }
    }
    const { channelBase, isChannelAnimated, resolveChannel } = (await import(/* @vite-ignore */ chMod)) as {
      channelBase: (clip: unknown, ch: string) => number
      isChannelAnimated: (clip: unknown, ch: string) => boolean
      resolveChannel: (clip: unknown, ch: string, localT: number) => number
    }
    const seq = activeSequence(useStore.getState().project)
    const of = (kind: string): Clip[] =>
      seq.tracks
        .filter((t) => t.kind === kind)
        .flatMap((t) => t.clips)
        .sort((x, y) => x.startS - y.startS)
    return {
      video: of('video').map((c) => {
        const durS = (c.outS - c.inS) / (Math.abs(c.speed) || 1)
        return {
          id: c.id,
          startS: c.startS,
          animated: isChannelAnimated(c, 'scale'),
          base: channelBase(c, 'scale'),
          // First frame, middle, last frame: "starts bigger" has to mean the
          // whole half, not just the instant after the cut.
          at: [0, durS / 2, Math.max(0, durS - 1 / 30)].map((t) => resolveChannel(c, 'scale', t)),
        }
      }),
      audio: of('audio').map((c) => ({ id: c.id, startS: c.startS })),
    }
  })
}

test('cut punch splits the clip with its linked audio, and the right half simply starts bigger', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  // A video WITH audio drops as a linked pair: video on V1, audio on A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)

  await page.locator('[data-clip-kind="video"]').click({ position: { x: 20, y: 10 } })
  await openHandControls(page)
  const before = await splitHalves(page)
  expect(before.video).toHaveLength(1)
  expect(before.video[0].animated).toBe(false)
  expect(before.video[0].base).toBeCloseTo(1, 6)

  // Park mid clip, measured off the clip itself rather than assumed: the fixture
  // is recorded live, so its exact length wobbles between machines.
  const cutAt = await page.evaluate(async () => {
    type Clip = { inS: number; outS: number; speed: number; startS: number }
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: Clip[] }[] }
    }
    const c = activeSequence(useStore.getState().project).tracks.find((t) => t.kind === 'video')!.clips[0]
    return c.startS + (c.outS - c.inS) / (Math.abs(c.speed) || 1) / 2
  })
  await setUI(page, { playheadS: cutAt })

  await page.getByTestId('cut-punch').click()

  // The picture splits, and the sound splits WITH it. Cutting the video alone is
  // what desyncs a linked pair at every punch he fires this way.
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(2)

  const after = await splitHalves(page)
  expect(after.video[1].startS).toBeCloseTo(cutAt, 1)
  // At the SAME frame, exactly. A pair that splits a frame apart is a desync.
  expect(after.audio.map((c) => c.startS)).toEqual(after.video.map((c) => c.startS))

  // No animation at all, zero frames: the right half carries no Zoom keyframes,
  // its static base IS the punch depth, and it resolves to that one number from
  // its first frame to its last. This is the hard cut version, which is what most
  // YouTube punch-ins actually are, and there is no curve to shape afterwards.
  expect(after.video[1].animated).toBe(false)
  expect(after.video[1].base).toBeCloseTo(DEPTH, 6)
  for (const v of after.video[1].at) expect(v).toBeCloseTo(DEPTH, 6)

  // And the left half is exactly as it was.
  expect(after.video[0].animated).toBe(false)
  expect(after.video[0].base).toBeCloseTo(1, 6)
  for (const v of after.video[0].at) expect(v).toBeCloseTo(1, 6)
})
