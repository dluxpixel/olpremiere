// A project file he was saving when the page went away (a reload, a crash, a quit).
// Real folders in the system temp, because what matters is what is left on disk: a
// hidden `.olpart` beside his file, as big as the project, that no sweep looks for.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(path.join(tmpdir(), 'olp-savedrop-'))
let chosen = ''
vi.mock('electron', () => ({
  app: { getPath: () => root },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: chosen }) },
}))
const saveFiles = await import('./saveFiles')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(root, 'his-folder-'))
})

/** Pick a file in the (fake) dialog, open it and write one chunk, the way the page does. */
async function halfWritten(name: string): Promise<number> {
  chosen = path.join(dir, name)
  await saveFiles.pickSavePath({} as never, 'project', 'x', 'olstudio', 'Project')
  const id = await saveFiles.openForWrite(chosen)
  await saveFiles.writeChunk(id, new Uint8Array(1024).buffer)
  expect(existsSync(`${chosen}.olpart`)).toBe(true)
  return id
}

describe('a save cut short by the page going away', () => {
  it('leaves nothing in his folder after a reload or a crash', async () => {
    const id = await halfWritten('Green.olstudio')
    await saveFiles.dropWrites()
    expect(readdirSync(dir)).toEqual([])
    // And the page that comes next cannot write into it by its old number.
    await expect(saveFiles.writeChunk(id, new Uint8Array(8).buffer)).rejects.toThrow('No such file open')
  })

  it('leaves nothing in his folder after a quit, which cannot wait', async () => {
    await halfWritten('Blue.olstudio')
    await halfWritten('Red.olstudio')
    saveFiles.dropWritesSync()
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves a finished save alone', async () => {
    const id = await halfWritten('Done.olstudio')
    await saveFiles.closeWrite(id, true)
    await saveFiles.dropWrites()
    saveFiles.dropWritesSync()
    expect(readdirSync(dir)).toEqual(['Done.olstudio'])
  })
})

describe('main drops them', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('when the editor page goes away, with the other orphans', () => {
    const orphans = main.slice(main.indexOf('const dropOrphans = ('), main.indexOf("win.webContents.on('did-start-navigation'"))
    expect(orphans).toContain('void saveFiles.dropWrites()')
  })

  it('when the app quits', () => {
    const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf('cutstudio.stop()'))
    expect(quit).toContain('saveFiles.dropWritesSync()')
  })
})
