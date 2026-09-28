// Ctrl+V pastes a picture from the system clipboard, and asks first whether to
// keep its background. His words, 2026-09-28: *"Make it so I can just paste
// pictures"*, and asked how, he picked: ask on every paste.
//
// The unit tests prove the rules. This proves the one thing they cannot: that a
// REAL Ctrl+V in Chromium still fires the paste event that carries the picture,
// now that the key no longer blocks the browser's own paste. Playwright's
// headless shell keeps its own clipboard, so none of this touches his.

import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5178' })
})

/** Put a small red PNG on the clipboard, the way a screenshot tool would. */
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

async function setPlayhead(page: Page, s: number): Promise<void> {
  await page.evaluate(async (at) => {
    const mod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ mod)) as {
      useStore: { getState: () => { setUI: (p: unknown) => void } }
    }
    useStore.getState().setUI({ playheadS: at })
  }, s)
}

interface PlacedClip {
  id: string
  startS: number
  trackIndex: number
  selected: boolean
}

async function imageClips(page: Page): Promise<PlacedClip[]> {
  return page.evaluate(async () => {
    const mod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ mod)) as {
      useStore: {
        getState: () => {
          project: {
            activeSequenceId: string
            sequences: Record<string, { tracks: { clips: { id: string; assetId: string; startS: number }[] }[] }>
            assets: Record<string, { kind: string }>
          }
          ui: { selection: string[] }
        }
      }
    }
    const s = useStore.getState()
    const seq = s.project.sequences[s.project.activeSequenceId]!
    const out: PlacedClip[] = []
    seq.tracks.forEach((t, trackIndex) => {
      for (const c of t.clips) {
        if (s.project.assets[c.assetId]?.kind !== 'image') continue
        out.push({ id: c.id, startS: c.startS, trackIndex, selected: s.ui.selection.includes(c.id) })
      }
    })
    return out
  })
}

test('Ctrl+V with a copied picture asks, then lands it at the playhead, selected', async ({ page }) => {
  await page.goto('/')
  await copyPicture(page)
  await setPlayhead(page, 1)

  await page.keyboard.press('ControlOrMeta+v')
  const dialog = page.getByTestId('paste-picture-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('paste-picture-thumb')).toBeVisible()
  // The web build cannot start CutStudio, and says so instead of failing later.
  await expect(page.getByTestId('paste-picture-remove')).toBeDisabled()
  await expect(page.getByTestId('paste-picture-web')).toBeVisible()

  await page.getByTestId('paste-picture-keep').click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => imageClips(page).then((c) => c.length)).toBe(1)
  const [placed] = await imageClips(page)
  expect(placed!.startS).toBeCloseTo(1, 6)
  expect(placed!.selected).toBe(true)
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
})

test('copying clips after a picture makes Ctrl+V paste the clips, not the picture', async ({ page }) => {
  await page.goto('/')
  await copyPicture(page)
  await page.keyboard.press('ControlOrMeta+v')
  await page.getByTestId('paste-picture-keep').click()
  await expect.poll(() => imageClips(page).then((c) => c.length)).toBe(1)

  // The pasted picture is selected. Copy it: now clips are the newest copy.
  await page.keyboard.press('ControlOrMeta+c')
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('OL Premiere: 1 clip copied')

  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(() => imageClips(page).then((c) => c.length)).toBe(2)
  await expect(page.getByTestId('paste-picture-dialog')).toHaveCount(0)
  // Two clips at the same time never share a line: nothing was covered.
  const clips = await imageClips(page)
  expect(new Set(clips.map((c) => c.trackIndex)).size).toBe(2)
})

test('a paste into a text field stays in the field', async ({ page }) => {
  await page.goto('/')
  await copyPicture(page)
  const name = page.getByTestId('project-name')
  await name.click()
  await page.keyboard.press('ControlOrMeta+v')
  // Give the router its turn, then make sure nothing was offered.
  await page.waitForTimeout(300)
  await expect(page.getByTestId('paste-picture-dialog')).toHaveCount(0)
  expect(await imageClips(page)).toEqual([])
})

test('Escape cancels: nothing is imported or placed', async ({ page }) => {
  await page.goto('/')
  await copyPicture(page)
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByTestId('paste-picture-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('paste-picture-dialog')).toHaveCount(0)
  await expect(page.getByTestId('asset-card')).toHaveCount(0)
  expect(await imageClips(page)).toEqual([])
})
