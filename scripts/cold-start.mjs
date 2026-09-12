// Does the FINISHED app work for somebody who has never run it before?
//
// ⛔ THIS IS THE ONE THING NOTHING HAS EVER ANSWERED. Two months, 419 commits and
// 138 releases, and every bug, fix and measurement came from ONE machine with ONE
// project on it. Nobody but David has ever opened this app. For something meant to
// spread, the first ten minutes on a stranger's computer is what decides it, and
// there was no evidence about that at all.
//
// `smoke-packaged.mjs` proves a window comes up and renders the editor's markup.
// That is real and it catches a whole class of packaging fault. What it does NOT
// do is a single import, a single cut or a single export, and its own comment
// claims it "asks the app whether it found ffmpeg" while the line underneath only
// reads the version string. So the export half of the packaged app has never been
// driven by anything but his hands.
//
// ⛔ AND THE e2e SPECS CANNOT ANSWER IT EITHER. They drive the WEB build through
// the dev server. `ExportDialog.tsx` branches `isElectron ? startNative() : start()`,
// so every export spec exercises the browser path (OPFS + showSaveFilePicker),
// and the ffmpeg path his installed app actually uses is never run by a machine.
//
// So this launches the packaged app against a userData directory that has never
// existed, and drives it the way a person would: open it, read what the empty
// screen offers, import a file, cut it, export it, and prove the thing that lands
// on disk is a real video.
//
// ⚠️ EVERYTHING HERE GOES THROUGH THE REAL INTERFACE, and that is not a style
// choice. The renderer in a packaged build is BUNDLED: there is no
// `/src/state/store.ts` to import the way every e2e spec does, because that path
// only exists while Vite is serving. Reaching for the store here would fail on the
// one build this script exists to test, so the clip is cut with the `c` key and
// the sequence is left exactly as the app chose it.
//
// ⚠️ IT DELETES ONLY WHAT IT MADE. The throwaway profile and the output file live
// under the system temp directory and are removed at the end, pass or fail. It
// never touches his real profile: that is the whole point of --user-data-dir, and
// getting it wrong would be this script destroying the thing it exists to protect.

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.error(`❌ cold start: no packaged app at ${exe ?? '(nothing passed)'}`)
  process.exit(2)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = path.join(repo, 'e2e', '.fixtures', 'clip.webm')
if (!existsSync(FIXTURE)) {
  console.error(`❌ cold start: the fixture clip is missing at ${FIXTURE}`)
  process.exit(2)
}

const BOOT_MS = 60_000
const EXPORT_MS = 240_000

/** A profile directory that has never existed. This is the "stranger's machine". */
const profile = mkdtempSync(path.join(tmpdir(), 'olp-coldstart-profile-'))
const outDir = mkdtempSync(path.join(tmpdir(), 'olp-coldstart-out-'))
const outPath = path.join(outDir, 'first-export.mp4')

const clean = () => {
  for (const dir of [profile, outDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A temp directory that outlives one run is litter, not a failure worth
      // reporting over the thing the run actually went to find out.
    }
  }
}

const notes = []

let app
let step = 'launch it'
try {
  app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${profile}`],
    timeout: BOOT_MS,
  })

  // ⛔ THE SAVE DIALOG WOULD SIT THERE FOREVER. The native export asks for a
  // destination with dialog.showSaveDialog unless the config already carries an
  // outPath, and nothing can click a native dialog. Answering it from the main
  // process is what lets the REAL export path run unmodified underneath.
  step = 'answer the save dialog for it'
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen })
  }, outPath)

  // ⛔ NOT `firstWindow()`. The packaged app opens a SPLASH window first, with none
  // of the editor's markup on it. A window that opened and then failed to load its
  // bundle still counts as a window, which is exactly the failure worth catching,
  // so every window is asked until one answers.
  step = 'find the editor window'
  const deadline = Date.now() + BOOT_MS
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

  const version = await app.evaluate(({ app: a }) => a.getVersion())

  // The thing the smoke test's comment claims and its code does not: ask the main
  // process whether the ffmpeg it will actually spawn is really on disk inside the
  // installed tree. This resolves the path the SAME way electron/nativeExport.ts
  // does, so it cannot pass while the app fails.
  step = 'find ffmpeg inside the installed app'
  const ffmpeg = await app.evaluate(async ({ app: a }) => {
    const fs = await import('node:fs')
    const p = await import('node:path')
    const real = a.isPackaged
      ? p.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
      : p.join(a.getAppPath(), 'vendor', 'ffmpeg', 'win-x64', 'ffmpeg.exe')
    const present = fs.existsSync(real)
    return { path: real, present, bytes: present ? fs.statSync(real).size : 0, packaged: a.isPackaged }
  })
  if (!ffmpeg.present) throw new Error(`ffmpeg is not where the app will look for it: ${ffmpeg.path}`)
  if (!ffmpeg.packaged) notes.push('this was not a packaged build, so the asar and resource paths went untested')

  // --- the first ten minutes, in the order a person lives them ---------------

  // An empty app has to say what to do next. He never needed that and the
  // first-run checklist was deleted on his word (2026-08-17), so the media bin's
  // own empty state is the only thing left telling a newcomer where to start.
  step = 'read the empty screen a newcomer lands on'
  const guided = await win
    .waitForSelector('text=Import media to begin', { timeout: 15_000, state: 'visible' })
    .then(() => true, () => false)
  if (!guided) notes.push('the empty media bin never offered "Import media to begin"')

  step = 'import the first file this profile has ever seen'
  await win.setInputFiles('[data-testid="media-file-input"]', FIXTURE)
  await win.waitForSelector('[data-testid="asset-card"]', { timeout: 90_000, state: 'visible' })

  step = 'put it on the timeline'
  await win.dblclick('[data-testid="asset-card"]')
  await win.waitForSelector('[data-clip-kind="video"]', { timeout: 30_000, state: 'attached' })
  const beforeCut = await win.locator('[data-clip-kind="video"]').count()

  // Park the playhead inside the clip and split it with the key a person would
  // press. Clicking the ruler is how the app itself moves the playhead, so this
  // exercises the real gesture rather than writing a number into state.
  step = 'cut it with the c key, the way a person would'
  await win.click('[data-testid="ruler"]', { position: { x: 40, y: 8 } })
  await win.keyboard.press('c')
  await win
    .waitForFunction(
      (before) => document.querySelectorAll('[data-clip-kind="video"]').length > before,
      beforeCut,
      { timeout: 15_000 },
    )
    .catch(() => {
      throw new Error(`pressing c did not split the clip: still ${beforeCut} on the timeline`)
    })
  const afterCut = await win.locator('[data-clip-kind="video"]').count()

  step = 'export it through the real ffmpeg path'
  await win.click('[data-testid="export-open"]')
  await win.waitForSelector('text=Saved', { timeout: EXPORT_MS, state: 'visible' })

  step = 'prove the file on disk is a real video'
  if (!existsSync(outPath)) throw new Error(`the app said it saved, but ${outPath} does not exist`)
  const bytes = statSync(outPath).size
  // A header-only or zero-length file is what a broken ffmpeg spawn leaves
  // behind, and it would pass an existsSync check quite happily.
  if (bytes < 20_000) throw new Error(`the exported file is only ${bytes} bytes, which is not a video`)

  console.log(`✅ cold start: v${version} on a profile that had never existed.`)
  console.log(`   ffmpeg was where the app looks, ${(ffmpeg.bytes / 1024 / 1024).toFixed(1)} MB inside the installed tree.`)
  console.log(`   imported a clip, cut it into ${afterCut}, exported ${(bytes / 1024).toFixed(0)} KB of real video.`)
  for (const n of notes) console.log(`   ⚠️ ${n}`)
  await app.close()
  clean()
  process.exit(0)
} catch (err) {
  console.error(`❌ cold start failed trying to ${step}.`)
  console.error(`   ${err instanceof Error ? err.message : String(err)}`)
  for (const n of notes) console.error(`   ⚠️ ${n}`)
  try {
    await app?.close()
  } catch {
    // closing a corpse is not the interesting failure
  }
  clean()
  process.exit(1)
}
