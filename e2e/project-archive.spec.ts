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

  // Two projects, so one can be archived while the other stays open.
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

// His ask, 2026-08-14: *"Make it so that the archive, later, and delete button
// is visible when you hover your mouse over the clip, even if the clip is
// opened."* They used to be missing from the open row entirely, so filing away
// the thing he was working on meant opening something else first.
//
// ⛔ toBeVisible() is NOT the assertion here. These buttons sit at opacity 0
// until the row is hovered, and Playwright calls an opacity-0 element visible.
// So the opacity is read for real, before and after the hover.
test('the open project gets the same hover buttons as every other row', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await newNamedProject(page, 'Other edit')
  await newNamedProject(page, 'The open one')

  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  // The open row is the one with no Open button on it, which is what being open
  // MEANS here. Its name is not usable: the last rename is still only in memory,
  // so the list still shows the saved one.
  const openRow = dialog
    .locator('[data-testid="project-row"]')
    .filter({ hasNot: page.getByTestId('project-open') })
  await expect(openRow).toHaveCount(1)

  // They EXIST on the open row now. This is the half that was simply absent.
  const archive = openRow.getByTestId('project-archive')
  const park = openRow.getByTestId('project-park')
  const del = openRow.getByTestId('project-delete')
  await expect(archive).toHaveCount(1)
  await expect(park).toHaveCount(1)
  await expect(del).toHaveCount(1)

  // Hidden until he points at the row...
  const opacity = (l: typeof archive) => l.evaluate((el) => getComputedStyle(el).opacity)
  expect(Number(await opacity(archive))).toBeLessThan(0.5)

  // ...and there when he does, which is the whole ask.
  await openRow.hover()
  await expect.poll(async () => Number(await opacity(archive))).toBe(1)
  expect(Number(await opacity(park))).toBe(1)
  expect(Number(await opacity(del))).toBe(1)

  // And it WORKS on the open project rather than refusing: it moves to finished
  // while the editor behind the dialog keeps that project open.
  // Tracked by the same "no Open button on it" identity, not by name: two of
  // these projects carry the stock name and a name match would hit both.
  await archive.click()
  await expect(openRow).toHaveCount(0)
  await page.getByTestId('projects-tab-archived').click()
  await expect(openRow).toHaveCount(1)
})
