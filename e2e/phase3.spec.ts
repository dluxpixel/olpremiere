import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

const FIXTURE = 'e2e/.fixtures/clip.webm'
const VERIFY = '_verify/phase3'

// The fixture has audio, so each add creates a linked video+audio pair; the
// tests operate on the video clips.
const vclip = (page: Page) => page.locator('[data-clip-kind="video"]')

test.beforeAll(() => {
  fs.mkdirSync(VERIFY, { recursive: true })
})

async function addClip(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(vclip(page)).toHaveCount(1)
}

const centerPixel = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    // The program canvas is WebGL2; copy it onto a 2D scratch canvas to read pixels.
    const scratch = document.createElement('canvas')
    scratch.width = c.width
    scratch.height = c.height
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
    return [d[0], d[1], d[2]] as [number, number, number]
  })

test('frame-accurate scrub: exact frames on both sides of the color cut', async ({ page }) => {
  await addClip(page)
  // Fixture: red for source t<1s, blue after. 60 px/s at default zoom.
  await page.getByTestId('ruler').click({ position: { x: 28, y: 10 } }) // ≈0.47s
  await expect
    .poll(async () => (await centerPixel(page))[0], { timeout: 10_000 })
    .toBeGreaterThan(150)
  const red = await centerPixel(page)
  expect(red[2]).toBeLessThan(120)

  await page.getByTestId('ruler').click({ position: { x: 90, y: 10 } }) // 1.5s
  await expect
    .poll(async () => (await centerPixel(page))[2], { timeout: 10_000 })
    .toBeGreaterThan(120)
  const blue = await centerPixel(page)
  expect(blue[0]).toBeLessThan(110)

  // Prove the WebCodecs frame cache actually served the scrub (vite dev
  // shares the module graph, so this import IS the app's instance).
  const stats = await page.evaluate(async () => {
    // Computed specifier: resolved by vite in the browser, invisible to tsc.
    const spec = '/src/engine/frameCache.ts'
    const mod = (await import(/* @vite-ignore */ spec)) as {
      frameCacheStats: () => { entries: number; assets: number }
    }
    return mod.frameCacheStats()
  })
  expect(stats.entries).toBeGreaterThan(0)
  await page.screenshot({ path: `${VERIFY}/frame-accurate-scrub.png` })
})

test('copy / paste / duplicate via keyboard', async ({ page }) => {
  await addClip(page)
  await vclip(page).click()
  await page.keyboard.press('Control+c')
  await page.getByTestId('ruler').click({ position: { x: 300, y: 10 } }) // 5s
  await page.keyboard.press('Control+v')
  await expect(vclip(page)).toHaveCount(2)
  await page.keyboard.press('Control+d')
  await expect(vclip(page)).toHaveCount(3)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(vclip(page)).toHaveCount(1)
})

test('markers: add, exact-time dedupe, remove', async ({ page }) => {
  await addClip(page)
  await page.keyboard.press('m')
  await expect(page.getByTestId('marker')).toHaveCount(1)
  await page.keyboard.press('m') // same frame → dedupe
  await expect(page.getByTestId('marker')).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('m')
  await expect(page.getByTestId('marker')).toHaveCount(2)
  await page.keyboard.press('Shift+m')
  await expect(page.getByTestId('marker')).toHaveCount(1)
  await page.getByTestId('timeline').screenshot({ path: `${VERIFY}/markers.png` })
})

test('ripple trim: Ctrl+drag the out edge pulls the next clip along', async ({ page }) => {
  await addClip(page)
  await page.getByTestId('asset-card').dblclick() // second clip lands after the first
  await expect(vclip(page)).toHaveCount(2)
  const second = vclip(page).nth(1)
  const before2 = (await second.boundingBox())!
  const first = vclip(page).first()
  const b1 = (await first.boundingBox())!

  await page.keyboard.down('Control')
  await page.mouse.move(b1.x + b1.width - 3, b1.y + b1.height / 2)
  await page.mouse.down()
  await page.mouse.move(b1.x + b1.width - 33, b1.y + b1.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Control')

  const after2 = (await second.boundingBox())!
  expect(before2.x - after2.x).toBeGreaterThan(20) // followed the ripple left
})

test('slip: Alt+drag shifts the source window, not the position', async ({ page }) => {
  await addClip(page)
  const clip = vclip(page)
  // Trim the head in ~30px first so the slip has source room on the left.
  let box = (await clip.boundingBox())!
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 33, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()

  await clip.click()
  const inBefore = await page.getByTestId('panel-right').textContent()
  box = (await clip.boundingBox())!

  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 15, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Alt')

  const after = (await clip.boundingBox())!
  expect(Math.abs(after.x - box.x)).toBeLessThan(3) // position unchanged
  expect(Math.abs(after.width - box.width)).toBeLessThan(3) // duration unchanged
  const inAfter = await page.getByTestId('panel-right').textContent()
  expect(inAfter).not.toBe(inBefore) // source window moved
})

test('history round-trips: undo to empty, redo to the edited state', async ({ page }) => {
  await addClip(page)
  await page.getByTestId('ruler').click({ position: { x: 60, y: 10 } }) // 1s
  // 'c' is the split-at-playhead key; mod+k now belongs to the command palette.
  await page.keyboard.press('c')
  await expect(vclip(page)).toHaveCount(2)
  await vclip(page).first().click()
  await page.keyboard.press('Delete')
  await expect(vclip(page)).toHaveCount(1)

  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(vclip(page)).toHaveCount(0)

  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+Shift+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(vclip(page)).toHaveCount(1)
})
