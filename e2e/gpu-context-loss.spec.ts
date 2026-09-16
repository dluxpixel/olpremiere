// A GPU reset mid session must say so on the picture and come back on its own.
//
// A driver update, a laptop switching graphics, or a crash next door loses the
// WebGL context. Before this, every draw became a silent no-op: the monitor
// froze on its last frame with play, pause and scrubbing dead and nothing on
// screen to explain it. The browser can hand the context back; the app has to
// notice both halves. This uses the standard WEBGL_lose_context extension to
// stage the reset the way the browser itself would.

import { expect, test, type Page } from '@playwright/test'

const FIXTURE = 'e2e/.fixtures/white.png'

async function centreLuma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const scratch = document.createElement('canvas')
    scratch.width = 4
    scratch.height = 4
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(c, Math.floor(c.width / 2), Math.floor(c.height / 2), 4, 4, 0, 0, 4, 4)
    const d = ctx.getImageData(1, 1, 1, 1).data
    return (d[0] + d[1] + d[2]) / 3
  })
}

test('a lost graphics context is named on the picture and the preview returns when it is restored', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)
  await expect.poll(() => centreLuma(page), { timeout: 10_000 }).toBeGreaterThan(200)

  // Stage the reset. The extension fires the same events a real loss does.
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement
    const gl = c.getContext('webgl2') as WebGL2RenderingContext
    const ext = gl.getExtension('WEBGL_lose_context')
    if (!ext) throw new Error('WEBGL_lose_context is not available in this browser')
    ;(window as unknown as { __lose: typeof ext }).__lose = ext
    ext.loseContext()
  })
  await expect(page.getByTestId('no-picture')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('no-picture')).toContainText(/graphics reset/i)

  // The browser hands it back; the picture must come back with it, unprompted.
  await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext())
  await expect(page.getByTestId('no-picture')).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(() => centreLuma(page), { timeout: 10_000 }).toBeGreaterThan(200)
})
