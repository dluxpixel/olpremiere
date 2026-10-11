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

type Stats = {
  assets: number
  openDecoders: number
  decoderCap: number
  pumping: number
  queued: number
  decodingNow: number
}

const stats = async (page: import('@playwright/test').Page): Promise<Stats> =>
  page.evaluate(async () => {
    const mod = '/src/engine/frameCache.ts'
    const { frameCacheStats } = (await import(/* @vite-ignore */ mod)) as {
      frameCacheStats: () => Stats
    }
    return frameCacheStats()
  })

/** What the in-page sampler saw: the highest open count, and every sample that broke the bound. */
type Watched = {
  samples: number
  peakOpen: number
  /** Samples where more decoders were open than the cap, beyond the pumps in flight and the one that just ended. */
  breaches: number
  worst: { open: number; pumping: number; cap: number } | null
}

/**
 * ⛔ SAMPLE THE WHOLE WALK, NOT ONLY THE END OF IT (2026-10-08). The idle read below
 * cannot tell whether the reap at OPEN (frameCache.ts, openInput) is still there: the
 * reap at the end of a pump brings an idle cache under the cap by itself, so deleting
 * the open-time one stayed green. What only the open-time reap holds is the count WHILE
 * clips are being asked for, and that is the number that tips Chromium into software
 * decode. So a sampler runs in the page for the whole walk, as fast as a timer allows,
 * and keeps the peak and every sample that broke the bound.
 *
 * THE BOUND IS max(cap, pumping + 1), NOT cap + a guess. reapDecoders never takes a
 * decoder whose pump is running, and a pump that has just ended is the one it keeps
 * (the most recently used), so the cap can be passed by exactly the pumps in flight
 * plus that one, and by nothing else. Every open decoder beyond that is one nobody is
 * using. A fixed headroom (the old cap + 4) is a number that depends on timing and
 * sits on its own bound.
 */
const startWatch = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.evaluate(async () => {
    const mod = '/src/engine/frameCache.ts'
    const { frameCacheStats } = (await import(/* @vite-ignore */ mod)) as { frameCacheStats: () => Stats }
    const w = window as unknown as { __decoderWatch?: Watched & { stop: boolean } }
    const watch: Watched & { stop: boolean } = { samples: 0, peakOpen: 0, breaches: 0, worst: null, stop: false }
    w.__decoderWatch = watch
    let worstOver = 0
    const sample = (): void => {
      const s = frameCacheStats() as unknown as Stats
      watch.samples += 1
      if (s.openDecoders > watch.peakOpen) watch.peakOpen = s.openDecoders
      const over = s.openDecoders - Math.max(s.decoderCap, s.pumping + 1)
      if (over > 0) {
        watch.breaches += 1
        if (over > worstOver) {
          worstOver = over
          watch.worst = { open: s.openDecoders, pumping: s.pumping, cap: s.decoderCap }
        }
      }
    }
    const loop = (): void => {
      if (watch.stop) return
      sample()
      setTimeout(loop, 0)
    }
    loop()
  })
}

const stopWatch = async (page: import('@playwright/test').Page): Promise<Watched> =>
  page.evaluate(() => {
    const w = window as unknown as { __decoderWatch?: Watched & { stop: boolean } }
    const watch = w.__decoderWatch
    if (!watch) throw new Error('decoder-cap: the sampler was never started')
    watch.stop = true
    return { samples: watch.samples, peakOpen: watch.peakOpen, breaches: watch.breaches, worst: watch.worst }
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
  // so every asset is asked for a frame at least once. The sampler runs from here to
  // the end of the walk (see startWatch).
  await startWatch(page)
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

  // ⛔ READ IT IDLE, AND THEN WITH NO HEADROOM (2026-10-06). The cap may be
  // exceeded BRIEFLY: an entry mid-decode is never taken, because closing it would
  // strand the pump on a disposed input. So this used to read whenever it read and
  // allow cap + 4, and the logs show 10, 11 and exactly 12 (cap + 4): a number
  // that depended on when the sample landed, sitting on its own bound. Once
  // nothing is pumping, queued or decoding, every extra decoder is one nobody is
  // using, so the idle count must be within the cap itself. The first idle read
  // was 12 against 8: the frame cache reaped only when a decoder opened, never
  // when a pump ended, and it reaps at both now (frameCache.ts, pump).
  await expect
    .poll(
      async () => {
        const now = await stats(page)
        return now.pumping + now.queued + now.decodingNow
      },
      { timeout: 20_000, message: 'the frame cache never went idle after the walk' },
    )
    .toBe(0)

  const watched = await stopWatch(page)
  const s = await stats(page)
  console.log(
    `[decoders] walk: samples=${watched.samples} peak=${watched.peakOpen} breaches=${watched.breaches}` +
      `${watched.worst ? ` worst=${JSON.stringify(watched.worst)}` : ''}`,
  )
  console.log(`[decoders] idle: assets=${s.assets} open=${s.openDecoders} cap=${s.decoderCap}`)
  // The sampler must have been alive for the walk, or a quiet result proves nothing.
  expect(watched.samples, 'the in-page sampler never ran').toBeGreaterThan(50)
  // Soft, so a red here still lets the one-at-a-time walk below report its own reading.
  expect.soft(
    watched.breaches,
    `decoders open beyond the cap and the pumps using them while clips were being asked for (${JSON.stringify(watched.worst)}): the reap at open (frameCache.ts, openInput) is gone or no longer holds`,
  ).toBe(0)
  expect(s.openDecoders, 'decoders still open once nothing is decoding').toBeLessThanOrEqual(s.decoderCap)
  // And the point of the whole thing: it must not scale with the project.
  expect(s.openDecoders).toBeLessThan(s.assets)

  // ⛔ THEN ONE CLIP AT A TIME (2026-10-08), BECAUSE THE WALK ABOVE CANNOT SEE THE REAP AT
  // OPEN RELIABLY. It asks for a dozen clips at once, and while a pump is running its
  // decoder is exempt, so the bound there is loose and a sampler only sometimes lands in
  // the window the open-time reap closes (deleting it stayed green, then red, then green).
  // Here the cache is emptied (every decoder closed, every frame dropped), then each clip
  // is asked for ALONE and the cache is let go idle before the next. From the ninth clip
  // on there are eight idle decoders open when the next one opens, and ONLY the reap at
  // open can close one of them in time: without it the count reads cap + 1 for the whole
  // of that clip's decode. That is a window of tens of milliseconds, in each of a dozen
  // clips, against a sampler that looks every few. One pump in flight means no headroom
  // at all: the peak must be the cap itself.
  //
  // It asks the frame cache itself (getFrameAt, the contract the preview is built on)
  // and not the playhead: the preview paints some stops from elsewhere and never asks
  // the cache, and a step the cache is never asked for opens nothing and proves nothing.
  const order = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const cacheMod = '/src/engine/frameCache.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { assetId: string; startS: number; inS: number; outS: number }[] }[]
      }
    }
    const { evictAsset } = (await import(/* @vite-ignore */ cacheMod)) as { evictAsset: (id: string) => void }
    const clips = activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
      .sort((a, b) => a.startS - b.startS)
    for (const c of clips) evictAsset(c.assetId)
    return clips.map((c) => ({ assetId: c.assetId, atS: c.inS + (c.outS - c.inS) / 2 }))
  })
  expect(order.length, 'fewer clips on the timeline than the cap: the one-at-a-time walk proves nothing').toBeGreaterThan(
    s.decoderCap,
  )
  const idle = async (): Promise<number> => {
    const now = await stats(page)
    return now.pumping + now.queued + now.decodingNow
  }
  /** Asks the frame cache for one frame of one asset. True once that frame is in the cache. */
  const ask = (c: { assetId: string; atS: number }): Promise<boolean> =>
    page.evaluate(async ({ assetId, atS }) => {
      const storeMod = '/src/state/store.ts'
      const cacheMod = '/src/engine/frameCache.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: { assets: Record<string, unknown> } } }
      }
      const { getFrameAt } = (await import(/* @vite-ignore */ cacheMod)) as {
        getFrameAt: (asset: unknown, tS: number) => unknown
      }
      return getFrameAt(useStore.getState().project.assets[assetId], atS) !== null
    }, c)
  // Whatever the preview asked for the moment the cache was emptied finishes first.
  await expect.poll(idle, { timeout: 20_000, message: 'the frame cache never went idle after it was emptied' }).toBe(0)

  await startWatch(page)
  for (const [i, c] of order.entries()) {
    // The frame arrives (the decode ran), and then nothing is left running.
    await expect.poll(() => ask(c), { timeout: 20_000, message: `clip ${i}: its frame never arrived` }).toBe(true)
    await expect.poll(idle, { timeout: 20_000, message: `clip ${i}: the frame cache never went idle` }).toBe(0)
  }
  const alone = await stopWatch(page)
  console.log(
    `[decoders] one at a time: samples=${alone.samples} peak=${alone.peakOpen} breaches=${alone.breaches}` +
      `${alone.worst ? ` worst=${JSON.stringify(alone.worst)}` : ''}`,
  )
  expect(alone.samples, 'the in-page sampler never ran').toBeGreaterThan(50)
  expect(
    alone.peakOpen,
    `decoders open at once while clips were asked for one at a time (${JSON.stringify(alone.worst)}): the reap at open (frameCache.ts, openInput) is gone or no longer holds`,
  ).toBeLessThanOrEqual(s.decoderCap)
  expect(alone.breaches).toBe(0)
})
