import { expect, test, type Page } from '@playwright/test'

// DELETING PROJECTS WITHOUT THE DIALOG GOING AWAY, DRIVEN IN A REAL BROWSER (2026-10-03).
// His words: "make it so that when you double-click and delete something, it doesn't
// erase the screen. I don't want to click that again if I want to delete more projects."
//
// The trash button is two clicks (arm, then confirm), which a browser also reports as a
// double click on the row the button sits in, and a double click on a row opens its project.
// So the second click deleted the project, the row then opened it, the dialog closed and
// the project was written back. ProjectsDialogDelete.test.tsx pins the same thing in jsdom;
// this is the one that proves it with real events, a real IndexedDB and the real list.

/** Saves projects straight into storage, so the dialog has something real to list. */
async function seedProjects(page: Page, names: string[]): Promise<void> {
  await page.evaluate(async (names: string[]) => {
    const storeMod = '/src/state/store.ts'
    const persistMod = '/src/state/persistence.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: Record<string, unknown> } }
    }
    const { saveProject } = (await import(/* @vite-ignore */ persistMod)) as {
      saveProject: (p: unknown) => Promise<void>
    }
    const mine = useStore.getState().project as { id: string }
    await saveProject(mine)
    let n = 0
    for (const name of names) {
      n += 1
      await saveProject({ ...mine, id: `seed-${n}-${mine.id}`, name, updatedAt: Date.now() - n * 1000 })
    }
  }, names)
}

async function storedNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const persistMod = '/src/state/persistence.ts'
    const { listProjects } = (await import(/* @vite-ignore */ persistMod)) as {
      listProjects: () => Promise<{ name: string }[]>
    }
    return (await listProjects()).map((p) => p.name).sort()
  })
}

test('deleting two projects in a row keeps the dialog open and the list current', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await seedProjects(page, ['Bin one', 'Bin two', 'Keep three'])

  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  await expect(dialog).toBeVisible()
  const row = (name: string) => dialog.locator('[data-testid="project-row"]', { hasText: name })
  await expect(row('Bin one')).toHaveCount(1)
  await expect(row('Bin two')).toHaveCount(1)
  await expect(row('Keep three')).toHaveCount(1)

  // A real double click on the trash button: arm and confirm in one gesture.
  await row('Bin one').getByTestId('project-delete').dblclick()
  await expect(row('Bin one')).toHaveCount(0)
  await expect(dialog).toBeVisible()

  // The very next one, without opening anything again.
  await row('Bin two').getByTestId('project-delete').dblclick()
  await expect(row('Bin two')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(row('Keep three')).toHaveCount(1)

  // Really gone, and nothing opened them behind the delete: storage agrees with the list.
  await expect.poll(() => storedNames(page)).not.toContain('Bin one')
  expect(await storedNames(page)).not.toContain('Bin two')
  expect(await storedNames(page)).toContain('Keep three')
  // The project he had open is still the open one (no row was opened by the delete).
  await expect(dialog.locator('[data-testid="project-row"]').filter({ hasNot: page.getByTestId('project-open') })).toHaveCount(1)
})

test('the open project can be deleted from the same dialog, and the dialog stays for the next one', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('panel-left')).toBeVisible()
  await seedProjects(page, ['Bin after', 'Keep other'])

  await page.getByTestId('open-projects').click()
  const dialog = page.getByTestId('projects-dialog')
  const rows = dialog.locator('[data-testid="project-row"]')
  await expect(rows).toHaveCount(3)
  // The open row is the one with no Open button on it.
  const openRow = rows.filter({ hasNot: page.getByTestId('project-open') })
  await expect(openRow).toHaveCount(1)
  const openedBefore = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { id: string } } }
    }
    return useStore.getState().project.id
  })

  await openRow.getByTestId('project-delete').dblclick()

  // Another project took over before the old one went, the dialog is still up, and the
  // row that is gone is the old open project.
  await expect(rows).toHaveCount(2)
  await expect(dialog).toBeVisible()
  const nowOpen = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: { id: string } } }
    }
    return useStore.getState().project.id
  })
  expect(nowOpen).not.toBe(openedBefore)
  await expect(rows.filter({ hasNot: page.getByTestId('project-open') })).toHaveCount(1)

  // And the next delete still needs no reopening.
  await rows.filter({ has: page.getByTestId('project-open') }).first().getByTestId('project-delete').dblclick()
  await expect(rows).toHaveCount(1)
  await expect(dialog).toBeVisible()
})
