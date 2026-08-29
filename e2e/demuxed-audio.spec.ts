// ⛔ THE DEMUXED READ HAS TO BE PROVEN IN A REAL BROWSER, because the only tests
// guarding it otherwise are source-order ones, and those cannot tell a working
// decode from a buffer full of zeros.
//
// His two biggest recordings had NO SOUND for days and nothing said so: the old
// path did `blob.arrayBuffer()` on the whole container, which throws past
// 2,147,483,647 bytes, and the throw was swallowed into a `return null`. A
// silent buffer is exactly what that failure looks like from the outside, so
// this test refuses to accept one.

import { expect, test } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

test('the audio comes back demuxed, at the right rate, and is not silent', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  const got = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const audioMod = '/src/engine/audio.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { assets: Record<string, unknown> } } }
    }
    const { getAudioBuffer } = (await import(/* @vite-ignore */ audioMod)) as {
      getAudioBuffer: (a: unknown) => Promise<AudioBuffer | null>
    }
    const asset = Object.values(useStore.getState().project.assets)[0] as {
      durationS: number
      hasAudio: boolean
    }
    const buf = await getAudioBuffer(asset)
    if (!buf) return { ok: false as const, hasAudio: asset.hasAudio }
    // Peak across the first ten seconds of every channel. A decode that "worked"
    // and produced zeros is the failure this whole change exists to end.
    let peak = 0
    const upTo = Math.min(buf.length, buf.sampleRate * 10)
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < upTo; i++) {
        const a = Math.abs(d[i])
        if (a > peak) peak = a
      }
    }
    return {
      ok: true as const,
      hasAudio: asset.hasAudio,
      assetDurationS: asset.durationS,
      bufDurationS: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      peak,
    }
  })

  console.log(`[demuxed audio] ${JSON.stringify(got)}`)
  if (!got.hasAudio) test.skip(true, 'fixture has no audio track')

  expect(got.ok).toBe(true)
  if (!got.ok) return
  expect(got.sampleRate).toBeGreaterThan(0)
  expect(got.channels).toBeGreaterThan(0)
  // ⛔ THE ONE THAT MATTERS. Zeros are what a swallowed failure looks like.
  expect(got.peak).toBeGreaterThan(0.0001)
  // Sized from asset.durationS, so the buffer sits on the axis reverseAboutContainer
  // and the waveform both assume. Half a frame of slack for the rounding.
  expect(got.bufDurationS).toBeCloseTo(got.assetDurationS, 1)
})
