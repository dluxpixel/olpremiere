import { expect, test, type Page } from '@playwright/test'

// His ask, 2026-08-05: *"I have a lot of projects that I finished that I just
// don't want to delete because, why the hell would I delete them for no reason,
// right?"* So finished work gets filed, never deleted, behind its own toolbar
// button next to Projects.
//
// The thing this spec exists to guarantee is the promise the feature makes: an
// archived project is STILL THERE. Anything can hide a row; only opening it
// again proves nothing was lost.

async function newNamedProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('open-projects').click()
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
  await page.evaluate(async (name: string) => {
    const mod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ mod)) as {
      useStore: { getState: () => { dispatch: (label: string, fn: (p: unknown) => unknown) => void } }
    }
    useStore.getState().dispatch('Rename project', (p) => ({ ...(p as object), name }))
  }, name)
}

test('a finished project is filed away, still there, and comes back', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()

  // Two projects, so one can be archived while the other stays open. The open
  // one is deliberately NOT archivable, same rule as delete.
  await newNamedProject(page, 'Finished edit')
  await newNamedProject(page, 'Current edit')

  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  const finishedRow = dialog.locator('[data-testid="project-row"]', { hasText: 'Finished edit' })
  await expect(finishedRow).toHaveCount(1)

  await finishedRow.getByTestId('project-archive').click()
  // Gone from the list he works from...
  await expect(dialog.locator('[data-testid="project-row"]', { hasText: 'Finished edit' })).toHaveCount(0)

  // ...and present in the finished one, which is the whole promise.
  await page.getByTestId('projects-tab-archived').click()
  const archivedRow = dialog.locator('[data-testid="project-row"]', { hasText: 'Finished edit' })
  await expect(archivedRow).toHaveCount(1)

  // It OPENS. Hiding a row is easy; proving the edit survived is the point.
  await archivedRow.getByTestId('project-open').click()
  await expect(page.getByTestId('projects-dialog')).toHaveCount(0)
  await expect(page.getByTestId('panel-left')).toBeVisible()

  // And it can be put back, so archiving is never a one-way door.
  await page.getByTestId('open-archived').click()
  await expect(page.getByTestId('projects-tab-archived')).toHaveAttribute('aria-pressed', 'true')
})

test('the archive button opens straight onto finished work', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await page.getByTestId('open-archived').click()
  await expect(page.getByTestId('projects-dialog')).toBeVisible()
  await expect(page.getByTestId('projects-tab-archived')).toHaveAttribute('aria-pressed', 'true')
  // Empty to begin with, and it says so rather than looking broken.
  await expect(page.getByTestId('projects-dialog')).toContainText('Nothing finished yet')
})
