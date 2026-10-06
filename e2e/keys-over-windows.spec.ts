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
}

async function editState(page: Page): Promise<EditState> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; ui: { selection: string[]; playheadS: number; playing: boolean } } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { fps: number; tracks: { clips: unknown[] }[] }
    }
    const s = useStore.getState()
    const seq = activeSequence(s.project)
    return {
      clips: seq.tracks.reduce((n, t) => n + t.clips.length, 0),
      selected: s.ui.selection.length,
      playheadS: s.ui.playheadS,
      playing: s.ui.playing,
      fps: seq.fps,
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
