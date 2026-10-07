// Reading Preferences.json back. "No file" has to mean there is none: the
// renderer writes over a file it was told is not there, and this one can hold
// the only copy of his saved moves and track setups.
//
// Real files in a temp folder, like projectFiles.test.ts.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({
  app: {
    getName: () => 'OL Premiere',
    getPath: (k: string) => ({ documents: 'C:/Users/skyle/Documents', userData })[k],
  },
}))

const { preferencesFilePath, readPreferencesFile } = await import('./preferencesFile')

/** Every test runs as a throwaway profile, so the folder is the temp one, never his Documents. */
const realArgv = process.argv
beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'olp-prefs-'))
  process.argv = ['electron.exe', '.', `--user-data-dir=${userData}`]
})
afterEach(async () => {
  process.argv = realArgv
  await rm(userData, { recursive: true, force: true })
})

describe('reading the preferences file', () => {
  it('reads what is there', async () => {
    await mkdir(path.dirname(preferencesFilePath()), { recursive: true })
    await writeFile(preferencesFilePath(), '{"kind":"ol-premiere-preferences"}', 'utf8')
    expect(await readPreferencesFile()).toBe('{"kind":"ol-premiere-preferences"}')
  })

  it('says there is none only when there is none', async () => {
    expect(await readPreferencesFile()).toBeNull()
  })

  it('⛔ a file that is there but cannot be read is an error, never "no file"', async () => {
    // A folder where the file should be stands in for a file another program
    // holds, or a cloud placeholder that cannot be fetched: there, unreadable.
    await mkdir(preferencesFilePath(), { recursive: true })
    await expect(readPreferencesFile()).rejects.toThrow()
  })
})
