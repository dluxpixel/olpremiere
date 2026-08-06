// Delete removes WHAT YOU PICKED, and the menu item says which half that is.
//
// HIS WORDS, 2026-08-06: "when I right-click a video clip and click Delete, it
// deletes the audio too. When did I ever say you could do that?"
//
// This spec used to pin the opposite, and the opposite was never consistent:
// the audio half deleted alone but the video half took BOTH, so one key did two
// different things depending on which lane you happened to click, and the
// destructive one was the unlabelled case.

import { expect, test, type Page } from '@playwright/test'

async function bootPair(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  // A video WITH audio drops as a linked pair: video on V1, audio on A1.
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
}

test('the menu names the half it will remove: "Delete video" on the video clip', async ({ page }) => {
  await bootPair(page)
  await page.locator('[data-clip-kind="video"]').click({ button: 'right', position: { x: 20, y: 10 } })
  const menu = page.getByTestId('context-menu')
  await expect(menu.getByRole('menuitem', { name: /delete/i })).toHaveCount(2)
  await expect(menu.getByRole('menuitem', { name: 'Delete video' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Ripple delete/ })).toBeVisible()

  // And it does exactly that: the sound stays.
  await menu.getByRole('menuitem', { name: 'Delete video' }).click()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
})

test('the menu reads "Delete audio" on the audio half, and leaves the picture', async ({ page }) => {
  await bootPair(page)
  await page.locator('[data-clip-kind="audio"]').click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu.getByRole('menuitem', { name: 'Delete audio' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Delete audio' }).click()
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('Del removes only the half that is selected, whichever half that is', async ({ page }) => {
  await bootPair(page)
  // The AUDIO half.
  await page.locator('[data-clip-kind="audio"]').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Undo, then the VIDEO half. This is the one he reported.
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
  await page.locator('[data-clip-kind="video"]').click({ position: { x: 20, y: 10 } })
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1)
})

test('selecting both halves and pressing Del still removes the pair in one go', async ({ page }) => {
  await bootPair(page)
  await page.locator('[data-clip-kind="video"]').click({ position: { x: 20, y: 10 } })
  await page.locator('[data-clip-kind="audio"]').click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(0)
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)
})

// HIS WORDS, 2026-08-06: "when I start recording audio, it starts playing the
// video clip. That's nice, but when I delete that audio, it goes back to a
// starting point so I can instantly rerecord."
test('deleting one audio clip parks the playhead where it started, ready to record again', async ({ page }) => {
  await bootPair(page)
  const startS = await page.evaluate(async () => {
    type Clip = { id: string; startS: number }
    type Track = { kind: string; clips: Clip[] }
    type Seq = { tracks: Track[] }
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown; setUI: (p: unknown) => void } }
      updateActiveSequence: (label: string, fn: (seq: Seq) => Seq) => void
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => Seq
    }
    // Put the take where a real one lands: partway in, not at zero.
    updateActiveSequence('move for test', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.kind === 'audio' ? { ...t, clips: t.clips.map((c) => ({ ...c, startS: 3 })) } : t,
      ),
    }))
    useStore.getState().setUI({ playheadS: 7 })
    const audio = activeSequence(useStore.getState().project).tracks.find((t) => t.kind === 'audio')
    return audio?.clips[0]?.startS ?? -1
  })
  expect(startS).toBe(3)

  await page.locator('[data-clip-kind="audio"]').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(0)

  const playhead = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
    return useStore.getState().ui.playheadS
  })
  expect(playhead).toBeCloseTo(3, 3)
})

test('deleting a VIDEO clip leaves the playhead alone', async ({ page }) => {
  await bootPair(page)
  const readPlayhead = () =>
    page.evaluate(async () => {
      const storeMod = '/src/state/store.ts'
      const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
      return useStore.getState().ui.playheadS
    })
  // Clicking a clip moves the playhead there (Vegas-style), so the baseline has
  // to be read AFTER the click or this measures the click, not the delete.
  await page.locator('[data-clip-kind="video"]').click({ position: { x: 20, y: 10 } })
  const before = await readPlayhead()
  await page.keyboard.press('Delete')
  expect(await readPlayhead()).toBeCloseTo(before, 3)
})
