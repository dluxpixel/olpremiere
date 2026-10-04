// Ctrl+V pastes onto the track he clicked. His words, 2026-10-04, with a screenshot
// of a picture that landed on V2: *"I click and paste it on that. It pastes it at
// the right time, but make sure it also pastes it on the same line because I
// clicked the V4, and there is that thing. It pasted it in V2."*
//
// The unit tests prove the rules. This proves the click: a REAL mouse click on an
// empty spot of the V4 lane (and on a track header), then a REAL Ctrl+V, in
// Chromium, with the clipboard of the test browser (never his).

import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
})

// The headless browser's clipboard outlives the page: leave it empty, so a picture
// left here can never meet a later spec's Ctrl+V.
test.afterEach(async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => undefined)
})

interface TitleAt {
  id: string
  text: string
  track: string
  startS: number
}

/** Every title clip with the track it sits on. */
async function titles(page: Page): Promise<TitleAt[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { name: string; clips: { id: string; startS: number; title?: { text: string } }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) =>
      t.clips.filter((c) => c.title).map((c) => ({ id: c.id, text: c.title!.text, track: t.name, startS: c.startS })),
    )
  })
}

/** Titles by name on named tracks, seeded straight into the project the way a drag would leave them. */
async function seed(page: Page, byTrack: Record<string, { text: string; startS: number; durS: number }[]>): Promise<void> {
  await page.evaluate(async (spec) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const types = (await import(/* @vite-ignore */ typesMod)) as {
      newTitleClip: (def: unknown, startS: number, durS: number) => unknown
      defaultTitleDef: (text: string) => unknown
    }
    const tl = (await import(/* @vite-ignore */ tlMod)) as { recomputeDuration: (s: unknown) => unknown }
    updateActiveSequence('seed', (sq) => {
      const seq = sq as { tracks: { name: string; clips: unknown[] }[] }
      return tl.recomputeDuration({
        ...seq,
        tracks: seq.tracks.map((t) => {
          const add = spec[t.name]
          if (!add) return t
          return {
            ...t,
            clips: [...t.clips, ...add.map((a: { text: string; startS: number; durS: number }) => types.newTitleClip(types.defaultTitleDef(a.text), a.startS, a.durS))],
          }
        }),
      })
    })
  }, byTrack)
}

async function select(page: Page, texts: string[]): Promise<void> {
  const ids = (await titles(page)).filter((t) => texts.includes(t.text)).map((t) => t.id)
  await page.evaluate(async (sel) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { setUI: (p: unknown) => void } } }
    useStore.getState().setUI({ selection: sel })
  }, ids)
}

async function playhead(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { ui: { playheadS: number } } } }
    return useStore.getState().ui.playheadS
  })
}

/** V1 to V4 and A1, A2: the two default video tracks plus two more. */
async function openWithFourVideoTracks(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('add-video-track').click()
  await page.getByTestId('add-video-track').click()
  await expect(page.getByTestId('track-header-V4')).toBeVisible()
}

/**
 * A real click on an empty spot of the named track's lane, `dx` px in from the
 * lane's left edge. The lane is found among the lanes themselves (the header
 * column can sit scrolled apart from them after a click on its Add button), and
 * scrolled into view first.
 */
async function clickLane(page: Page, track: string, dx = 400): Promise<void> {
  const rect = await page.evaluate((name) => {
    const lanes = document.querySelector('[data-testid="timeline-lanes"]') as HTMLElement
    const content = lanes.firstElementChild as HTMLElement
    // The headers are in the lanes' own order: video from the top, then audio.
    const names = [...document.querySelectorAll('[data-testid^="track-header-"]')].map((h) =>
      (h as HTMLElement).dataset.testid!.replace('track-header-', ''),
    )
    const at = names.indexOf(name)
    if (at < 0) throw new Error(`no track ${name}`)
    // Child 0 of the content is the ruler, and audio lanes sit after a 2px divider.
    const lane = content.children[1 + at + (name.startsWith('A') ? 1 : 0)] as HTMLElement
    lane.scrollIntoView({ block: 'center' })
    const r = lane.getBoundingClientRect()
    return { x: r.left, y: r.top + r.height / 2 }
  }, track)
  await page.mouse.click(rect.x + dx, rect.y)
}

/** Put a small red PNG on the (test browser's) clipboard, the way a screenshot tool would. */
async function copyPicture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#e03030'
    ctx.fillRect(0, 0, 64, 48)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
}

async function imageClips(page: Page): Promise<{ track: string; startS: number }[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => {
          project: {
            activeSequenceId: string
            sequences: Record<string, { tracks: { name: string; clips: { assetId: string; startS: number }[] }[] }>
            assets: Record<string, { kind: string }>
          }
        }
      }
    }
    const s = useStore.getState()
    const seq = s.project.sequences[s.project.activeSequenceId]!
    return seq.tracks.flatMap((t) =>
      t.clips.filter((c) => s.project.assets[c.assetId]?.kind === 'image').map((c) => ({ track: t.name, startS: c.startS })),
    )
  })
}

test('a click on V4 then Ctrl+V pastes the copied clip on V4 at the playhead, not back on V2', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await seed(page, { V2: [{ text: 'copied', startS: 0, durS: 2 }] })
  await select(page, ['copied'])
  await page.keyboard.press('ControlOrMeta+c')

  await clickLane(page, 'V4')
  await expect(page.getByTestId('track-header-V4')).toHaveAttribute('data-paste-target', 'true')
  const at = await playhead(page)
  expect(at).toBeGreaterThan(0)

  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await titles(page)).length).toBe(2)
  const pasted = (await titles(page)).find((t) => t.track === 'V4')!
  expect(pasted).toBeDefined()
  expect(pasted.startS).toBeCloseTo(at, 6)
  // The original stayed where it was.
  expect((await titles(page)).filter((t) => t.track === 'V2')).toHaveLength(1)

  // One Ctrl+Z takes the paste back out.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await titles(page)).length).toBe(1)
})

test('clicking a track header makes it the paste target too', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await seed(page, { V2: [{ text: 'copied', startS: 0, durS: 2 }] })
  await select(page, ['copied'])
  await page.keyboard.press('ControlOrMeta+c')

  await page.getByTestId('track-header-V3').click({ position: { x: 12, y: 8 } })
  await expect(page.getByTestId('track-header-V3')).toHaveAttribute('data-paste-target', 'true')
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { setUI: (p: unknown) => void } } }
    useStore.getState().setUI({ playheadS: 3 })
  })

  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await titles(page)).length).toBe(2)
  const pasted = (await titles(page)).find((t) => t.track === 'V3')!
  expect(pasted.startS).toBeCloseTo(3, 6)
})

test('several copied clips keep their lanes: the top one goes on V4, the other under it on V3', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await seed(page, {
    V1: [{ text: 'bottom', startS: 0, durS: 2 }],
    V2: [{ text: 'top', startS: 0, durS: 2 }],
  })
  await select(page, ['bottom', 'top'])
  await page.keyboard.press('ControlOrMeta+c')

  await clickLane(page, 'V4')
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await titles(page)).length).toBe(4)
  const all = await titles(page)
  const pastedTop = all.find((t) => t.text === 'top' && t.track === 'V4')
  const pastedBottom = all.find((t) => t.text === 'bottom' && t.track === 'V3')
  expect(pastedTop).toBeDefined()
  expect(pastedBottom).toBeDefined()
  expect(pastedTop!.startS).toBeCloseTo(pastedBottom!.startS, 6)
})

test('a busy V4 says where the clip went, and deletes nothing', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await seed(page, {
    V2: [{ text: 'copied', startS: 0, durS: 2 }],
  })
  await select(page, ['copied'])
  await page.keyboard.press('ControlOrMeta+c')

  // Click V4 first, so the playhead is somewhere it can be made busy.
  await clickLane(page, 'V4')
  const at = await playhead(page)
  await seed(page, { V4: [{ text: 'in the way', startS: Math.max(0, at - 1), durS: 4 }] })

  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByTestId('toast').filter({ hasText: 'V4 is busy at that time, so the clip went on V5' })).toBeVisible()
  const all = await titles(page)
  expect(all.filter((t) => t.text === 'in the way')).toHaveLength(1)
  expect(all.find((t) => t.text === 'copied' && t.track === 'V5')?.startS).toBeCloseTo(at, 6)
  expect(all.find((t) => t.text === 'in the way')!.track).toBe('V4')
})

test('with no track clicked, Ctrl+V still puts a clip back on the track it came from', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await seed(page, { V2: [{ text: 'copied', startS: 0, durS: 2 }] })
  await select(page, ['copied'])
  await page.keyboard.press('ControlOrMeta+c')
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { setUI: (p: unknown) => void } } }
    useStore.getState().setUI({ playheadS: 5, selection: [] })
  })
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await titles(page)).length).toBe(2)
  expect((await titles(page)).filter((t) => t.track === 'V2')).toHaveLength(2)
})

test('a copied picture pastes onto the track he clicked, not onto V2', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await copyPicture(page)
  await clickLane(page, 'V4')
  const at = await playhead(page)

  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByTestId('paste-picture-dialog')).toBeVisible()
  await page.getByTestId('paste-picture-keep').click()
  await expect.poll(async () => (await imageClips(page)).length).toBe(1)
  const [placed] = await imageClips(page)
  expect(placed!.track).toBe('V4')
  expect(placed!.startS).toBeCloseTo(at, 2)
})

test('a copied picture still goes to V2 when no track was clicked', async ({ page }) => {
  await openWithFourVideoTracks(page)
  await copyPicture(page)
  await page.keyboard.press('ControlOrMeta+v')
  await page.getByTestId('paste-picture-keep').click()
  await expect.poll(async () => (await imageClips(page)).length).toBe(1)
  expect((await imageClips(page))[0]!.track).toBe('V2')
})
