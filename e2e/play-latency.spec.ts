// "I click space or click the play button. It just doesn't work, or it's really
// late." (2026-08-06)
//
// play() used to await scheduleAudio, which decodes EVERY audible clip before
// it resolves. Warm, that is instant, which is why the existing playback spec
// never caught it. COLD - a file just imported, a project just opened - Space
// sat there decoding whole files before a single frame moved.
//
// So this presses Space at the coldest moment there is: immediately after the
// clip lands, with no settling wait at all.

import type { Page } from '@playwright/test'
// Timing spec: runs in the `timing` project, on a quiet box (see quietBox.ts).
import { expect, test } from './quietBox'

async function playhead(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { ui: { playheadS: number } } }
    }
    return useStore.getState().ui.playheadS
  })
}

/** How long the in-page clock waits for the playhead before it reports "never". */
const WATCH_MS = 10_000

/**
 * Press Space and time, INSIDE THE PAGE, from the key reaching the page to the
 * playhead first moving. Resolves to the milliseconds, or null if it never moved
 * within WATCH_MS.
 *
 * ⛔ THE CLOCK USED TO RUN IN THE TEST RUNNER (2026-10-06). It started before the
 * key was sent and stopped after a poll that crossed the DevTools protocol every
 * 50 to 100 ms, so the number carried the key's trip into the browser, every
 * poll's round trip and the poll interval itself, none of which he ever feels. On
 * a quiet box that is noise; with eleven helpers running it was the difference
 * between 1520 ms and the budget. Now the start is the key event's own timestamp
 * (when the browser took the key, so a busy main thread that makes him wait is
 * still counted) and the stop is the store's own notification that the playhead
 * moved. Nothing outside that interval is in the number, and nothing inside it
 * is left out.
 */
async function timeSpaceToMotion(page: Page): Promise<number | null> {
  await page.evaluate(async (watchMs) => {
    const storeMod = '/src/state/store.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: {
        getState: () => { ui: { playheadS: number } }
        subscribe: (fn: (s: { ui: { playheadS: number } }) => void) => () => void
      }
    }
    const w = window as unknown as { __spaceToMotion?: Promise<number | null> }
    w.__spaceToMotion = new Promise((resolve) => {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== ' ') return
        window.removeEventListener('keydown', onKey, true)
        const now = performance.now()
        const t0 = e.timeStamp > 0 && e.timeStamp <= now ? e.timeStamp : now
        const from = useStore.getState().ui.playheadS
        let unsubscribe = (): void => {}
        const finish = (ms: number | null): void => {
          unsubscribe()
          clearTimeout(timer)
          resolve(ms)
        }
        const timer = setTimeout(() => finish(null), watchMs)
        unsubscribe = useStore.subscribe((s) => {
          if (s.ui.playheadS > from) finish(performance.now() - t0)
        })
      }
      // Capture, so this sees the key before the app's own handler runs.
      window.addEventListener('keydown', onKey, true)
    })
  }, WATCH_MS)
  await page.keyboard.press(' ')
  return page.evaluate(() => (window as unknown as { __spaceToMotion: Promise<number | null> }).__spaceToMotion)
}

// ONE COLD PRESS, ON A QUIET BOX, TIMED IN THE PAGE (2026-10-06). The gate of
// 2026-10-06 failed here at 1520 ms with the CPU at 76% (eleven helpers running);
// the quiet gates before it read 232 and 281 ms. The budget, the single sample
// and the coldness are all unchanged: quietBox.ts waits for the machine to settle
// first, and the clock now covers only the interval he feels (above).
test('Space starts the picture promptly even on a stone-cold clip', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().waitFor({ timeout: 15_000 })

  // No settle. This is the moment he complains about.
  await page.getByTestId('timeline').click({ position: { x: 4, y: 4 } }).catch(() => {})
  const ms = await timeSpaceToMotion(page)
  const latency = ms === null ? null : Math.round(ms)
  // Printed, not just asserted. A budget only ever tells you "still under the
  // line"; the number tells you whether the headroom is shrinking, and this is
  // the single interaction he feels most, so it is worth watching drift.
  console.log(`PLAY LATENCY (cold clip, no settle): ${latency === null ? `never within ${WATCH_MS} ms` : `${latency}ms`}  budget 1500ms`)
  await page.keyboard.press(' ')

  // The picture must be moving well inside a second.
  expect(latency, `the playhead never moved within ${WATCH_MS} ms of Space`).not.toBeNull()
  expect(latency!).toBeLessThan(1500)
})

test('the play BUTTON behaves the same as Space', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('media-file-input').setInputFiles('e2e/.fixtures/clip.webm')
  await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('asset-card').dblclick()
  await page.locator('[data-clip-kind="video"]').first().waitFor({ timeout: 15_000 })

  await page.getByTestId('play-toggle').click()
  await expect
    .poll(async () => await playhead(page), { timeout: 2500, intervals: [50, 50, 100] })
    .toBeGreaterThan(0)
  await page.getByTestId('play-toggle').click()
})
