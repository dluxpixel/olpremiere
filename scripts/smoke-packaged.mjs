// Does the FINISHED app actually start? Nothing has ever answered that.
//
// His ask, 2026-08-17: *"every time it does a huge update, you can check the app
// every time it does a big thing, and then it automatically goes."* So this opens
// the built app, waits for the real window to render, proves the renderer booted,
// and closes it. It needs no click and it closes itself.
//
// ⛔ WHY IT IS NOT ON EVERY PATCH. He streams, and a window appearing on camera is
// the thing he asked me to stop doing on 2026-08-08. He authorised this for a BIG
// update, so `release.mjs` runs it only when the minor or major number moved. A
// patch still ships on the static proof, which is what `check-self-contained.mjs`
// is for.
//
// ⛔ AND IT IS NOT THE DEV APP. Every e2e spec drives the web build through the dev
// server, which is the right tool for behaviour and cannot see this class of fault
// at all: a missing file in the asar, a dependency excluded by mistake, a bad
// path once the app is inside an installer. Those only exist in the packaged tree.

import { existsSync } from 'node:fs'
import { _electron as electron } from 'playwright'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.error(`❌ smoke: no packaged app at ${exe ?? '(nothing passed)'}`)
  process.exit(2)
}

const BOOT_TIMEOUT_MS = 60_000

let app
try {
  app = await electron.launch({ executablePath: exe, timeout: BOOT_TIMEOUT_MS })

  // ⛔ NOT `firstWindow()`. The packaged app opens a SPLASH window first, which has
  // none of the editor's markup, so waiting for the editor on the first window
  // would fail every time and blame the app for it.
  //
  // The renderer is only PROVEN up when its own markup is there. A window that
  // opened and then failed to load its bundle still counts as a window, which is
  // exactly the failure this is looking for. So every window is asked, until one
  // answers or the clock runs out.
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let win = null
  while (!win && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const found = await candidate
        .waitForSelector('[data-testid="add-title"]', { timeout: 2000, state: 'attached' })
        .then(() => true, () => false)
      if (found) {
        win = candidate
        break
      }
    }
    if (!win) await app.waitForEvent('window', { timeout: 3000 }).catch(() => {})
  }
  if (!win) throw new Error('no window ever rendered the editor')
  const title = await win.title()

  // And the export path is the half that reaches outside the asar for ffmpeg, so
  // ask the app whether it found it rather than assuming the file is there.
  const version = await app.evaluate(({ app: a }) => a.getVersion())

  console.log(`✅ smoke: v${version} started, window "${title}", renderer up.`)
  await app.close()
  process.exit(0)
} catch (err) {
  console.error(`❌ smoke: the packaged app did not come up. ${err instanceof Error ? err.message : String(err)}`)
  try {
    await app?.close()
  } catch {
    // closing a corpse is not the interesting failure
  }
  process.exit(1)
}
