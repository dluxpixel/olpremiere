// What a page cannot make main do, and what the packaged exe refuses to become.
// Source level, like src/desktopInstall.test.ts: a drift here breaks no build and no
// other test, it only quietly opens a door again.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
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

  it('a finished movie spends that answer, so the next export asks again', () => {
    const finish = main.slice(main.indexOf("ipcMain.handle('native:finish'"), main.indexOf("ipcMain.handle('native:cancel'"))
    expect(finish).toMatch(/if \(done\.ok\) exportPathUsed\(done\.outPath\)/)
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
