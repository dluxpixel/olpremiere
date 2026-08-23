import { expect, test } from '@playwright/test'

// ⛔ HIS WORDS, 2026-08-23, after five days of not opening the app: *"The
// recovered file doesn't even fucking work. The audio is not there, and the
// video isn't."*
//
// A project whose asset records survived while their bytes did not draws as a
// timeline of named clips with no picture and no sound. Importing the files
// again would make NEW assets, so every one of his cuts would still point at
// nothing. This drives the way back: the bytes go under the key the edit already
// uses, and the clips never move.

const FIXTURE = 'e2e/.fixtures/clip.webm'

test('media that lost its bytes can be put back without touching the edit', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()

  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

  // Nothing is wrong yet, so the way back must not be on screen.
  await expect(page.getByTestId('find-my-media')).toHaveCount(0)

  // Take the bytes away, exactly as a rebuilt store does: the record stays, the
  // blob goes.
  const before = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const persistMod = '/src/state/persistence.ts'
    interface Doc {
      assets: Record<string, { id: string; name: string; blobKey: string }>
      sequences: Record<string, { tracks: { clips: unknown[] }[] }>
    }
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: Doc } }
    }
    const { deleteBlob } = (await import(/* @vite-ignore */ persistMod)) as { deleteBlob: (k: string) => Promise<void> }
    const p = useStore.getState().project
    const a = Object.values(p.assets)[0]
    const clips = Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))
    await deleteBlob(a.blobKey)
    return { id: a.id, name: a.name, blobKey: a.blobKey, clipCount: clips.length }
  })

  // Leave the media panel and come back, which mounts it fresh the same way
  // opening the app does. That mount is where it looks, so this is the real path.
  await page.getByRole('tab', { name: 'Effects' }).click()
  await page.getByRole('tab', { name: 'Media' }).click()

  // The banner appears on its own, because it asks storage rather than a flag.
  await expect(page.getByTestId('find-my-media')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('find-my-media')).toContainText('no media')

  await page.getByTestId('find-my-media-input').setInputFiles(FIXTURE)

  // ⛔ THE TWO THINGS THAT MATTER. The bytes are back UNDER THE SAME KEY, and the
  // clip on his timeline never moved.
  await expect
    .poll(
      async () =>
        page.evaluate(async (key: string) => {
          const persistMod = '/src/state/persistence.ts'
          const { getBlob } = (await import(/* @vite-ignore */ persistMod)) as {
            getBlob: (k: string) => Promise<Blob | null>
          }
          return (await getBlob(key))?.size ?? 0
        }, before.blobKey),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0)

  const after = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => {
          project: {
            assets: Record<string, { id: string; blobKey: string }>
            sequences: Record<string, { tracks: { clips: { id: string; assetId: string }[] }[] }>
          }
        }
      }
    }
    const p = useStore.getState().project
    const a = Object.values(p.assets)[0]
    const clips = Object.values(p.sequences).flatMap((s) => s.tracks.flatMap((t) => t.clips))
    return { assetId: a.id, blobKey: a.blobKey, clipCount: clips.length, pointsAt: clips[0]?.assetId }
  })
  expect(after.assetId).toBe(before.id)
  expect(after.blobKey).toBe(before.blobKey)
  // Not a fixed number: what matters is that NOTHING moved.
  expect(after.clipCount).toBe(before.clipCount)
  expect(after.pointsAt).toBe(before.id)

  // And the way back goes away once there is nothing left to fix.
  await expect(page.getByTestId('find-my-media')).toHaveCount(0, { timeout: 10_000 })
})
