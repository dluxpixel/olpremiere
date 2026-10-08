// A chunk read for the page: the right bytes, the right length, and no second copy
// of a full chunk on main's thread. See ./readChunk.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readChunk } from './readChunk'

const dir = mkdtempSync(path.join(tmpdir(), 'olp-readchunk-'))
const file = path.join(dir, 'copy.bin')
const bytes = Buffer.from(Array.from({ length: 10_000 }, (_, i) => (i * 7) % 251))
let handle: FileHandle

beforeAll(async () => {
  writeFileSync(file, bytes)
  handle = await open(file, 'r')
})
afterAll(async () => {
  await handle.close()
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('readChunk', () => {
  it('hands a full chunk over as it is, without copying it again', async () => {
    const slice = vi.spyOn(ArrayBuffer.prototype, 'slice')
    const got = await readChunk(handle, 4096, 4096)
    expect(got.byteLength).toBe(4096)
    expect(Buffer.from(got).equals(bytes.subarray(4096, 8192))).toBe(true)
    expect(slice).not.toHaveBeenCalled()
  })

  it('trims the short last chunk to what the file had', async () => {
    const got = await readChunk(handle, 8192, 4096)
    expect(got.byteLength).toBe(10_000 - 8192)
    expect(Buffer.from(got).equals(bytes.subarray(8192))).toBe(true)
  })

  it('reads nothing past the end', async () => {
    expect((await readChunk(handle, 20_000, 4096)).byteLength).toBe(0)
  })
})

// main.ts cannot be imported here (electron), so its half is pinned at the source,
// and run for real by scripts/hidden-app/checks/emoji-font.cjs.
describe("main's app:// files", () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf("protocol.handle('app'"), main.indexOf('ALLOWED_PERMISSIONS'))

  it('are handed over as read, not copied first', () => {
    expect(handler.length).toBeGreaterThan(200)
    expect(handler).not.toContain('new Uint8Array(')
  })

  it('stream the emoji face instead of holding it whole', () => {
    // The route is ./emojiFont emojiFontResponse, run in emojiFont.test.ts.
    expect(handler).toContain('return emojiFontResponse(')
    expect(handler).toContain('() => emojiFont.path(),')
    expect(handler).not.toContain('emojiFont.read()')
    const font = readFileSync(new URL('./emojiFont.ts', import.meta.url), 'utf8')
    const route = font.slice(font.indexOf('export async function emojiFontResponse('))
    expect(route).toContain('handle.createReadStream({ highWaterMark: 4 << 20 })')
    expect(route).not.toMatch(/readFile\(/)
  })
})

describe("main's app:// scheme", () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('keeps the compiled pages, so a launch does not compile the editor from scratch', () => {
    const scheme = main.slice(main.indexOf('protocol.registerSchemesAsPrivileged('), main.indexOf('function createWindow('))
    expect(scheme).toMatch(/scheme: 'app', privileges: \{[^}]*\bstandard: true\b[^}]*\bcodeCache: true\b/)
  })
})
