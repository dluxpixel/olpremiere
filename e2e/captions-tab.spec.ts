// The reworked captions, end to end through the real interface.
//
// His words, 2026-10-03: *"right-clicking and selecting multiple clips just
// says 'Caption this clip,' and it captions only one. The 'Caption every clip'
// feature I use also, make it so I can somehow save caption styles, including
// caption length, how big it is, and stuff like that."*
//
// The speech model is the one thing stood in for: a caption run listens through
// `captionEars`, and these tests put words there instead of downloading Whisper.
// Everything else is the real menus, the real tab and the real store.

import { expect, test, type Page } from '@playwright/test'

type Caption = { text: string; startS: number; fontSizePx: number }

/** Import the fixture clip and lay `starts.length` copies of its sound on A1. */
async function seedSoundClips(page: Page, starts: number[]): Promise<string[]> {
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  return page.evaluate(async (at) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { assets: Record<string, { id: string }> } } }
      updateActiveSequence: (label: string, fn: (sq: { tracks: { id: string; kind: string; clips: unknown[] }[] }) => unknown) => void
    }
    const { newClipFromAsset } = (await import(/* @vite-ignore */ typesMod)) as {
      newClipFromAsset: (a: unknown, startS: number) => { id: string; outS: number }
    }
    const asset = Object.values(useStore.getState().project.assets)[0]!
    const clips = at.map((s) => ({ ...newClipFromAsset(asset, s), outS: 1.5 }))
    updateActiveSequence('seed', (sq) => {
      const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
      return { ...sq, tracks: sq.tracks.map((t) => (t.id === a1 ? { ...t, clips } : t)) }
    })
    return clips.map((c) => c.id)
  }, starts)
}

/** Stand in for the speech model: three words per clip, a little slowly, named after where the clip sits. */
async function standInEars(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = '/src/state/transcribeActions.ts'
    const { captionEars, useTranscribe } = (await import(/* @vite-ignore */ mod)) as {
      captionEars: { wordsForClip: (clip: { startS: number }) => Promise<unknown[]> }
      useTranscribe: { setState: (s: Record<string, unknown>) => void }
    }
    captionEars.wordsForClip = async (clip) => {
      // The real listener says what it is doing; so does this one.
      useTranscribe.setState({ status: 'listening', pct: null, downloading: false })
      await new Promise((r) => setTimeout(r, 400))
      const tag = `c${Math.round(clip.startS)}`
      return ['alpha', 'bravo', 'charlie'].map((w, i) => ({
        text: `${w}${tag}`,
        startS: clip.startS + i * 0.25,
        endS: clip.startS + (i + 1) * 0.25,
      }))
    }
  })
}

/** Every caption on the Captions track, in time order. */
async function captions(page: Page): Promise<Caption[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const capMod = '/src/state/captionActions.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { captionsOn } = (await import(/* @vite-ignore */ capMod)) as {
      captionsOn: (seq: unknown) => { clip: { startS: number; title: { text: string; fontSizePx: number } } }[]
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as { activeSequence: (p: unknown) => unknown }
    return captionsOn(activeSequence(useStore.getState().project)).map(({ clip }) => ({
      text: clip.title.text,
      startS: clip.startS,
      fontSizePx: clip.title.fontSizePx,
    }))
  })
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { undo: () => void } } }
    useStore.getState().undo()
  })
}

/** Type a number into one of the tab's scrub fields. */
async function typeNumber(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

test('right click on three selected clips captions all three, in one undo step, saying how far it is', async ({ page }) => {
  await page.goto('/')
  await seedSoundClips(page, [0, 3, 6])
  await standInEars(page)

  // Select the three the way he does: click, then Ctrl+click.
  const sound = page.locator('[data-clip-kind="audio"]')
  await expect(sound).toHaveCount(3)
  await sound.nth(0).click()
  await sound.nth(1).click({ modifiers: ['Control'] })
  await sound.nth(2).click({ modifiers: ['Control'] })
  await sound.nth(2).click({ button: 'right' })

  const menu = page.getByTestId('context-menu')
  await expect(menu.getByRole('menuitem', { name: 'Caption 3 clips' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Caption this clip' })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Caption 3 clips' }).click()

  // The progress says where it is while it works.
  await expect(page.getByTestId('transcribe-queue')).toContainText('of 3')

  await expect.poll(async () => (await captions(page)).length, { timeout: 15_000 }).toBeGreaterThan(0)
  const texts = (await captions(page)).map((c) => c.text).join(' ')
  for (const tag of ['c0', 'c3', 'c6']) expect(texts).toContain(`alpha${tag}`)
  await expect(page.getByTestId('transcribe-status')).toHaveCount(0)

  // One undo step takes the whole run back.
  await undo(page)
  expect(await captions(page)).toHaveLength(0)
})

test('a style saved with its own length and size, then put on the captions he has', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const capMod = '/src/state/captionActions.ts'
    const { addCaptionsFromWords } = (await import(/* @vite-ignore */ capMod)) as {
      addCaptionsFromWords: (w: unknown[]) => void
    }
    addCaptionsFromWords(
      'so we went to the store'.split(' ').map((t, i) => ({ text: t, startS: i * 0.25, endS: (i + 1) * 0.25 })),
    )
  })

  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('caption-row')).not.toHaveCount(0)
  const before = (await captions(page)).length
  expect(before).toBeGreaterThan(2)

  await page.getByTestId('captions-style-fold').click()
  await page.getByTestId('caption-style-length-fixed').click()
  await typeNumber(page, 'caption-style-words', '3')
  await typeNumber(page, 'caption-style-size', '140')

  await page.getByTestId('caption-style-save-new').click()
  await page.getByTestId('name-prompt-input').fill('Big three')
  await page.getByTestId('name-prompt-save').click()
  await expect(page.getByTestId('caption-style-select')).toHaveValue(/^cs-/)
  await expect(page.getByTestId('caption-style-select').locator('option:checked')).toHaveText('Big three')

  await page.getByTestId('caption-style-apply-all').click()
  await expect.poll(async () => (await captions(page)).map((c) => c.text)).toEqual(['so we went', 'to the store'])
  expect((await captions(page)).every((c) => c.fontSizePx === 140)).toBe(true)
  await expect(page.getByTestId('caption-row')).toHaveCount(2)

  // One undo puts the old captions back.
  await undo(page)
  expect(await captions(page)).toHaveLength(before)

  // And the style outlives a restart.
  await page.reload()
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('captions-default-style').locator('option', { hasText: 'Big three' })).toHaveCount(1)
})

test('Caption every clip uses the default style, its length and its size', async ({ page }) => {
  await page.goto('/')
  // A style he made earlier: two words a caption, big.
  await page.evaluate(async () => {
    const mod = '/src/state/captionStyles.ts'
    const { saveNewCaptionStyle } = (await import(/* @vite-ignore */ mod)) as { saveNewCaptionStyle: (d: unknown) => unknown }
    saveNewCaptionStyle({
      name: 'Pairs',
      look: { fontSizePx: 150 },
      refHeight: 1080,
      shape: { length: 'fixed', maxWords: 2, charsPerLine: 30, lines: 1, minDurS: 0.2, gapFrames: 0 },
      emphasisColor: '#FFD400',
    })
  })
  await seedSoundClips(page, [0, 4])
  await standInEars(page)

  await page.getByTestId('tab-captions').click()
  // Picked as the default right where new captions are made.
  await page.getByTestId('captions-default-style').selectOption({ label: 'Pairs' })
  await expect(page.getByTestId('captions-style-current')).toHaveText('Pairs')

  await page.getByTestId('captions-auto-all').click()
  await expect(page.getByTestId('captions-job')).toBeVisible()
  await expect(page.getByTestId('captions-job-queue')).toContainText('of 2')
  await expect.poll(async () => (await captions(page)).length, { timeout: 15_000 }).toBeGreaterThan(0)

  const got = await captions(page)
  expect(got.map((c) => c.text)).toEqual(['alphac0 bravoc0', 'charliec0', 'alphac4 bravoc4', 'charliec4'])
  expect(got.every((c) => c.fontSizePx === 150)).toBe(true)
  await expect(page.getByTestId('caption-row')).toHaveCount(4)
})

test('the caption list jumps the playhead on a click, finds by search, and edits in place', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const capMod = '/src/state/captionActions.ts'
    const { addCaptionsFromWords } = (await import(/* @vite-ignore */ capMod)) as { addCaptionsFromWords: (w: unknown[]) => void }
    addCaptionsFromWords(
      ['first', 'second', 'third'].map((t, i) => ({ text: t, startS: i * 1, endS: i * 1 + 0.4 })),
    )
  })
  await page.getByTestId('tab-captions').click()
  const rows = page.getByTestId('caption-row')
  await expect(rows).toHaveCount(3)

  await rows.nth(2).locator('span').first().click()
  const playhead = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { ui: { playheadS: number } } } }
    return useStore.getState().ui.playheadS
  })
  expect(playhead).toBeCloseTo(2, 3)
  await expect(rows.nth(2)).toHaveAttribute('data-active', 'true')

  await page.getByTestId('captions-search').fill('sec')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('captions-count')).toHaveText('1 of 3')

  const field = rows.first().getByTestId('caption-row-text')
  await field.fill('2nd')
  await field.press('Enter')
  await page.getByTestId('captions-search').fill('')
  await expect.poll(async () => (await captions(page)).map((c) => c.text)).toEqual(['first', '2nd', 'third'])
})
