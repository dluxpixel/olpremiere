// What happens when a project FILE cannot be trusted.
//
// Both cases here used to end in silent loss. A truncated copy imported as a
// project whose media were all empty and still reported "Opened", and an older
// file overwrote a newer project that shared its id without a word. The file is
// his only real backup, so these two are worth more than any feature.

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/project-file-safety'

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

/** Import a clip, drop it on the timeline, and name the project. */
async function projectWithClip(page: Page, name: string): Promise<void> {
  // Force the download fallback: a real save picker cannot be driven headless.
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
  })
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await page.getByTestId('project-name').fill(name)
  await page.getByTestId('project-name').press('Enter')
}

/** Save the open project to disk and return the path. */
async function saveTo(page: Page, file: string): Promise<string> {
  const dl = page.waitForEvent('download')
  await page.getByTestId('save-project-file').click()
  const download = await dl
  const path = `${VERIFY}/${file}`
  await download.saveAs(path)
  expect(fs.statSync(path).size).toBeGreaterThan(1000)
  return path
}

test('a truncated project file is refused, and the open project survives', async ({ page }) => {
  await projectWithClip(page, 'Whole')
  const path = await saveTo(page, 'whole.olstudio')

  // Cut the media in half, the way a cancelled copy or a full disk would.
  const whole = fs.readFileSync(path)
  const cut = `${VERIFY}/truncated.olstudio`
  fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)))

  await page.getByTestId('project-name').fill('StillHere')
  await page.getByTestId('project-name').press('Enter')

  await page.getByTestId('open-project-input').setInputFiles(cut)

  // It says what is wrong, and it does NOT claim to have opened anything.
  await expect(page.getByText(/project file is incomplete/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Opened "Whole"/)).toHaveCount(0)
  // The project he was working on is untouched.
  await expect(page.getByTestId('project-name')).toHaveValue('StillHere')
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('an older file arrives as a copy instead of overwriting a newer project', async ({ page }) => {
  await projectWithClip(page, 'Edit')
  const path = await saveTo(page, 'older.olstudio')

  // Keep editing after the save, so the project in the browser is now NEWER than
  // the file, and bump updatedAt the way any real edit would.
  await page.getByTestId('project-name').fill('Edit v2')
  await page.getByTestId('project-name').press('Enter')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })

  await page.getByTestId('open-project-input').setInputFiles(path)
  await expect(page.getByText(/Opened "Edit \(copy\)"/)).toBeVisible({ timeout: 15_000 })

  // The newer one was not replaced: both exist, and the copy is what is open.
  await expect(page.getByTestId('project-name')).toHaveValue('Edit (copy)')
  await page.getByTestId('open-projects').click()
  await expect(page.getByTestId('project-row')).toHaveCount(2)
  // Scoped to the list: the toast also names it, and both being on screen at once
  // is the point rather than an ambiguity to work around.
  await expect(page.getByTestId('project-row').filter({ hasText: 'Edit v2' })).toHaveCount(1)
  await expect(page.getByTestId('project-row').filter({ hasText: 'Edit (copy)' })).toHaveCount(1)

  // The copy has its own media, so it renders rather than pointing at nothing.
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
})

test('dropping a project file on the window opens it instead of failing as media', async ({ page }) => {
  await projectWithClip(page, 'Dropped')
  const path = await saveTo(page, 'dropped.olstudio')
  await page.getByTestId('project-name').fill('Before drop')
  await page.getByTestId('project-name').press('Enter')

  // A real OS drop: hand the page a DataTransfer holding the file's bytes.
  const bytes = Array.from(fs.readFileSync(path))
  await page.evaluate(
    async ([name, data]) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(data as number[])], name as string))
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    ['dropped.olstudio', bytes] as const,
  )

  // It opened as a PROJECT. Before this it went to the media importer and failed.
  await expect(page.getByText(/Opened "Dropped/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/couldn't import|unsupported/i)).toHaveCount(0)
})

/**
 * ⛔ THIS ASKED THE COMMAND PALETTE UNTIL 2026-08-17, and the palette was cut that day
 * on his word. What the test was really for survives: the project file has to be
 * reachable without the mouse, and he has to be able to FIND OUT that it is.
 *
 * ⛔ AND THE CUT TOOK THE ONLY PLACE THAT SAID SO. The palette and the shortcut sheet
 * were the two surfaces listing keys, so the tooltip on the button is now the whole of
 * discovery, and neither of these two buttons carried its shortcut. They do now, which
 * is a consequence of the cut being repaired rather than a feature. → D114
 */
test('the project file is reachable by keyboard, and the toolbar says which key', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('timeline')).toBeVisible()

  const open = page.getByTestId('open-project-file')
  const backup = page.getByTestId('save-project-file')
  await expect(open).toBeVisible()
  await expect(backup).toBeVisible()

  // Hovering is how he meets a shortcut now. The tooltip is display:none until then,
  // so asking for the visible one is asking whether the hover really revealed it.
  await open.hover()
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+O')
  await backup.hover()
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+Shift+S')
})
