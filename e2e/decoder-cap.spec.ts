// ⛔ THE PREVIEW MAY NOT HOLD A HARDWARE DECODER OPEN PER ASSET.
//
// Every `AssetEntry` in `engine/frameCache.ts` owns a mediabunny `Input` plus a
// `CanvasSink`, and a CanvasSink owns a hardware VideoDecoder. Until 2026-08-28
// nothing closed them, so scrubbing across a timeline opened one per asset
// touched and kept it for the session.
//
// ⚠️ THE REASON THIS IS AN E2E AND NOT A UNIT TEST is the failure it guards
// against: past the platform's concurrent-decoder limit Chromium falls back to
// SOFTWARE decode. That is not an error, nothing throws, nothing logs. The app
// simply gets slower for the rest of the session and only a restart clears it.
// A real browser is the only place the decoders are real.
//
// The export path has had this ceiling since it was written
// (`export/providerPool.ts`, DEFAULT_MAX_LIVE_PROVIDERS = 8, with a docblock
// predicting exactly this). The preview never got it.

import { expect, test } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

type Stats = { assets: number; openDecoders: number; decoderCap: number }

const stats = async (page: import('@playwright/test').Page): Promise<Stats> =>
  page.evaluate(async () => {
    const mod = '/src/engine/frameCache.ts'
    const { frameCacheStats } = (await import(/* @vite-ignore */ mod)) as {
      frameCacheStats: () => Stats
    }
    return frameCacheStats()
  })

test('scrubbing across many clips never leaves more decoders open than the cap', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // Twenty clips of the same source. One asset would prove nothing: the ceiling
  // is per OPEN DECODER, and the app opens one per ASSET, so the test needs more
  // assets than the cap. Importing the same file twenty times gives twenty
  // distinct assets, which is exactly the shape of his own project.
  for (let i = 0; i < 20; i++) {
    await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  }
  await expect.poll(async () => (await page.getByTestId('asset-card').count()) >= 12, { timeout: 30_000 }).toBe(true)

  // Drop them all on the timeline, then walk the playhead across the whole thing
  // so every asset is asked for a frame at least once.
  const cards = page.getByTestId('asset-card')
  const n = Math.min(await cards.count(), 20)
  for (let i = 0; i < n; i++) await cards.nth(i).dblclick()

  // ⚠️ THE STORE, NOT THE RULER. Twenty-one locator clicks on a ruler that is
  // being repainted under them is a minute of flake for no extra coverage; what
  // this test needs is only that the playhead VISITS every clip, which is one
  // store write per stop.
  const seqEnd = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { durationS: number }
    }
    return activeSequence(useStore.getState().project).durationS
  })
  for (let step = 0; step <= 24; step++) {
    const t = (seqEnd * step) / 24
    await page.evaluate(async (at) => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { setUI: (p: unknown) => void } }
      }
      useStore.getState().setUI({ playheadS: at })
    }, t)
  }
  // Give the pumps a moment to open whatever they are going to open.
  await expect
    .poll(async () => (await stats(page)).assets, { timeout: 15_000 })
    .toBeGreaterThan(1)

  const s = await stats(page)
  console.log(`[decoders] assets=${s.assets} open=${s.openDecoders} cap=${s.decoderCap}`)

  // The cap may be exceeded BRIEFLY: an entry mid-decode is never taken, because
  // closing it would strand the pump on a disposed input. So the assertion has
  // the same shape as the export pool's: bounded, with headroom for the frame
  // genuinely being decoded, and nowhere near one-per-asset.
  expect(s.openDecoders).toBeLessThanOrEqual(s.decoderCap + 4)
  // And the point of the whole thing: it must not scale with the project.
  expect(s.openDecoders).toBeLessThan(s.assets)
})
