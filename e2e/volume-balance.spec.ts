// "some clips I'm screaming and some clips I'm speaking softly, and the volume
// just isn't balanced. The part when I scream is still very, very loud."
//
// The old Normalize matched PEAKS, which is why it never helped: a shout and a
// quiet sentence can share a peak and sound nothing alike. This drives the real
// action end to end and checks the two clips come out AGREEING, which is the
// only claim worth testing.

import { expect, test } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

interface ClipShape {
  id: string
  audioGainDb: number
  inS: number
  outS: number
  startS: number
}
interface TrackShape {
  id: string
  kind: string
  clips: ClipShape[]
}
interface SeqShape {
  tracks: TrackShape[]
}

test('balancing makes a loud clip and a quiet clip agree', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await page.getByTestId('asset-card').waitFor()
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)

  // Two audio clips from the same source at wildly different gains: "one take
  // where I shouted and one where I did not".
  await page.evaluate(async () => {
    const spec = '/src/state/store.ts'
    const store = (await import(/* @vite-ignore */ spec)) as {
      updateActiveSequence: (label: string, fn: (sq: SeqShape) => SeqShape) => void
    }
    store.updateActiveSequence('two takes', (sq) => {
      const audio = sq.tracks.find((t) => t.kind === 'audio' && t.clips.length > 0)
      if (!audio) return sq
      const src = audio.clips[0]
      const len = src.outS - src.inS
      return {
        ...sq,
        tracks: sq.tracks.map((t) =>
          t.id !== audio.id
            ? t
            : {
                ...t,
                clips: [
                  { ...src, id: 'loud', startS: 0, audioGainDb: 12 },
                  { ...src, id: 'quiet', startS: len + 0.5, audioGainDb: -18 },
                ],
              },
        ),
      }
    })
  })

  const read = (): Promise<ClipShape[]> =>
    page.evaluate(async () => {
      const storeSpec = '/src/state/store.ts'
      const typesSpec = '/src/engine/types.ts'
      const store = (await import(/* @vite-ignore */ storeSpec)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const types = (await import(/* @vite-ignore */ typesSpec)) as {
        activeSequence: (p: unknown) => SeqShape
      }
      return types.activeSequence(store.useStore.getState().project).tracks.flatMap((t) => t.clips)
    })

  const before = await read()
  expect(before.find((c) => c.id === 'loud')?.audioGainDb).toBe(12)
  expect(before.find((c) => c.id === 'quiet')?.audioGainDb).toBe(-18)

  await page.evaluate(async () => {
    const spec = '/src/state/audioActions.ts'
    const actions = (await import(/* @vite-ignore */ spec)) as {
      balanceAllClipLoudness: () => Promise<void>
    }
    await actions.balanceAllClipLoudness()
  })

  const after = await read()
  const loud = after.find((c) => c.id === 'loud')?.audioGainDb
  const quiet = after.find((c) => c.id === 'quiet')?.audioGainDb
  expect(loud).toBeDefined()
  expect(quiet).toBeDefined()
  // Both clips carry the SAME audio, so after levelling they must be asked for
  // the same gain. Peak normalisation could not promise this; that is the point.
  expect(Math.abs(loud! - quiet!)).toBeLessThan(1)
  // And it really moved them.
  expect(loud).not.toBe(12)
  expect(quiet).not.toBe(-18)
})
