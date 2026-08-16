// His complaint, still marked "not reproduced" on the open list:
// **"The edit is broken when there are a lot of clips and cuts."**
//
// MEASUREMENT, not a fix. Nobody has ever put a number on it, so this puts one
// there: how the cost of ONE drag across the ruler grows as the timeline fills
// up. Every interaction writes the playhead and re-renders a timeline holding
// every clip, so if anything in that path is quadratic it shows here and nowhere
// in the ordinary suite, which never lays more than a handful of clips.
//
// ⛔ THE BURST IS DISPATCHED FROM INSIDE THE PAGE, in one synchronous loop. That
// detail is the whole test and it is the scar from the scrub work: `page.mouse.move`
// is a round trip slow enough that a frame runs between every event, so the
// timing measures Playwright rather than the app.
//
// ⛔ IT ASSERTS A RATIO, NEVER A MILLISECOND. Absolute times on his machine
// depend on what else is running, and this repo has already been bitten by a
// guard that was red in the gate and green alone. Both halves are timed in the
// same run on the same machine, seconds apart, which is the only way the
// comparison means anything.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const MOVES = 60

interface Row {
  clips: number
  ms: number
  drawn: number
}

/** Lay `wanted` copies of the imported video clip end to end, and report the real count. */
async function fill(page: Page, wanted: number): Promise<number> {
  return page.evaluate(async (wanted: number) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { activeSequence, newId } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => Seq
      newId: () => string
    }
    interface Clip {
      id: string
      startS: number
      inS: number
      outS: number
      speed: number
    }
    interface Seq {
      tracks: { kind: string; clips: Clip[] }[]
    }
    const videoClips = (s: Seq): Clip[] => s.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips)
    const len = (c: Clip): number => (c.outS - c.inS) / Math.max(Math.abs(c.speed) || 1, 1e-6)

    const first = videoClips(activeSequence(useStore.getState().project))[0]
    // ⛔ SHORT SLICES, NOT FULL COPIES, AND THIS IS THE WHOLE MEASUREMENT.
    // Laid end to end at full length, 800 clips make a timeline so long that the
    // view holds about three of them and the cost reads dead flat at every size,
    // which measures the scroll window rather than the number of clips. His
    // sentence is "a lot of clips AND CUTS", so they have to be cuts: short
    // enough that the run he is looking at really does hold all of them.
    const slice = Math.min(len(first), 0.2)
    updateActiveSequence('lay copies', (s) => {
      const seq = s as Seq
      return {
        ...seq,
        tracks: seq.tracks.map((t) =>
          t.kind !== 'video'
            ? t
            : {
                ...t,
                clips: Array.from({ length: wanted }, (_, i) => ({
                  ...first,
                  id: newId(),
                  inS: first.inS,
                  outS: first.inS + slice,
                  startS: i * slice,
                })),
              },
        ),
      }
    })
    return videoClips(activeSequence(useStore.getState().project)).length
  }, wanted)
}

/** One drag of `MOVES` pointer moves across the ruler, timed inside the page. */
async function dragCost(page: Page): Promise<number> {
  const ruler = page.getByTestId('ruler')
  const box = (await ruler.boundingBox())!
  const y = box.y + 8
  await page.mouse.move(box.x + 20, y)
  await page.mouse.down()
  const ms = await page.evaluate(
    async ({ startX, y, moves }) => {
      const el = document.querySelector('[data-testid="ruler"]')!
      const t0 = performance.now()
      for (let i = 1; i <= moves; i++) {
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            pointerType: 'mouse',
            bubbles: true,
            clientX: startX + i * 4,
            clientY: y,
          }),
        )
      }
      // The renders the burst asked for have to actually run before the clock
      // stops, or this times the dispatch loop and nothing the user would feel.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return performance.now() - t0
    },
    { startX: box.x + 20, y, moves: MOVES },
  )
  await page.mouse.up()
  return ms
}

/**
 * The other half of his sentence, and the half the drag test does not touch.
 *
 * The drag path is interaction cost. This is what the PICTURE does while it
 * plays across a lot of cuts, which is the older note's number: 19 fps rising to
 * 26 on 16 short cuts. It reads the app's own instrument rather than a counter
 * invented here: `previewHealth` records what was really put on screen, and
 * `wrongRatio` is the share of drawn frames that were not the frame asked for.
 */
async function playHealth(page: Page, forMs: number): Promise<{ served: number; perS: number; wrongPct: number; p95: number }> {
  await page.evaluate(async () => {
    const mod = '/src/engine/previewTruth.ts'
    const { resetPreviewHealth } = (await import(/* @vite-ignore */ mod)) as { resetPreviewHealth: () => void }
    resetPreviewHealth()
  })
  await page.keyboard.press(' ')
  await page.waitForTimeout(forMs)
  await page.keyboard.press(' ')
  return page.evaluate(async (forMs: number) => {
    const mod = '/src/engine/previewTruth.ts'
    const { previewHealth } = (await import(/* @vite-ignore */ mod)) as {
      previewHealth: (withinMs?: number) => { count: number; spanS: number; wrongRatio: number; p95ErrMs: number }
    }
    const h = previewHealth(forMs + 1000)
    return {
      served: h.count,
      perS: h.spanS > 0 ? +(h.count / h.spanS).toFixed(1) : 0,
      wrongPct: +(h.wrongRatio * 100).toFixed(1),
      p95: Math.round(h.p95ErrMs),
    }
  }, forMs)
}

test('a drag does not get dramatically dearer as the timeline fills up', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]').first()).toBeVisible()

  const rows: Row[] = []
  for (const wanted of [10, 50, 100, 200, 400]) {
    const clips = await fill(page, wanted)
    // One unmeasured drag first, so the first row is not paying for whatever the
    // resize of the timeline just asked for.
    await dragCost(page)
    const ms = await dragCost(page)
    // ⛔ HOW MANY ARE REALLY ON SCREEN. A flat cost means nothing if the timeline
    // only ever draws what fits: that would be a measurement of the viewport
    // rather than of the clip count, and it would read exactly the same.
    const drawn = await page.locator('[data-clip-kind="video"]').count()
    rows.push({ clips, ms: Math.round(ms * 10) / 10, drawn })
  }

  const table = rows.map((r) => `${String(r.clips).padStart(4)} clips, ${String(r.drawn).padStart(4)} drawn: ${r.ms} ms`).join('\n')
  console.log(`\ncost of one ${MOVES} move drag as the timeline fills:\n${table}\n`)

  const small = rows.find((r) => r.clips >= 50)!
  const large = rows[rows.length - 1]
  const clipRatio = large.clips / small.clips
  const costRatio = large.ms / Math.max(small.ms, 0.1)

  // ⛔ LINEAR IS ALLOWED, QUADRATIC IS NOT. Eight times the clips may cost eight
  // times as much and still be honest work. What his sentence describes is the
  // curve bending, so the guard is one full factor of headroom over linear and
  // fires only on a real bend.
  expect(
    costRatio,
    `${small.clips} clips cost ${small.ms} ms and ${large.clips} cost ${large.ms} ms, ` +
      `which is ${costRatio.toFixed(1)}x the cost for ${clipRatio}x the clips\n${table}`,
  ).toBeLessThan(clipRatio * 2)
})

test('the picture keeps up while it plays across a lot of cuts', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]').first()).toBeVisible()

  const rows: string[] = []
  const perS: { clips: number; perS: number; wrongPct: number }[] = []
  for (const wanted of [10, 100, 400]) {
    const clips = await fill(page, wanted)
    await page.locator('[data-clip-kind="video"]').first().click()
    await page.keyboard.press('Home')
    const h = await playHealth(page, 2500)
    rows.push(`${String(clips).padStart(4)} cuts: ${h.perS}/s served, ${h.wrongPct}% were the wrong frame, p95 error ${h.p95} ms`)
    perS.push({ clips, perS: h.perS, wrongPct: h.wrongPct })
  }
  const table = rows.join('\n')
  console.log(`\nwhat the picture did while playing:\n${table}\n`)

  // ⛔ MEASUREMENT FIRST. The only thing asserted is that playback did not stop
  // dead and did not start serving mostly wrong frames, because those are the
  // two shapes his sentence could mean. A frame rate threshold would be a guess
  // about his machine rather than a fact about the app.
  const worst = perS.reduce((a, b) => (a.perS < b.perS ? a : b))
  expect(worst.perS, `playback served almost nothing at ${worst.clips} cuts\n${table}`).toBeGreaterThan(1)
  const wrongest = perS.reduce((a, b) => (a.wrongPct > b.wrongPct ? a : b))
  expect(wrongest.wrongPct, `most drawn frames were the wrong ones at ${wrongest.clips} cuts\n${table}`).toBeLessThan(90)
})
