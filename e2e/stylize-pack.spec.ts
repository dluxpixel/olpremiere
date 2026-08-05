// Pixel proof for the depth pack: vignette/grain (stylize effects), blend
// modes (fixed-function AND the dest-sampling overlay path), shape masks, and
// chroma/luma keying. All sampled off the live program monitor, the same
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
/**
 * Read one pixel off the program monitor.
 *
 * FORCES A REPAINT FIRST, and that is not politeness. The monitor parks once a
 * frame is fully resolved ("do zero GPU work"), and a WebGL canvas is not
 * created with preserveDrawingBuffer, so copying a parked canvas with drawImage
 * can hand back BLACK long after the picture is correct on screen. That made
 * this file fail roughly one run in three, always on a static frame, and it
 * blocked two releases while the app itself was rendering perfectly.
 *
 * Bumping the preview epoch is exactly what the live gizmo drag uses to say
 * "repaint even though nothing in the store moved". Two animation frames later
 * the buffer is guaranteed fresh, and the read is deterministic.
 */
async function px(page: Page, fx: number, fy: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ fx, fy }) => {
      const previewMod = '/src/engine/preview.ts'
      const { invalidatePreview } = (await import(/* @vite-ignore */ previewMod)) as {
        invalidatePreview: () => void
      }
      invalidatePreview()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
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
 * the first composite lands a beat after addClip, so baselines sampled before
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
  // Neighbouring samples on a flat red frame now differ. Noise is present.
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
  // A dedicated pure-green fixture with a white centre block + a thin white line,
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
  for (const kind of ['zoom', 'glitch', 'whiteFlash']) {
    await expect(page.locator(`[data-testid="transition-item"][data-payload="${kind}"]`)).toBeVisible()
  }
  for (const type of ['vignette', 'glow', 'chromaKey']) {
    await expect(page.locator(`[data-testid="effect-item"][data-payload="${type}"]`)).toBeVisible()
  }
  // And the ones he said he would never use are NOT on the shelf any more
  // (2026-07-28). They still render and still migrate; they are just not offered.
  for (const type of ['grain', 'sharpen', 'lumaKey', 'colorWheels', 'whiteBalance', 'exposure', 'vibrance']) {
    await expect(page.locator(`[data-testid="effect-item"][data-payload="${type}"]`)).toHaveCount(0)
  }
  // The casual TRANSITIONS went the same way on 2026-07-29, his call: "remove
  // any effects that will not be used in the Jettism style, like spin-outs."
  // White Flash is deliberately absent from this list, he said he will use it.
  for (const kind of ['spin', 'lumaWipe', 'wipeLeft', 'wipeRight']) {
    await expect(page.locator(`[data-testid="transition-item"][data-payload="${kind}"]`)).toHaveCount(0)
  }
})

// --- Lone-edge transitions --------------------------------------------------
// A transition with no partner clip used to collapse to a fade-from-black for
// every kind but White Flash: applying "Glitch" or "Dip to White" to the head of
// the FIRST clip of a Short drew a black fade while the Inspector kept saying
// Glitch. These sample the live monitor to prove each kind now runs its own form.

async function setLoneTransition(page: Page, clipId: string, kind: string, durationS: number): Promise<void> {
  await page.evaluate(
    async ({ clipId, kind, durationS }) => {
      const editsMod = '/src/state/clipEdits.ts'
      const { setClipTransition } = (await import(/* @vite-ignore */ editsMod)) as {
        setClipTransition: (id: string, edge: 'in' | 'out', kind: string, durationS?: number) => void
      }
      setClipTransition(clipId, 'in', kind, durationS)
    },
    { clipId, kind, durationS },
  )
}

async function setPlayhead(page: Page, tS: number): Promise<void> {
  await page.evaluate(async (t) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ playheadS: t, selection: [] })
  }, tS)
}

test('a lone Dip to White dips through WHITE, not through black', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)

  await setLoneTransition(page, clipId, 'dipToWhite', 1)
  // Halfway through the window is the solid, the whole point of a dip.
  await setPlayhead(page, 0.5)
  await expect.poll(async () => luma(await px(page, 0.5, 0.5)), { timeout: 10_000 }).toBeGreaterThan(200)

  // ...and by the end of the window the footage is back.
  //
  // Checked as "real picture, and NOT the white solid", not as "the red channel
  // is high". The fixture cuts from red to BLUE partway through, and 1.5 s is on
  // the blue side (phase3.spec.ts polls for blue at exactly this time). Asserting
  // red here only ever passed by reading a stale parked canvas from an earlier
  // moment; once the read was made deterministic it failed every run, on an app
  // that was rendering correctly the whole time.
  await setPlayhead(page, 1.5)
  await expect
    .poll(
      async () => {
        const [r, g, b] = await px(page, 0.5, 0.5)
        const white = r > 200 && g > 200 && b > 200
        return !white && Math.max(r, g, b) > 120
      },
      { timeout: 10_000 },
    )
    .toBe(true)
})

// Wipe Left was CUT on 2026-07-29 along with Wipe Right, Spin and Luma Wipe.
// This replaces the test that proved it wiped, and guards the thing that made
// removing it safe: an OLD PROJECT still carrying one has to keep opening and
// keep rendering. It falls back to a dissolve, which shows the whole frame at
// once instead of a hard edge down the middle.
test('a project still carrying a CUT transition renders as a dissolve, not broken', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)

  await setLoneTransition(page, clipId, 'wipeLeft', 1)
  await setPlayhead(page, 0.5)
  // Something is genuinely on screen (it did not fail to a black frame)...
  await expect.poll(async () => (await px(page, 0.5, 0.5))[0], { timeout: 10_000 }).toBeGreaterThan(40)
  // ...and there is no wipe edge: both sides of the frame match.
  const spread = Math.abs((await px(page, 0.15, 0.5))[0] - (await px(page, 0.85, 0.5))[0])
  expect(spread).toBeLessThan(20)
})

test('a lone Glitch is not a fade to black', async ({ page }) => {
  const clipId = await addClip(page)
  await waitForFirstFrame(page)

  await setLoneTransition(page, clipId, 'glitch', 1)
  await setPlayhead(page, 0.9) // near the end of the window: mostly resolved
  // A fade-from-black at 90% would be ~90% of the fixture's red. A glitch
  // displaces and tints instead, so simply prove there IS picture here.
  await expect.poll(async () => luma(await px(page, 0.5, 0.5)), { timeout: 10_000 }).toBeGreaterThan(30)
})

// The ring/streak bugs live in the PAIR path (two real clips either side of the
// cut), where both sides carry picture. On a lone edge the surround is empty by
// design, so it proves nothing.
async function addSecondClip(page: Page): Promise<string> {
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(2)
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; startS: number }[] }[] }
    }
    const clips = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .sort((a, b) => a.startS - b.startS)
    return clips[clips.length - 1].id
  })
}

async function cutTimeOf(page: Page, clipId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; startS: number }[] }[] }
    }
    return activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id)!.startS
  }, clipId)
}

test('Cross Zoom no longer draws a dark ring round the frame', async ({ page }) => {
  await addClip(page)
  await waitForFirstFrame(page)
  const cornerBefore = luma(await px(page, 0.04, 0.06))
  const second = await addSecondClip(page)

  await setLoneTransition(page, second, 'zoom', 1)
  const cut = await cutTimeOf(page, second)
  // Late enough that the old fallback mixed the corner mostly toward black
  // (weight ~0.72), but still inside the window where the incoming shot's
  // sample runs off the frame, which is exactly where the ring lived.
  await setPlayhead(page, cut + 0.65)
  await expect
    .poll(async () => luma(await px(page, 0.04, 0.06)), { timeout: 10_000 })
    .toBeGreaterThan(cornerBefore * 0.6)
  expect(luma(await px(page, 0.96, 0.94))).toBeGreaterThan(cornerBefore * 0.6)
})
