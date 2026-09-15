// The Words tab: select words, press Delete, and that stretch of the edit is
// gone in one undo step.
//
// The recogniser is far too heavy for a browser test, so the words are seeded
// onto the media the way a listening would leave them (source seconds), and the
// test covers everything after that: the reading in timeline order, drag to
// select, the cut on the timeline itself, and one Ctrl+Z bringing it all back.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

interface Row {
  startS: number
  inS: number
  outS: number
}

async function clips(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as { useStore: { getState: () => { project: unknown } } }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: Row[] }[] }
    }
    return activeSequence(useStore.getState().project)
      .tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips.map((c) => ({ startS: c.startS, inS: c.inS, outS: c.outS })))
  })
}

/** Six evenly spaced words across the only asset, as a listening would have left them. */
async function seedWords(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => {
          project: { assets: Record<string, { id: string; durationS: number }> }
          dispatch: (label: string, fn: (p: unknown) => unknown) => void
        }
      }
    }
    const s = useStore.getState()
    const asset = Object.values(s.project.assets)[0]
    const step = asset.durationS / 6
    const words = ['one', 'two', 'three', 'four', 'five', 'six'].map((text, i) => ({
      text,
      startS: i * step + step * 0.1,
      endS: i * step + step * 0.6,
    }))
    s.dispatch('seed words', (p) => {
      const proj = p as { assets: Record<string, object> }
      return { ...proj, assets: { ...proj.assets, [asset.id]: { ...proj.assets[asset.id], words } } }
    })
    return asset.durationS
  })
}

test('drag across two words, press Delete, and that stretch leaves the timeline; Ctrl+Z brings it back', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
  const durationS = await seedWords(page)

  await page.getByRole('tab', { name: 'Words' }).click()
  await expect(page.getByTestId('words-clip')).toHaveCount(1)
  const words = page.getByTestId('word')
  await expect(words).toHaveCount(6)
  await expect(page.getByTestId('cut-words')).toBeDisabled()

  const before = await clips(page)
  const two = (await words.nth(1).boundingBox())!
  const three = (await words.nth(2).boundingBox())!
  await page.mouse.move(two.x + two.width / 2, two.y + two.height / 2)
  await page.mouse.down()
  await page.mouse.move(three.x + three.width / 2, three.y + three.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('[data-testid="word"][data-selected]')).toHaveCount(2)
  await expect(page.getByTestId('cut-words')).toHaveText(/Cut 2 words/)

  await page.keyboard.press('Delete')

  // "two" and "three" are gone and the words after them moved up to where "two" started.
  await expect(words).toHaveCount(4)
  await expect(words).toHaveText(['one', 'four', 'five', 'six'])
  const step = durationS / 6
  const fourAt = Number(await words.nth(1).getAttribute('data-at'))
  expect(fourAt).toBeCloseTo(step * 1.1, 1)

  // On the timeline: the clip is now two pieces meeting where the cut was, and
  // the second piece still shows the source from "four" onward.
  const after = await clips(page)
  expect(after).toHaveLength(2)
  expect(after[0].startS).toBe(0)
  expect(after[1].startS).toBeCloseTo(after[0].outS - after[0].inS, 1)
  expect(after[1].inS).toBeGreaterThan(after[0].outS)
  expect(after[1].outS).toBeCloseTo(before[0].outS, 3)

  // The timeline itself has fewer seconds on it, and one undo restores the lot.
  await page.keyboard.press('Control+z')
  await expect(words).toHaveCount(6)
  expect(await clips(page)).toEqual(before)
})
