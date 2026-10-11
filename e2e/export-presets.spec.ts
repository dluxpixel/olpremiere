import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// EXPORT ASKS WHICH PRESET, AND A PRESET KEEPS ITS OWN FOLDER.
//
// His words, 2026-10-11: "when I click Export, it asks me what preset, and when I
// click, for example, Gym Preset, it exports the finished video to a specific
// folder where it pops up that option for me."
//
// The browser build has no desktop shell, so this one stands in for it: the folder
// picker answers a REAL temporary folder, the file name is made there the way main
// makes it (Name.mp4, then Name 2.mp4, never over a file), and the encoder is a
// stand-in that writes a small file where the app told it to. What is proven is
// the app's side of the flow: the question, making a preset, the folder asked
// once, the second export going straight there, and the setting riding along.
//
// Nothing here writes to the app's store: the page is driven by clicks and only read.
//
// IF IT FAILS WITH THE EXPORT BUTTON DISABLED AND NO DIALOG, LOOK AT THE DEV SERVER FIRST.
// A vite server with an empty dependency cache (a fresh checkout or worktree) only meets
// @huggingface/transformers when the first clip is imported and its transcription starts.
// It then prints "new dependencies optimized: @huggingface/transformers ... reloading" and
// the page reloads, which drops the project the spec just built. That is the dev server,
// not the export. The next run, with the cache written, goes through. (2026-10-11)

const FIXTURE = 'e2e/.fixtures/clip.webm'
const MODS = { job: '/src/state/exportJob.ts' }

const FAKE_SHELL = `
  const state = { picks: 0, titles: [], revealed: [], cfg: null }
  window.__shell = state
  const impl = {
    isElectron: true,
    exportPickFolder: async (title) => { state.picks++; state.titles.push(title); return await window.__pickFolder() },
    exportPresetOutput: async (folder, base) => await window.__presetOutput(folder, base),
    exportReveal: async (p) => { state.revealed.push(p) },
    nativeStart: async (cfg) => { state.cfg = cfg; return { started: true, outPath: cfg.outPath } },
    nativeWriteFrame: async () => ({ ok: true }),
    nativeFinish: async () => {
      await window.__writeFile(state.cfg.outPath)
      return { ok: true, outPath: state.cfg.outPath, sizeBytes: 12 }
    },
    nativeCancel: async () => undefined,
    onNativeProgress: () => () => undefined,
  }
  // Everything else the shell offers answers "nothing", so boot carries on.
  window.api = new Proxy(impl, {
    get: (t, k) => (k in t ? t[k] : /^on[A-Z]/.test(String(k)) ? () => () => undefined : async () => undefined),
  })
`

test('a preset asks for its folder once, then every export goes there under a new name', async ({ page }) => {
  test.setTimeout(150_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-e2e-gym-'))
  try {
    // Node's half of the stand-in shell. Names are made like main's presetFileName.
    await page.exposeFunction('__pickFolder', () => folder)
    await page.exposeFunction('__presetOutput', (dir: string, base: string) => {
      if (!fs.existsSync(dir)) return { ok: false, reason: 'no-folder' }
      let name = `${base}.mp4`
      for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base} ${n}.mp4`
      return { ok: true, outPath: path.join(dir, name) }
    })
    await page.exposeFunction('__writeFile', (file: string) => fs.writeFileSync(file, `made ${file}`))
    await page.addInitScript(FAKE_SHELL)

    await page.goto('/')
    await expect(page.getByTestId('panel-left')).toBeVisible()
    await page.getByTestId('media-file-input').setInputFiles(FIXTURE)
    await expect(page.getByTestId('asset-card')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('asset-card').dblclick()
    await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(1)

    // Export asks which preset. The list starts empty, with New preset to begin.
    await page.getByTestId('export-open').click()
    await expect(page.getByTestId('export-chooser')).toBeVisible()
    await expect(page.getByTestId('export-preset-row')).toHaveCount(0)

    // Make "Gym" with Platform loudness off, and export with it.
    await page.getByTestId('export-new-preset').click()
    await page.getByTestId('export-preset-name').fill('Gym')
    await page.getByTestId('export-preset-loudness').uncheck()
    await page.getByTestId('export-preset-save-export').click()

    // The first use pops the folder picker (exactly once) and the file lands in it.
    await expect(page.getByTestId('export-reveal')).toBeVisible({ timeout: 120_000 })
    const shell = () => page.evaluate(() => (window as unknown as { __shell: { picks: number; titles: string[]; revealed: string[] } }).__shell)
    expect((await shell()).picks).toBe(1)
    expect((await shell()).titles).toEqual(['Folder for Gym'])
    const first = fs.readdirSync(folder)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/\.mp4$/)
    const base = first[0].replace(/\.mp4$/, '')

    // The preset's own setting made this video: loudness off. (Read only.)
    const target = await page.evaluate(async (m) => {
      const { useExportJob } = (await import(/* @vite-ignore */ m.job)) as {
        useExportJob: { getState: () => { job: { plan: { settings: { loudnessTargetLufs: number | null } } } | null } }
      }
      return useExportJob.getState().job?.plan.settings.loudnessTargetLufs
    }, MODS)
    expect(target).toBeNull()

    // Show in folder hands the shell the file that was made.
    await page.getByTestId('export-reveal').click()
    expect((await shell()).revealed).toEqual([path.join(folder, first[0])])
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('export-dialog')).toHaveCount(0)

    // Again with the same preset: no folder prompt, and a name nothing there has.
    await page.getByTestId('export-open').click()
    await expect(page.getByTestId('export-preset-row')).toHaveCount(1)
    await expect(page.getByTestId('export-preset-row')).toContainText(folder)
    await page.getByTestId('export-preset-start').click()
    await expect(page.getByTestId('export-reveal')).toBeVisible({ timeout: 120_000 })
    expect((await shell()).picks).toBe(1)
    expect(fs.readdirSync(folder).sort()).toEqual([`${base} 2.mp4`, `${base}.mp4`].sort())
    // The first video is exactly as it was written.
    expect(fs.readFileSync(path.join(folder, `${base}.mp4`), 'utf8')).toBe(`made ${path.join(folder, `${base}.mp4`)}`)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
