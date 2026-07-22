// Pixel proof for the depth pack: vignette/grain (stylize effects), blend
// modes (fixed-function AND the dest-sampling overlay path), shape masks, and
// chroma/luma keying. All sampled off the live program monitor — the same
// shared renderer the export uses, so these are parity checks too.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function addClip(page: Page, fixture: string = FIXTURE): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(fixture)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.flatMap((t) => t.clips)[0].id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
}

/** Apply a registry effect to the clip and override params, all through the real actions. */
async function applyEffectWithParams(page: Page, clipId: string, type: string, params: Record<string, number>) {
  await page.evaluate(
    async ({ clipId, type, params }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { applyEffect, setEffectParamValue } = (await import(/* @vite-ignore */ editsMod)) as {
        applyEffect: (clipId: string, type: string) => void
        setEffectParamValue: (clipId: string, effectId: string, key: string, value: number) => void
      }
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { clips: { id: string; effects: { id: string; type: string }[] }[] }[] }
      }
      applyEffect(clipId, type)
      const seq = activeSequence(useStore.getState().project)
      const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!
      const fx = clip.effects.find((e) => e.type === type)!
      for (const [key, value] of Object.entries(params)) setEffectParamValue(clipId, fx.id, key, value)
    },
    { clipId, type, params },
  )
}

/** Sample the program monitor at a fractional position. */
async function px(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
      const scratch = document.createElement('canvas')
      scratch.width = c.width
      scratch.height = c.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data
      return [d[0], d[1], d[2]] as [number, number, number]
    },
    { fx, fy },
  )
}

const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/**
 * Wait for the monitor to actually PAINT the fixture's red frame. Media
 * warmup starts when a clip enters the sequence (bounded-warmup change), so
 * the first composite lands a beat after addClip — baselines sampled before
 * it see the black stage.
 */
async function waitForFirstFrame(page: Page): Promise<void> {
  await expect.poll(async () => (await px(page, 0.5, 0.5))[0], { timeout: 10_000 }).toBeGreaterThan(120)
}

test('vignette darkens the corners but not the center', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)
  const beforeCorner = await px(page, 0.06, 0.06)
  await applyEffectWithParams(page, clipId, 'vignette', { amount: 0.9, size: 0.3, feather: 0.3 })
  await page.waitForTimeout(300)
  const afterCorner = await px(page, 0.06, 0.06)
  const afterCenter = await px(page, 0.5, 0.5)
  expect(luma(afterCorner)).toBeLessThan(luma(beforeCorner) * 0.6)
  expect(afterCenter[0]).toBeGreaterThan(120) // the red center survives
})

test('film grain perturbs pixels', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)
  await applyEffectWithParams(page, clipId, 'grain', { amount: 1, size: 4 })
  await page.waitForTimeout(300)
  // Neighbouring samples on a flat red frame now differ — noise is present.
  const samples: number[] = []
  for (const [fx, fy] of [[0.3, 0.3], [0.34, 0.31], [0.31, 0.35], [0.37, 0.36], [0.42, 0.33]] as const) {
    samples.push(luma(await px(page, fx, fy)))
  }
  const spread = Math.max(...samples) - Math.min(...samples)
  expect(spread).toBeGreaterThan(4)
})

test('blend modes hit the renderer: multiply blacks out over the empty stage, overlay takes the dest-sampling path, normal restores', async ({ page }) => {
  await addClip(page)
  await waitForFirstFrame(page)
  const baseline = await px(page, 0.5, 0.5)
  expect(baseline[0]).toBeGreaterThan(120)

  // The only track sits over the opaque-black stage: multiply → black.
  await page.getByTestId('blend-mode').selectOption('multiply')
  await page.waitForTimeout(300)
  expect(luma(await px(page, 0.5, 0.5))).toBeLessThan(25)

  // Overlay runs the capture + full-screen BLENDMODE_FS path; over black it is black.
  await page.getByTestId('blend-mode').selectOption('overlay')
  await page.waitForTimeout(300)
  expect(luma(await px(page, 0.5, 0.5))).toBeLessThan(25)

  await page.getByTestId('blend-mode').selectOption('normal')
  await page.waitForTimeout(300)
  expect((await px(page, 0.5, 0.5))[0]).toBeGreaterThan(120)
})

test('an ellipse mask keeps the center, kills the corner, and invert flips it', async ({ page }) => {
  await addClip(page)
  await waitForFirstFrame(page)
  await page.getByTestId('mask-kind').selectOption('ellipse')
  await page.waitForTimeout(300)
  expect((await px(page, 0.5, 0.5))[0]).toBeGreaterThan(120) // inside survives
  expect(luma(await px(page, 0.05, 0.05))).toBeLessThan(25) // outside is gone

  await page.getByTestId('mask-invert').check()
  await page.waitForTimeout(300)
  expect(luma(await px(page, 0.5, 0.5))).toBeLessThan(25) // inside is gone
  expect((await px(page, 0.05, 0.05))[0]).toBeGreaterThan(120) // outside survives
})

test('chroma key removes the keyed colour', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page) // red frame painted
  // Key RED (the fixture's first-second frame colour).
  await applyEffectWithParams(page, clipId, 'chromaKey', {
    keyR: 1,
    keyG: 0,
    keyB: 0,
    similarity: 0.5,
    smoothness: 0.1,
    spill: 0,
  })
  await page.waitForTimeout(300)
  expect(luma(await px(page, 0.5, 0.5))).toBeLessThan(25)
})

test('green screen keys the green but keeps white detail (corners + thin lines)', async ({ page }) => {
  // A dedicated pure-green fixture with a white centre block + a thin white line —
  // the exact case that used to keep a green fringe on white edges. Applied at the
  // effect's DROP defaults (no param overrides), so this also proves "just drop it
  // and it works" for a bright green screen.
  const clipId = await addClip(page, 'e2e/.fixtures/greenscreen.webm')
  // The white centre must paint before we key.
  await expect.poll(async () => luma(await px(page, 0.5, 0.5)), { timeout: 10_000 }).toBeGreaterThan(200)
  await applyEffectWithParams(page, clipId, 'chromaKey', {})
  await page.waitForTimeout(300)

  const white = await px(page, 0.5, 0.5) // white centre block
  const green = await px(page, 0.15, 0.5) // pure-green screen area
  // White detail survives, fully opaque and bright (a chroma-distance key ate this).
  expect(luma(white)).toBeGreaterThan(200)
  // The green screen is keyed out → the dark stage shows through, with no green left.
  expect(luma(green)).toBeLessThan(40)
  expect(green[1]).toBeLessThan(60)
})

test('a green key leaves non-green footage untouched', async ({ page }) => {
  // Guard against a green screen desaturating/erasing the rest of the footage:
  // red has zero green-excess, so it must survive fully (opaque, un-despilled).
  const clipId = await addClip(page) // the RED fixture
  await waitForFirstFrame(page)
  await applyEffectWithParams(page, clipId, 'chromaKey', {}) // green key at drop defaults
  await page.waitForTimeout(300)
  const red = await px(page, 0.5, 0.5)
  expect(red[0]).toBeGreaterThan(120) // red channel intact
  expect(luma(red)).toBeGreaterThan(40) // not keyed to the dark stage
})

test('luma key keys the frame out above threshold and leaves it below', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)
  // Red luma ≈ 0.22 → threshold 0.6 keys the whole red frame to black.
  await applyEffectWithParams(page, clipId, 'lumaKey', { threshold: 0.6, softness: 0.05 })
  await page.waitForTimeout(300)
  expect(luma(await px(page, 0.5, 0.5))).toBeLessThan(25)
})

test('an adjustment layer grades the footage below it (and only inside its mask)', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)
  const before = await px(page, 0.5, 0.5)
  expect(before[0]).toBeGreaterThan(120) // red footage
  expect(before[0] - before[2]).toBeGreaterThan(80) // strongly saturated

  // Add an adjustment layer over the footage and desaturate through it.
  await page.getByTestId('add-adjustment').click()
  await expect(page.locator('[data-clip-kind="adjustment"]')).toHaveCount(1)
  const adjId = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; adjustment?: boolean }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).find((c) => c.adjustment)!.id
  })
  await applyEffectWithParams(page, adjId, 'saturation', { saturation: -1 })
  await page.waitForTimeout(300)
  const after = await px(page, 0.5, 0.5)
  expect(Math.abs(after[0] - after[2])).toBeLessThan(14) // grayscale = channels converge

  // Mask the adjustment to a small centered ellipse: the corner regains colour.
  await page.evaluate(async (id) => {
    const editsMod = '/src/state/clipEdits.ts'
    const { setClipMask } = (await import(/* @vite-ignore */ editsMod)) as {
      setClipMask: (clipId: string, mask: unknown) => void
    }
    setClipMask(id, { kind: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, feather: 0.02, invert: false })
  }, adjId)
  await page.waitForTimeout(300)
  const centerMasked = await px(page, 0.5, 0.5)
  const cornerMasked = await px(page, 0.1, 0.1)
  expect(Math.abs(centerMasked[0] - centerMasked[2])).toBeLessThan(14) // inside: graded
  expect(cornerMasked[0] - cornerMasked[2]).toBeGreaterThan(80) // outside: original red
  void clipId
})

test('the new transitions are listed in the Effects browser', async ({ page }) => {
  await addClip(page)
  await page.getByRole('tab', { name: 'Effects' }).click()
  for (const kind of ['zoom', 'spin', 'glitch', 'lumaWipe']) {
    await expect(page.locator(`[data-testid="transition-item"][data-payload="${kind}"]`)).toBeVisible()
  }
  for (const type of ['vignette', 'grain', 'sharpen', 'glow', 'chromaKey', 'lumaKey']) {
    await expect(page.locator(`[data-testid="effect-item"][data-payload="${type}"]`)).toBeVisible()
  }
})
