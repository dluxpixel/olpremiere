import { expect, test } from '@playwright/test'

// ⛔ THE ONE THAT PROTECTS HIS FOOTAGE, DRIVEN END TO END.
//
// FOUND ON HIS SCREEN, 2026-08-22. The automatic recovery put six projects on his
// shelf, five of them junk, and every one of them pointed at the SAME media: a
// restored project keeps its assets exactly as they were, same asset ids and same
// blobKeys, because the bytes are shared and must not be copied. Deleting a
// project deleted the media of every asset in it, with no check on whether
// anything else still wanted those bytes. So the row he would most want to bin
// was exactly the one sharing with his real 44 clip edit.
//
// `blobKeysOnlyUsedBy` is unit tested, but the thing that would have cost him his
// footage is the whole path: a real import, a real second project, a real delete
// through the dialog he actually clicks, and the bytes still being there
// afterwards. Only this says that out loud.

const FIXTURE = 'e2e/.fixtures/clip.webm'

test('deleting one project leaves the media the other one shares', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()

  // A real import, so the blob is really in storage under a real key.
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })

  // A second project holding the SAME assets, which is exactly what the recovery
  // lands: fresh project id, fresh sequence ids, assets untouched.
  const keys = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const persistMod = '/src/state/persistence.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: Record<string, unknown> } }
    }
    const { saveProject } = (await import(/* @vite-ignore */ persistMod)) as {
      saveProject: (p: unknown) => Promise<void>
    }
    const mine = useStore.getState().project as {
      id: string
      assets: Record<string, { blobKey: string }>
      sequences: Record<string, unknown>
    }
    // Both must be IN the store, because that is where the check looks. The app
    // autosaves his open one; doing it here explicitly stops this racing the
    // timer rather than testing the rule.
    await saveProject(mine)
    const twin = { ...mine, id: `twin-${mine.id}`, name: 'Untitled Project (recovered)' }
    await saveProject(twin)
    return { mineId: mine.id, twinId: twin.id, blobKeys: Object.values(mine.assets).map((a) => a.blobKey) }
  })
  expect(keys.blobKeys.length).toBeGreaterThan(0)

  // Delete the twin through the door he actually uses. It arms on the first
  // click and goes on the second, so a slip cannot cost him a project.
  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  const twinRow = dialog.locator('[data-testid="project-row"]', { hasText: 'Untitled Project (recovered)' })
  await expect(twinRow).toHaveCount(1)
  const del = twinRow.getByTestId('project-delete')
  await del.click()
  await expect(del).toHaveAttribute('aria-label', 'Confirm delete')
  await del.click()
  await expect(dialog.locator('[data-testid="project-row"]', { hasText: 'Untitled Project (recovered)' })).toHaveCount(0)

  // ⛔ THE ASSERTION THAT MATTERS. The bytes his own project still points at are
  // still there. Before this was fixed they were gone, silently, and he would
  // have found out the next time he opened his edit.
  const stillThere = await page.evaluate(async (blobKeys: string[]) => {
    const persistMod = '/src/state/persistence.ts'
    const { getBlob } = (await import(/* @vite-ignore */ persistMod)) as {
      getBlob: (k: string) => Promise<Blob | null>
    }
    const sizes: number[] = []
    for (const k of blobKeys) sizes.push((await getBlob(k))?.size ?? 0)
    return sizes
  }, keys.blobKeys)

  for (const size of stillThere) expect(size).toBeGreaterThan(0)
})
