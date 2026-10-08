import { expect, test, type Page } from '@playwright/test'

// THE KEYS GO WHERE HE IS LOOKING, AT HIS OWN WINDOW SIZE (2026-10-06).
//
// With Projects open and a clip selected, Delete took the clip off the timeline behind the
// window, Space played behind Settings, and no window took the focus at all. These drive the
// real app at 1920x1080, the size he works at.

const FIXTURE = 'e2e/.fixtures/clip.webm'

test.use({ viewport: { width: 1920, height: 1080 } })

interface EditState {
  clips: number
  selected: number
  playheadS: number
  playing: boolean
  fps: number
  gains: number[]
  undo: string[]
}

async function editState(page: Page): Promise<EditState> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => {
          project: unknown
          history: { undo: { label: string }[] }
          ui: { selection: string[]; playheadS: number; playing: boolean }
        }
      }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { fps: number; tracks: { clips: { audioGainDb: number }[] }[] }
    }
    const s = useStore.getState()
    const seq = activeSequence(s.project)
    return {
      clips: seq.tracks.reduce((n, t) => n + t.clips.length, 0),
      selected: s.ui.selection.length,
      playheadS: s.ui.playheadS,
      playing: s.ui.playing,
      fps: seq.fps,
      gains: seq.tracks.flatMap((t) => t.clips.map((c) => c.audioGainDb)),
      undo: s.history.undo.map((c) => c.label),
    }
  })
}

/** One video clip on the timeline (with its sound on a second track), selected. */
async function bootWithSelectedClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  const clip = page.locator('[data-clip-kind="video"]')
  await expect(clip).toHaveCount(1)
  await clip.click()
  await expect.poll(async () => (await editState(page)).selected).toBeGreaterThan(0)
}

test('Delete, Space and Ctrl+Z with Projects open leave the edit behind it alone', async ({ page }) => {
  await bootWithSelectedClip(page)
  const before = await editState(page)

  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  // The window has the keyboard, not the button that opened it.
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Space')
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('c')
  await page.waitForTimeout(200)
  const during = await editState(page)
  expect(during.clips).toBe(before.clips)
  expect(during.selected).toBe(before.selected)
  expect(during.playing).toBe(false)

  // Escape still closes it, and the focus goes back to the Projects button.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('open-projects')).toBeFocused()
  // The clip is still selected after that Escape, and Delete works on the edit again.
  expect((await editState(page)).selected).toBe(before.selected)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await editState(page)).clips).toBeLessThan(before.clips)
})

test('Settings takes the keyboard when it opens, and Space behind it does not play', async ({ page }) => {
  await bootWithSelectedClip(page)
  await page.getByTestId('settings-open').click()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Space')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  const s = await editState(page)
  expect(s.playing).toBe(false)
  expect(s.clips).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('settings-open')).toBeFocused()
})

// 2026-10-07: Ctrl+V was the one edit key that still reached the edit behind a window. The browser's
// paste event pasted his copied clips at the playhead behind Projects, and in Captions, "Paste a
// transcript", the clips went onto the timeline while his transcript never reached the box.
test('Ctrl+V with a window open pastes into its text box and never into the edit behind it', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  await bootWithSelectedClip(page)
  await page.keyboard.press('ControlOrMeta+c')
  const before = await editState(page)
  try {
    await page.getByTestId('open-projects').click()
    const projects = page.getByTestId('projects-dialog')
    await expect.poll(() => projects.evaluate((d) => d.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('ControlOrMeta+v')
    await page.waitForTimeout(300)
    let now = await editState(page)
    expect(now.clips).toBe(before.clips)
    expect(now.undo).toEqual(before.undo)
    await page.keyboard.press('Escape')
    await expect(projects).toHaveCount(0)

    // The transcript he copied from somewhere else, after the clips.
    const transcript = '1\n00:00:00,000 --> 00:00:01,000\nso here we go\n'
    await page.evaluate((t) => navigator.clipboard.writeText(t), transcript)
    await page.getByTestId('tab-captions').click()
    await page.getByTestId('captions-paste').click()
    const box = page.getByTestId('captions-text')
    await expect(box).toBeFocused()
    await page.keyboard.press('ControlOrMeta+v')
    await expect(box).toHaveValue(transcript)
    await page.waitForTimeout(300)
    now = await editState(page)
    expect(now.clips).toBe(before.clips)
    expect(now.undo).toEqual(before.undo)
  } finally {
    // The headless browser's clipboard outlives the page: leave it empty for the next test.
    await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => undefined)
  }
})

// After he set a clip's volume with the slider, the slider kept the focus and every key: the two
// taps of Right he meant as "two frames on" turned the volume up as an undo step, and Space did
// not play. A clicked control gives the keys back to the edit.
test('after a click on the clip volume slider, Right steps frames and Space plays', async ({ page }) => {
  await bootWithSelectedClip(page)
  // From the start, so a play has room to run on the 2 second clip.
  await page.keyboard.press('Home')
  const slider = page.getByTestId('clip-volume-slider').first()
  await expect(slider).toBeVisible()
  await slider.click()
  await expect(slider).toBeFocused()
  const before = await editState(page)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  const after = await editState(page)
  expect(after.gains).toEqual(before.gains)
  expect(after.undo).toEqual(before.undo)
  expect(after.playheadS).toBeCloseTo(before.playheadS + 2 / before.fps, 6)

  await page.keyboard.press('Space')
  await expect.poll(async () => (await editState(page)).playheadS).toBeGreaterThan(after.playheadS + 0.2)
  await page.keyboard.press('Space')
})

// The other way round: inside the OPEN aspect list, the arrows walked the timeline instead of the
// list, and Escape closed the list AND let go of his clip.
test('inside the open aspect list the arrows move the list and Escape only closes it', async ({ page }) => {
  await bootWithSelectedClip(page)
  const select = page.getByTestId('format-select')
  await select.click()
  await expect.poll(() => select.evaluate((el) => el.matches(':open'))).toBe(true)
  const focused = () => page.evaluate(() => (document.activeElement as HTMLOptionElement | null)?.value ?? null)
  const first = await focused()

  await page.keyboard.press('ArrowDown')
  await expect.poll(focused).not.toBe(first)
  expect((await editState(page)).selected).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect.poll(() => select.evaluate((el) => el.matches(':open'))).toBe(false)
  expect((await editState(page)).selected).toBeGreaterThan(0)
})
