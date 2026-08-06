// "I selected a blur, but can I somehow make it so it transitions into the
// blur? Can you make that an option for the effects, so that it has also
// transitions?" (2026-08-06)
//
// WHAT THIS MEASURES, and what it deliberately does not. The first version read
// pixels off the program monitor and compared edge energy at the head of the
// clip against half a second later. It read 0 every time, and 0 is the honest
// answer: the e2e fixture is a flat colour, so it has no edges for a blur to
// soften. A picture test against a picture with nothing in it proves nothing.
//
// So this drives the REAL UI (add the effect from the Inspector picker, click
// Ease In) and then asks the app's own resolver what the blur radius is at each
// moment, which is the number the renderer and the exporter both read. The
// pixel-level maths of the ramp is covered in src/engine/effects/ops.test.ts.

import { expect, test, type Page } from '@playwright/test'

/** The blur radius the app's resolver reports at clip-local time `t`. */
async function radiusAt(page: Page, t: number): Promise<number> {
  return page.evaluate(async (tt) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const opsMod = '/src/engine/effects/ops.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { clips: { id: string; effects?: { id: string; type: string }[] }[] }[]
      }
    }
    const { resolveParam } = (await import(/* @vite-ignore */ opsMod)) as {
      resolveParam: (inst: unknown, key: string, localT: number) => number
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((tr) => tr.clips).find((c) => (c.effects?.length ?? 0) > 0)
    const inst = clip?.effects?.find((e) => e.type === 'gaussianBlur')
    return inst ? resolveParam(inst, 'blur', tt) : -1
  }, t)
}

test('Ease In makes the blur ARRIVE instead of appearing', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().click({ position: { x: 20, y: 10 } })

  // Add the blur the way he does: the Inspector's own picker.
  await page.getByTestId('inspector-add-effect').selectOption('gaussianBlur')
  await expect(page.getByTestId('effect-ease').first()).toBeVisible()

  // Turn the radius up, through the real action, so there is something to ease into.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const editsMod = '/src/state/clipEdits.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { setEffectParamValue } = (await import(/* @vite-ignore */ editsMod)) as {
      setEffectParamValue: (clipId: string, effectId: string, key: string, v: number) => void
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; effects?: { id: string }[] }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => (c.effects?.length ?? 0) > 0)!
    setEffectParamValue(clip.id, clip.effects![0].id, 'blur', 24)
  })

  // Before the ease: blurred from the very first frame, which is the complaint.
  expect(await radiusAt(page, 0)).toBeCloseTo(24, 3)

  await page.getByTestId('effect-ease-in').first().click()

  // After: nothing at the head, full blur once the ease has run, and it STAYS.
  expect(await radiusAt(page, 0)).toBeCloseTo(0, 3)
  expect(await radiusAt(page, 0.25)).toBeGreaterThan(0)
  expect(await radiusAt(page, 0.25)).toBeLessThan(24)
  expect(await radiusAt(page, 0.5)).toBeCloseTo(24, 3)
  expect(await radiusAt(page, 1.5)).toBeCloseTo(24, 3)

  // The diamonds are real keyframes on the row above, not a hidden mode.
  await expect(page.getByTestId('effect-ease-clear').first()).toBeVisible()
})

test('Ease Out returns the picture to normal at the tail', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().click({ position: { x: 20, y: 10 } })
  await page.getByTestId('inspector-add-effect').selectOption('gaussianBlur')
  await expect(page.getByTestId('effect-ease').first()).toBeVisible()

  const durS = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const editsMod = '/src/state/clipEdits.ts'
    const typesMod = '/src/engine/types.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { setEffectParamValue } = (await import(/* @vite-ignore */ editsMod)) as {
      setEffectParamValue: (clipId: string, effectId: string, key: string, v: number) => void
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { id: string; effects?: { id: string }[] }[] }[] }
    }
    const { clipDurationS } = (await import(/* @vite-ignore */ tlMod)) as {
      clipDurationS: (c: unknown) => number
    }
    const seq = activeSequence(useStore.getState().project)
    const clip = seq.tracks.flatMap((t) => t.clips).find((c) => (c.effects?.length ?? 0) > 0)!
    setEffectParamValue(clip.id, clip.effects![0].id, 'blur', 24)
    return clipDurationS(clip)
  })

  await page.getByTestId('effect-ease-out').first().click()

  // Blurred all the way through, then back to nothing by the very last frame.
  expect(await radiusAt(page, 0)).toBeCloseTo(24, 3)
  expect(await radiusAt(page, durS)).toBeCloseTo(0, 3)
})
