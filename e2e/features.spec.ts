// Feature batch: a discoverable Text button, opacity fades for visual clips, and
// a save/open-project-file backup that survives even an IndexedDB wipe.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/features'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function importClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
}

test('the Media-panel Text button adds a title clip', async ({ page }) => {
  await importClip(page)
  await page.getByTestId('add-title').click()
  const hasTitle = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { clips: { title?: unknown }[] }[] }
    }
    const seq = activeSequence(useStore.getState().project)
    return seq.tracks.flatMap((t) => t.clips).some((c) => c.title !== undefined)
  })
  expect(hasTitle).toBe(true)
})

test('a video clip now exposes a fade handle (fades for pictures/video)', async ({ page }) => {
  await importClip(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  // The handle lives INSIDE the video clip. Before this feature it was audio-only,
  // so a video clip had none.
  await expect(page.locator('[data-clip-kind="video"]').getByTestId('fade-in-handle')).toHaveCount(1)
})

test('save a project to a file and open it back (backup round-trip)', async ({ page }) => {
  // Force the download fallback: a real save picker can't be driven headless
  // (same pattern as the export specs). The picker path shares the same Blob.
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
  await importClip(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('project-name').fill('BackupTest')
  await page.getByTestId('project-name').press('Enter')

  // Save → capture the download (v2 binary container).
  const dl = page.waitForEvent('download')
  await page.getByTestId('save-project-file').click()
  const download = await dl
  const path = `${VERIFY}/backup.olstudio`
  await download.saveAs(path)
  expect(fs.statSync(path).size).toBeGreaterThan(1000) // bundles media, so it's real
  // v2 magic at byte 0 — the binary format, not a JSON monolith.
  const first8 = fs.readFileSync(path).subarray(0, 8).toString('ascii')
  expect(first8).toBe('OLSTPROJ')

  // Wreck the current project, then restore from the file.
  await page.getByTestId('project-name').fill('WRECKED')
  await page.getByTestId('project-name').press('Enter')

  await page.getByTestId('open-project-input').setInputFiles(path)
  await expect(page.getByText(/Opened "BackupTest"/)).toBeVisible({ timeout: 15_000 })

  // Restored: name back, the clip present, and the media usable (asset back in the bin).
  await expect(page.getByTestId('project-name')).toHaveValue('BackupTest')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
})

test('a legacy v1 (.olstudio.json) project file still opens', async ({ page }) => {
  await importClip(page)
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Wrap the CURRENT project in the old JSON envelope (no bundled media) —
  // exactly what a pre-v2 backup file looks like.
  const project = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { name: string } } }
    }
    return useStore.getState().project
  })
  const v1Path = `${VERIFY}/legacy.olstudio.json`
  fs.writeFileSync(
    v1Path,
    JSON.stringify({
      format: 'olstudio-project',
      version: 1,
      project: { ...project, name: 'LegacyV1' },
      blobs: [],
    }),
  )

  await page.getByTestId('open-project-input').setInputFiles(v1Path)
  await expect(page.getByText(/Opened "LegacyV1"/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('project-name')).toHaveValue('LegacyV1')
})
