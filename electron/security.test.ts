// What a page cannot make main do, and what the packaged exe refuses to become.
// Source level, like src/desktopInstall.test.ts: a drift here breaks no build and no
// other test, it only quietly opens a door again.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
const ipcTypes = readFileSync(new URL('./ipc-types.ts', import.meta.url), 'utf8')
const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')

describe('an export goes only where he picked', () => {
  // ffmpeg writes with -y. A destination the page could name was a way for any page
  // code to overwrite any file on his PC with a movie. The page may hand back only the
  // answer main's own save dialog gave (./exportChoice, run in exportChoice.test.ts).
  it('main passes a page\'s destination to the export only through his dialog\'s answer', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('native:start'"), main.indexOf("ipcMain.handle('native:writeFrame'"))
    expect(handler).toContain('native.start({ ...config, outPath: exportPathFromPage(config.outPath) }, mainWindow)')
    expect(handler).not.toMatch(/native\.start\(config\b/)
    expect(handler).not.toMatch(/outPath: config\.outPath/)
  })

  it('the answer lasts the whole export job: a finished movie ends it, a cancel does not', () => {
    const finish = main.slice(main.indexOf("ipcMain.handle('native:finish'"), main.indexOf("ipcMain.handle('native:cancel'"))
    expect(finish).toContain('exportFinished(done)')
    // The loudness switch restarts by cancelling and starting again with the same answer.
    const cancel = main.slice(main.indexOf("ipcMain.handle('native:cancel'"))
    expect(cancel.split('\n')[0]).toBe("ipcMain.handle('native:cancel', () => native.cancel())")
  })
})

describe('a reel plan is only the file he picked', () => {
  // The page used to be able to pass a plan path, and main would read that .json and
  // approve every video file it named for streaming back. The page now asks with no
  // argument and main opens its own dialog (reelPlanFile.ts, run in reelPlanFile.test.ts).
  const lineWith = (src: string, needle: string): string => src.split('\n').find((l) => l.includes(needle)) ?? ''

  it('the page asks for the import with no argument, so it cannot name the plan', () => {
    expect(lineWith(preload, "'reelplan:import'").trim()).toBe("reelPlanImport: () => ipcRenderer.invoke('reelplan:import'),")
    expect(lineWith(ipcTypes, 'reelPlanImport(')).toContain('reelPlanImport(): Promise<ReelPlanImportResult>')
  })

  it('main passes the handler only its own window, and the path export has no channel', () => {
    const handler = lineWith(main, "ipcMain.handle('reelplan:import'")
    expect(handler).toContain("ipcMain.handle('reelplan:import', () => reelPlanFile.importReelPlan(mainWindow))")
    expect(main).not.toContain('importReelPlanFromPath')
  })
})

describe('the packaged exe', () => {
  /** electron-builder.yml's electronFuses block, as name: value. */
  const fuses = (): Record<string, string> => {
    const lines = builder.split(/\r?\n/)
    const out: Record<string, string> = {}
    for (const line of lines.slice(lines.findIndex((l) => /^electronFuses:\s*$/.test(l)) + 1)) {
      const m = /^\s+(\w+):\s*(\S+)\s*$/.exec(line)
      if (!m) break
      out[m[1]] = m[2]
    }
    return out
  }

  it('cannot be turned into plain Node, or told to load a script at start', () => {
    expect(fuses()).toMatchObject({ runAsNode: 'false', enableNodeOptionsEnvironmentVariable: 'false' })
  })

  it('⛔ keeps the inspect switch the ship gate drives it through', () => {
    // scripts/smoke-packaged.mjs and cold-start.mjs launch it with --inspect=0.
    expect(fuses().enableNodeCliInspectArguments).not.toBe('false')
  })
})
