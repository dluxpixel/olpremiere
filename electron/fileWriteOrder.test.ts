// His preferences, caption styles and Library each live in ONE file beside his
// projects, written whole through one temp file beside it. Two writes of the
// same file used to run side by side: both opened that one temp file, the
// second rename found it gone, and in the narrow case where one truncated it
// under the other the file was left as one JSON with the tail of another, which
// nothing can read back.
//
// The disk is faked down to a write that lands when the test says so, because
// the order is the whole point.

import { afterEach, describe, expect, it, vi } from 'vitest'

const disk = new Map<string, string>()
const log: string[] = []
/** One resolver per temp file write still on its way to disk. */
const landing: (() => void)[] = []
let failNext = false
const base = (p: string): string => p.replace(/^.*[\\/]/, '')

vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  readFile: async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
  writeFile: async (p: string, data: string) => {
    log.push(`write ${base(p)} ${data}`)
    if (failNext) {
      failNext = false
      throw new Error('EPERM: operation not permitted, open')
    }
    await new Promise<void>((resolve) => landing.push(resolve))
    disk.set(p, data)
  },
  rename: async (from: string, to: string) => {
    const v = disk.get(from)
    if (v === undefined) throw Object.assign(new Error(`ENOENT: no such file, rename '${from}'`), { code: 'ENOENT' })
    disk.delete(from)
    disk.set(to, v)
    log.push(`rename ${base(to)} ${v}`)
  },
}))
vi.mock('./projectFiles', () => ({ projectDir: () => 'X:/OL Premiere Projects' }))

const { writePreferencesFile, preferencesFilePath } = await import('./preferencesFile')
const { writeCaptionStylesFile, captionStylesFilePath } = await import('./captionStylesFile')
const { writeLibraryFile, libraryFilePath } = await import('./libraryFile')

/** Let every write land, in the order they reach the disk. */
async function landAll(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r))
    landing.shift()?.()
  }
}

afterEach(() => {
  disk.clear()
  log.length = 0
  landing.length = 0
  failNext = false
})

const writers = [
  { name: 'Preferences.json', write: writePreferencesFile, path: preferencesFilePath },
  { name: 'Caption styles.json', write: writeCaptionStylesFile, path: captionStylesFilePath },
  { name: 'Library.json', write: writeLibraryFile, path: libraryFilePath },
]

describe.each(writers)('two writes of $name at once', ({ name, write, path }) => {
  it('go one after the other, and the last one asked for is the file', async () => {
    const first = write('{"n":1}')
    const second = write('{"n":2}')
    await landAll()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(log).toEqual([
      `write ${name}.tmp {"n":1}`,
      `rename ${name} {"n":1}`,
      `write ${name}.tmp {"n":2}`,
      `rename ${name} {"n":2}`,
    ])
    expect(disk.get(path())).toBe('{"n":2}')
  })

  it('a write that fails does not stop the one after it', async () => {
    failNext = true
    const first = write('{"n":1}')
    const second = write('{"n":2}')
    await landAll()
    await expect(first).rejects.toThrow(/EPERM/)
    await expect(second).resolves.toBeUndefined()
    expect(disk.get(path())).toBe('{"n":2}')
  })
})
