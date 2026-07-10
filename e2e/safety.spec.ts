// Safety guards: a locked track really protects its clips from keyboard verbs,
// destructive bin-delete offers Undo, and undo/redo say what they changed.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/clip.webm'

async function importAndPlace(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
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
      activeSequence: (p: unknown) => { tracks: { kind: string; clips: { id: string }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    const id = seq.tracks.find((t) => t.kind === 'video')!.clips[0].id
    useStore.getState().setUI({ selection: [id] })
    return id
  })
}

async function lockClipTrack(page: Page, clipId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore, updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { id: string; tracks: { clips: { id: string }[]; locked: boolean }[] }
    }
    const seq = activeSequence(useStore.getState().project) as {
      tracks: { clips: { id: string }[]; locked: boolean }[]
    }
    const trackIdx = seq.tracks.findIndex((t) => t.clips.some((c) => c.id === id))
    updateActiveSequence('lock', (s) => {
      const sq = s as { tracks: { clips: { id: string }[]; locked: boolean }[] }
      return {
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === trackIdx ? { ...t, locked: true } : t)),
      }
    })
  }, clipId)
}

async function clipCount(page: Page): Promise<number> {
  return page.locator('[data-clip-kind="video"]').count()
}

test('a locked track protects its clip from keyboard Delete', async ({ page }) => {
  const id = await importAndPlace(page)
  await lockClipTrack(page, id)
  // The clip is still selected (inspecting locked clips is allowed)...
  await page.keyboard.press('Delete')
  await page.keyboard.press('Shift+Delete') // ripple delete too
  // ...but neither delete may remove it.
  expect(await clipCount(page)).toBe(1)
})

test('a locked track protects its clip from Cut', async ({ page }) => {
  const id = await importAndPlace(page)
  await lockClipTrack(page, id)
  await page.keyboard.press('Control+x')
  expect(await clipCount(page)).toBe(1)
})

test('an unlocked clip CAN still be deleted (guard is not over-broad)', async ({ page }) => {
  await importAndPlace(page)
  await page.keyboard.press('Delete')
  expect(await clipCount(page)).toBe(0)
})

test('deleting an asset from the bin offers a working Undo', async ({ page }) => {
  await importAndPlace(page)
  expect(await clipCount(page)).toBe(1)

  await page.getByTestId('asset-card').click({ button: 'right' })
  await page.getByText('Delete from bin').click()

  // The clip vanished from the timeline AND the asset from the bin.
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  expect(await clipCount(page)).toBe(0)

  // The toast's Undo button brings both back.
  await page.getByTestId('toast-action').click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  expect(await clipCount(page)).toBe(1)
})

test('undo announces what it reverted', async ({ page }) => {
  await importAndPlace(page)
  await page.keyboard.press('Delete') // "Delete clip(s)" or similar label
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('toast').filter({ hasText: /Undo:/ })).toBeVisible()
})

test('the ? key opens the keyboard help overlay', async ({ page }) => {
  await page.goto('/')
  // Click a neutral panel first: this both moves focus off any field AND lets
  // the keymap's mount effect install before we press (a bare press right after
  // goto can beat it).
  await page.getByTestId('panel-left').click({ position: { x: 5, y: 5 } })
  // '?' is synthesised as the produced character, matching real keyboards.
  await page.keyboard.press('?')
  await expect(page.getByTestId('keyboard-help')).toBeVisible()
})
