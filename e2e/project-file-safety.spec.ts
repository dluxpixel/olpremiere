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
