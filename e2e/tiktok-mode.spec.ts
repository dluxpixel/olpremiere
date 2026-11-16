// TikTok text mode (his ask: "make it so when I choose to, I can make the editor similar to the
// TikTok-style editor ... it has to look exactly like how TikTok has it", and "It should also
// have safe margins").
//
// What a person would check, in the order they would check it: a tall project, the switch in the
// Frame menu, T for a new title that goes straight into typing, two typed lines, the style
// button pressed twice, and the picture showing the TikTok guides and the floating bar.
//
// The behaviour is pinned in src/components/TikTokTextBar.test.tsx, src/engine/safeSnap.test.ts
// and src/components/MonitorTransformOverlayTikTok.test.tsx; this is the browser's view of it.

import fs from 'node:fs'
import { expect, test } from '@playwright/test'

test('TikTok text mode: T, two typed lines, the style button twice, guides and bar on the picture', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('format-select').selectOption('9:16')

  // Switch the mode on in the Frame menu, beside the guides.
  await page.getByTestId('frame-settings-button').click()
  await expect(page.getByTestId('frame-settings-menu')).toBeVisible()
  await expect(page.getByTestId('app-guides-toggle')).not.toBeChecked()
  await page.getByLabel('TikTok text mode').check()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('frame-settings-menu')).toBeHidden()

  // T adds a title and goes straight into typing on the video.
  await page.keyboard.press('t')
  const field = page.getByTestId('text-edit-field')
  await expect(field).toBeFocused()
  await page.keyboard.type('first line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line')
  await expect(page.getByTestId('title-text')).toHaveValue('first line\nsecond line')

  // The floating bar is over the text. The style button goes plain, highlight, soft.
  const bar = page.getByTestId('tiktok-text-bar')
  await expect(bar).toBeVisible()
  const style = page.getByTestId('tiktok-style')
  await expect(style).toHaveAttribute('data-style', 'plain')
  await style.click()
  await style.click()
  await expect(style).toHaveAttribute('data-style', 'soft')
  // A press on the bar did not end the typing.
  await expect(field).toBeVisible()

  // Past the fade in, so the words are fully on the picture. A seek, nothing more.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { setUI: (p: { playheadS: number }) => void } }
    }
    useStore.getState().setUI({ playheadS: 1 })
  })

  // His own guides switch is still off, and the TikTok guides are on the picture all the same.
  await expect(page.getByTestId('app-guides')).toBeVisible()
  await expect(page.getByTestId('app-guides')).toHaveAttribute('data-app', 'tiktok')
  await expect(bar).toBeVisible()

  fs.mkdirSync('test-results', { recursive: true })
  await page.getByTestId('monitor').screenshot({ path: 'test-results/tiktok-mode.png' })
})
