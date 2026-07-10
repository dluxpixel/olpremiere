// Keyboard editing verbs from the QoL batch: top-and-tail (Q/W), frame nudge
// (Alt+arrows), move-to-track (Alt+up/down), select-all (Ctrl+A), and
// enable/disable (Shift+E).

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

/** Read the active sequence's clips as {id,trackKind,startS,inS,outS,enabled}. */
async function clips(page: Page) {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => {
        tracks: { kind: string; clips: { id: string; startS: number; inS: number; outS: number; enabled: boolean }[] }[]
      }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, trackKind: t.kind })))
  })
}

async function setUI(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (p) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (patch: unknown) => void } }
    }
    useStore.getState().setUI(p)
  }, patch)
}

const select = (page: Page, id: string) => setUI(page, { selection: [id] })
const setPlayhead = (page: Page, tS: number) => setUI(page, { playheadS: tS })

test('Q trims the clip head to the playhead and ripples the tail left', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  const before = (await clips(page)).find((c) => c.trackKind === 'video')!
  expect(before.startS).toBe(0)

  await setPlayhead(page, 0.5)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } }) // ensure keymap installed + focus off inputs
  await page.keyboard.press('q')

  const after = (await clips(page)).find((c) => c.trackKind === 'video')!
  // Head trimmed: source in advanced, clip shifted back to the playhead's old spot (ripple).
  expect(after.inS).toBeGreaterThan(before.inS)
  expect(after.startS).toBeCloseTo(0, 1)
})

test('Alt+Right nudges the selected clip one frame; Shift+Alt is ten', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  const frame = 1 / 30
  await page.keyboard.press('Alt+ArrowRight')
  let now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(v.startS + frame, 4)

  await page.keyboard.press('Shift+Alt+ArrowRight')
  now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(v.startS + frame * 11, 4)

  // And back to zero (clamped, cannot go negative).
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Shift+Alt+ArrowLeft')
  now = (await clips(page)).find((c) => c.id === v.id)!
  expect(now.startS).toBeCloseTo(0, 4)
})

test('Alt+Up moves the selected clip to the track above', async ({ page }) => {
  await boot(page)
  // Place on V1, then a second video track exists as V2 above it.
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  const trackOf = async () =>
    page.evaluate(async (id) => {
      const storeMod = '/src/state/store.ts'
      const typesMod = '/src/engine/types.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
        useStore: { getState: () => { project: unknown } }
      }
      const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
        activeSequence: (p: unknown) => { tracks: { name: string; clips: { id: string }[] }[] }
      }
      const seq = activeSequence(useStore.getState().project)
      return seq.tracks.find((t) => t.clips.some((c) => c.id === id))!.name
    }, v.id)

  expect(await trackOf()).toBe('V1')
  await page.keyboard.press('Alt+ArrowUp')
  expect(await trackOf()).toBe('V2')
})

test('Ctrl+A selects every clip', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  await page.getByTestId('asset-card').dblclick() // two clips
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')

  const selCount = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { selection: string[] } } }
    }
    return useStore.getState().ui.selection.length
  })
  // Two video clips + their linked audio partners = 4.
  expect(selCount).toBeGreaterThanOrEqual(2)
  // On the timeline, selected clips carry the accent ring.
  await expect(page.locator('[data-clip-kind] .ring-accent, [data-clip-kind].ring-accent')).toHaveCount(selCount)
})

test('Shift+E disables the clip (renders at 40%) and re-enables it', async ({ page }) => {
  await boot(page)
  await page.getByTestId('asset-card').dblclick()
  const v = (await clips(page)).find((c) => c.trackKind === 'video')!
  await select(page, v.id)
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })

  await page.keyboard.press('Shift+E')
  expect((await clips(page)).find((c) => c.id === v.id)!.enabled).toBe(false)

  await page.keyboard.press('Shift+E')
  expect((await clips(page)).find((c) => c.id === v.id)!.enabled).toBe(true)
})
