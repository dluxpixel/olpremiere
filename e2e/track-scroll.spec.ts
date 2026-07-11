import { expect, test } from '@playwright/test'

// Verify the timeline scrolls vertically to reach many tracks AND the add-track
// buttons stay reachable (David reported not being able to scroll to add tracks).

test('with many tracks, you can scroll to the add-track buttons and use them', async ({ page }) => {
  await page.goto('/')

  // Add tracks straight through the store so this test does not depend on the
  // very buttons it is checking being reachable.
  await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const tlMod = '/src/engine/timeline.ts'
    const { updateActiveSequence } = (await import(/* @vite-ignore */ storeMod)) as {
      updateActiveSequence: (label: string, fn: (s: unknown) => unknown) => void
    }
    const { addTrack } = (await import(/* @vite-ignore */ tlMod)) as {
      addTrack: (seq: unknown, kind: 'video' | 'audio') => unknown
    }
    for (let i = 0; i < 5; i++) updateActiveSequence('add v', (s) => addTrack(s, 'video'))
    for (let i = 0; i < 5; i++) updateActiveSequence('add a', (s) => addTrack(s, 'audio'))
  })

  const lanes = page.getByTestId('timeline-lanes')
  const addVideo = page.getByTestId('add-video-track')

  // The lanes must actually be vertically scrollable now.
  const scrollable = await lanes.evaluate((el) => el.scrollHeight > el.clientHeight + 4)
  expect(scrollable).toBe(true)

  // Scroll the lanes fully down; the headers (with the add buttons) follow.
  await lanes.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page.waitForTimeout(100)

  // The add-track buttons must be reachable AND clickable at the bottom.
  await expect(addVideo).toBeInViewport()
  const before = await page.locator('[data-testid="track-header"]').count().catch(() => 0)
  await addVideo.click()
  // A new video track appeared (proves the button was truly usable, not just visible).
  const vCount = await page.evaluate(async () => {
    const storeMod = '/src/state/store.ts'
    const typesMod = '/src/engine/types.ts'
    const { useStore } = (await import(/* @vite-ignore */ storeMod)) as {
      useStore: { getState: () => { project: unknown } }
    }
    const { activeSequence } = (await import(/* @vite-ignore */ typesMod)) as {
      activeSequence: (p: unknown) => { tracks: { kind: string }[] }
    }
    return activeSequence(useStore.getState().project).tracks.filter((t) => t.kind === 'video').length
  })
  expect(vCount).toBe(8) // 2 default + 5 added + 1 from the click
  void before
})
