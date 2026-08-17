// "Edit together" e2e: two PAGES in one browser profile join the same room
// (BroadcastChannel transport) and edits propagate BOTH ways live. Adding
// clips on A must appear on B without any reload (IndexedDB can't do that,
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

test('undo in a room reverts only YOUR edit, so the other person\'s clip survives', async ({ context }) => {
  test.setTimeout(120_000)
  const a = await context.newPage()
  await a.goto('/')
  await a.getByTestId('add-title').click() // A's base clip
  await a.getByTestId('collab-start').click()
  // enterRoom sets the hash asynchronously (after the relay probe). Reading
  // the href before the badge renders races it and hands B a room-less URL.
  await expect(a.getByTestId('collab-badge')).toBeVisible()
  const roomUrl = await a.evaluate(() => window.location.href)
  expect(roomUrl).toMatch(/#room=/)

  const b = await context.newPage()
  await b.goto(roomUrl)
  await expect(b.getByTestId('clip')).toHaveCount(1, { timeout: 15_000 })

  // A adds a second title (undoable on A), then B adds a third.
  //
  // ⛔ THE THREE ASSERTIONS BELOW USED TO BE ONE, AND THE ONE COULD NOT SAY WHAT
  // BROKE. In the 2.0.3 gate this failed with "expected 3, received 2" on A, and
  // its retry log showed A sitting at ONE clip for nine seconds first, which means
  // A had briefly lost its OWN second title rather than merely missing B's third.
  // A single assertion at the end of a three step handshake reports the last step
  // and hides which one actually went wrong. None of these is weaker than what it
  // replaced: the final count is still 3 on A.
  await a.getByTestId('add-title').click()
  await expect(a.getByTestId('clip')).toHaveCount(2, { timeout: 15_000 }) // A keeps its own edit
  await expect(b.getByTestId('clip')).toHaveCount(2, { timeout: 15_000 }) // and it reaches B
  await b.getByTestId('add-title').click()
  await expect(b.getByTestId('clip')).toHaveCount(3, { timeout: 15_000 }) // B's own click landed
  await expect(a.getByTestId('clip')).toHaveCount(3, { timeout: 15_000 }) // and it reaches A

  // A undoes: A's OWN last add disappears everywhere; B's clip stays everywhere.
  // (Snapshot undo would have wiped B's clip from A's timeline too.)
  await a.locator('body').click()
  await a.keyboard.press('Control+z')
  await expect(a.getByTestId('clip')).toHaveCount(2, { timeout: 15_000 })
  await expect(b.getByTestId('clip')).toHaveCount(2, { timeout: 15_000 })

  // Redo brings A's add back on both sides.
  await a.keyboard.press('Control+Shift+z')
  await expect(a.getByTestId('clip')).toHaveCount(3, { timeout: 15_000 })
  await expect(b.getByTestId('clip')).toHaveCount(3, { timeout: 15_000 })
})

test('a title edit (not just adds) propagates', async ({ context }) => {
  test.setTimeout(120_000)
  const a = await context.newPage()
  await a.goto('/')
  await a.getByTestId('add-title').click()
  await a.getByTestId('collab-start').click()
  // Same badge-then-read guard as the tests above: the hash is set async.
  await expect(a.getByTestId('collab-badge')).toBeVisible()
  const roomUrl = await a.evaluate(() => window.location.href)
  expect(roomUrl).toMatch(/#room=/)

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
