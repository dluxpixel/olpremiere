import { expect, test, type Page } from '@playwright/test'

// MEASUREMENT, not a fix. Finding 13 says pressing play builds one
// AudioBufferSourceNode plus one GainNode for EVERY audible clip in the whole
// sequence, with nothing bounding it. The code plainly does that. What is NOT
// known is whether it COSTS anything, and finding 7 on the same list turned out
// to be a measured non issue, so this runs before anything is built.
//
// It reports two numbers per timeline size: how many audio nodes play creates,
// and how long the call takes in a real browser.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __nodes?: number }
    w.__nodes = 0
    const proto = window.AudioContext.prototype
    for (const name of ['createBufferSource', 'createGain'] as const) {
      const real = proto[name]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proto as any)[name] = function (this: AudioContext) {
        w.__nodes = (w.__nodes ?? 0) + 1
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (real as any).call(this)
      }
    }
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'

/**
 * Lay `wanted` copies of the imported clip end to end, then time ONE play from
 * zero and count the audio nodes it builds.
 *
 * Copies, not razor cuts. The first attempt at this cut one 4 second clip into
 * 400, and the razor correctly refused everything under a frame, so the row said
 * 400 clips while the timeline held about 51. It reports the REAL count now.
 */
async function measure(page: Page, wanted: number): Promise<{ clips: number; nodes: number; ms: number }> {
  return page.evaluate(async (wanted: number) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const audioMod = '/src/engine/audio.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { activeSequence, newId } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => Seq
      newId: () => string
    }
    const { scheduleAudio } = (await import(/* @vite-ignore */ audioMod)) as {
      scheduleAudio: (s: unknown, a: unknown, fromS: number) => Promise<() => void>
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
    const audioClips = (s: Seq): Clip[] => s.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips)
    const len = (c: Clip): number => (c.outS - c.inS) / Math.max(Math.abs(c.speed) || 1, 1e-6)

    const first = audioClips(activeSequence(useStore.getState().project))[0]
    const each = len(first)
    updateActiveSequence('lay copies', (s) => {
      const seq = s as Seq
      return {
        ...seq,
        tracks: seq.tracks.map((t) =>
          t.kind !== 'audio'
            ? t
            : {
                ...t,
                clips: Array.from({ length: wanted }, (_, i) => ({
                  ...first,
                  id: newId(),
                  startS: i * each,
                  // Unlinked, so every copy emits its own audio the way a real
                  // audio track of separate takes would.
                  linkId: undefined,
                })),
              },
        ),
      }
    })

    const w = window as unknown as { __nodes: number }
    w.__nodes = 0
    const state = useStore.getState() as { project: { assets: unknown } }
    const seq = activeSequence(state.project)
    const clips = audioClips(seq).length
    const t0 = performance.now()
    const stop = await scheduleAudio(seq, state.project.assets, 0)
    const ms = performance.now() - t0
    stop()
    return { clips, nodes: w.__nodes, ms }
  }, wanted)
}

// MEASURED 2026-08-05, real Chromium, on the numbers this spec printed:
//
//   clips |  audio nodes | scheduleAudio
//     100 |          203 |  22.0ms
//     400 |          803 |  40.0ms
//    1600 |         3203 | 119.3ms
//
// Exactly two nodes per clip and nothing bounds it, so finding 13 is TRUE. But
// the marginal cost is about 0.065ms per clip, so a real short-form timeline of
// 100 to 400 clips pays 22 to 40ms to press play. **That does not justify
// rebuilding the audio scheduler**, which is the most timing sensitive code in
// the app and where a mistake means his audio drifts. Same outcome as finding 7.
//
// So this stopped being a measurement and became a GUARD: play latency is now
// pinned at a size bigger than he works at, and the node count is pinned to the
// shape the decision was based on. If either moves, the decision gets revisited
// with numbers rather than rediscovered by feel.
test('pressing play stays cheap on a timeline far bigger than a real edit', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  const { clips, nodes, ms } = await measure(page, 200)
  console.log(`clips=${clips}  audio nodes=${nodes}  scheduleAudio=${ms.toFixed(1)}ms`)

  // The shape the decision rests on: one source + one gain per clip, plus the
  // handful of per-track nodes. A change here means the scheduler was rewritten.
  expect(nodes).toBeGreaterThanOrEqual(clips * 2)
  expect(nodes).toBeLessThan(clips * 2 + 40)

  // 400 clips measured 40ms. 250 leaves room for a slow or loaded machine while
  // still going red long before he would feel a lag on pressing space.
  expect(ms).toBeLessThan(250)
})
