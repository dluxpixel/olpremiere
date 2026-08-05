import { expect, test, type Page } from '@playwright/test'

// Dragging the playhead used to be silent, so finding the end of a sentence
// meant playing past it and coming back. It now fires short grains of the real
// audio under the playhead.
//
// A unit test can prove WHICH clip should sound; only a real browser can prove
// that a real drag reaches Web Audio at all. So this spec counts actual
// createBufferSource calls, which is the one thing that cannot be faked by the
// scheduling logic being right.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __grains?: number }
    w.__grains = 0
    const proto = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      .prototype
    const real = proto.createBufferSource
    proto.createBufferSource = function (this: AudioContext) {
      w.__grains = (w.__grains ?? 0) + 1
      return real.call(this)
    }
  })
})

const FIXTURE = 'e2e/.fixtures/clip.webm'

const grains = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __grains: number }).__grains)

/** Drag left to right across the ruler, the way you hunt for a cut. */
async function dragRuler(page: Page, steps = 14): Promise<void> {
  const ruler = page.getByTestId('ruler')
  const box = (await ruler.boundingBox())!
  const y = box.y + box.height / 2
  const from = box.x + 20
  const to = box.x + Math.min(box.width - 20, 320)
  await page.mouse.move(from, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from + ((to - from) * i) / steps, y)
    // Slower than the grain throttle, so a real drag is simulated rather than
    // one instant jump that would fire a single grain and prove nothing.
    await page.waitForTimeout(70)
  }
}

async function addClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
}

test('dragging the playhead makes sound, and letting go stops it', async ({ page }) => {
  await addClip(page)
  expect(await grains(page)).toBe(0) // nothing has played yet

  await dragRuler(page)
  const during = await grains(page)
  // A drag longer than the throttle must produce SEVERAL grains, not one.
  expect(during).toBeGreaterThan(3)

  await page.mouse.up()
  const atRelease = await grains(page)
  await page.waitForTimeout(400)
  // Release means silence: no grain may fire after the pointer is up.
  expect(await grains(page)).toBe(atRelease)
})

test('a muted track scrubs silent, exactly like it plays silent', async ({ page }) => {
  await addClip(page)
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    updateActiveSequence('mute all', (s) => {
      const seq = s as { tracks: { muted: boolean }[] }
      return { ...seq, tracks: seq.tracks.map((t) => ({ ...t, muted: true })) }
    })
  })

  await dragRuler(page, 10)
  await page.mouse.up()
  expect(await grains(page)).toBe(0)
})
