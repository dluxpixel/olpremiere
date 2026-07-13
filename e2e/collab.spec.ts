// "Edit together" e2e: two PAGES in one browser profile join the same room
// (BroadcastChannel transport) and edits propagate BOTH ways live. Adding
// clips on A must appear on B without any reload (IndexedDB can't do that —
// only the sync can), and vice versa.

import { expect, test } from '@playwright/test'

test('two tabs in a room see each other\'s edits live', async ({ context }) => {
  test.setTimeout(120_000)

  // --- Tab A: start with one title clip, open a room --------------------------
  const a = await context.newPage()
  await a.goto('/')
  await a.getByTestId('add-title').click()
  await expect(a.getByTestId('clip')).toHaveCount(1)
  await a.getByTestId('collab-start').click()
  await expect(a.getByTestId('collab-badge')).toBeVisible()
  const roomUrl = await a.evaluate(() => window.location.href)
  expect(roomUrl).toMatch(/#room=/)

  // --- Tab B: join via the shared link ---------------------------------------
  const b = await context.newPage()
  await b.goto(roomUrl)
  await expect(b.getByTestId('collab-badge')).toBeVisible()
  // B adopts the room state (A's one clip).
  await expect(b.getByTestId('clip')).toHaveCount(1, { timeout: 15_000 })

  // --- A edits → B sees it WITHOUT reload (proves live sync, not storage) ----
  await a.getByTestId('add-title').click()
  await expect(a.getByTestId('clip')).toHaveCount(2)
  await expect(b.getByTestId('clip')).toHaveCount(2, { timeout: 15_000 })

  // --- B edits → A sees it ----------------------------------------------------
  await b.getByTestId('add-title').click()
  await expect(b.getByTestId('clip')).toHaveCount(3)
  await expect(a.getByTestId('clip')).toHaveCount(3, { timeout: 15_000 })

  // --- presence: both sides report two editors --------------------------------
  await expect(a.getByTestId('collab-badge')).toContainText('2 editing', { timeout: 15_000 })
  await expect(b.getByTestId('collab-badge')).toContainText('2 editing', { timeout: 15_000 })

  // --- leaving restores a solo editor -----------------------------------------
  await b.getByTestId('collab-leave').click()
  await expect(b.getByTestId('collab-start')).toBeVisible()
})

test('a title edit (not just adds) propagates', async ({ context }) => {
  test.setTimeout(120_000)
  const a = await context.newPage()
  await a.goto('/')
  await a.getByTestId('add-title').click()
  await a.getByTestId('collab-start').click()
  const roomUrl = await a.evaluate(() => window.location.href)

  const b = await context.newPage()
  await b.goto(roomUrl)
  await expect(b.getByTestId('clip')).toHaveCount(1, { timeout: 15_000 })

  // A rewrites the title text via the Inspector.
  await a.getByTestId('clip').click()
  await a.getByTestId('title-text').fill('SYNCED!')
  await expect(a.getByTestId('clip')).toContainText('SYNCED!')

  // B receives the text change on the same clip.
  await expect(b.getByTestId('clip')).toContainText('SYNCED!', { timeout: 15_000 })
})
