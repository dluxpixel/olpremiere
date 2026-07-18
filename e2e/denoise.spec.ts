// Non-destructive noise reduction (RNNoise as a clip control, not a record-
// time bake). Proves, against the REAL wasm in the REAL browser: the engine
// loads and is deterministic, strength 0 is byte-identical to raw, the
// Inspector toggle round-trips through the store with undo, and the clip
// resolver actually swaps the samples the mixers read.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function bootWithClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

/** Select the audio-track clip and return its id. */
async function selectAudioClip(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.find((t) => t.kind === 'audio')!.clips[0]!.id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
}

test('the RNNoise engine loads, is deterministic, and strength 0 is byte-identical to raw', async ({
  page,
}) => {
  await page.goto('/')
  const r = await page.evaluate(async () => {
    const mod = '/src/engine/denoise.ts'
    const { ensureRnnoise, denoiseChannel, mixDryWet } = (await import(/* @vite-ignore */ mod)) as {
      ensureRnnoise: () => Promise<{ frameSize: number }>
      denoiseChannel: (e: unknown, d: Float32Array) => Float32Array
      mixDryWet: (raw: Float32Array, wet: Float32Array, s: number) => Float32Array
    }
    const engine = await ensureRnnoise()
    // Seeded noise so both runs see the same input.
    let seed = 1337
    const rnd = () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const input = Float32Array.from({ length: 480 * 50 }, () => (rnd() * 2 - 1) * 0.05)
    const a = denoiseChannel(engine, input)
    const b = denoiseChannel(engine, input)
    const same = a.every((v, i) => v === b[i])
    const dry = mixDryWet(input, a, 0)
    const dryIdentical = dry.every((v, i) => v === input[i])
    const rms = (d: Float32Array) => Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length)
    return {
      frameSize: (engine as { frameSize: number }).frameSize,
      deterministic: same,
      dryIdentical,
      inRms: rms(input),
      outRms: rms(a),
    }
  })
  expect(r.frameSize).toBe(480)
  expect(r.deterministic).toBe(true) // preview==export leans on this
  expect(r.dryIdentical).toBe(true) // the A/B guarantee
  expect(r.outRms).toBeLessThan(r.inRms * 0.5) // >6 dB off broadband noise
})

test('the Inspector toggle writes the clip, the resolver swaps samples, and undo clears it', async ({
  page,
}) => {
  await bootWithClip(page)
  const clipId = await selectAudioClip(page)

  // Toggle on via the real UI.
  await page.getByTestId('denoise-toggle').click()
  const readDenoise = () =>
    page.evaluate(async (id) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => {
          tracks: { clips: { id: string; denoise?: number }[] }[]
        }
      }
      const seq = activeSequence(useStore.getState().project)
      return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.denoise ?? null
    }, clipId)
  expect(await readDenoise()).toBe(1)

  // The strength field appears; commit 60%. ScrubField is readOnly until a
  // double-click switches it into text-edit mode (drag-to-scrub otherwise).
  await expect(page.getByTestId('field-denoise')).toBeVisible()
  await page.getByTestId('field-denoise').dblclick()
  await page.getByTestId('field-denoise').fill('60')
  await page.getByTestId('field-denoise').press('Enter')
  expect(await readDenoise()).toBeCloseTo(0.6, 6)

  // The resolver hands the mixers DIFFERENT samples for the denoised clip.
  const swap = await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const audioMod = '/src/engine/audio.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { assets: Record<string, unknown> } } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; assetId: string }[] }[] }
    }
    const { clipAudioBuffer, getAudioBuffer } = (await import(/* @vite-ignore */ audioMod)) as {
      clipAudioBuffer: (clip: unknown, asset: unknown, rev: boolean) => Promise<AudioBuffer | null>
      getAudioBuffer: (asset: unknown) => Promise<AudioBuffer | null>
    }
    const project = useStore.getState().project
    const clip = activeSequence(project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id)!
    const asset = project.assets[clip.assetId]!
    const raw = await getAudioBuffer(asset)
    const cooked = await clipAudioBuffer(clip, asset, false)
    if (!raw || !cooked) return { ok: false as const }
    const a = raw.getChannelData(0)
    const b = cooked.getChannelData(0)
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
    return { ok: true as const, length: b.length === a.length, diffFrac: diff / a.length }
  }, clipId)
  expect(swap.ok).toBe(true)
  expect(swap.length).toBe(true) // duration must never drift
  expect(swap.diffFrac).toBeGreaterThan(0.5) // most samples actually changed

  // Undo walks the edits back off. The exact step count depends on how many
  // commits the ScrubField interaction produced (dblclick/blur can add one) —
  // the one-dispatch-one-step contract is pinned in clipEdits' unit tests;
  // here the claim is that undo RESTORES the raw-audio state.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  for (let i = 0; i < 4 && (await readDenoise()) !== null; i++) {
    await page.keyboard.press('Control+z')
  }
  expect(await readDenoise()).toBe(null)
})
