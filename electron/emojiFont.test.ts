import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createEmojiFontStore, EMOJI_SOURCE, keepOneStrike } from './emojiFont'

/**
 * A tiny CBDT font with two sizes, 32 and 96 px, one glyph each (index format
 * 1), whose "images" are recognisable bytes. Enough to prove the trim keeps the
 * right size and still points at the right bytes.
 */
function fakeFont(): Buffer {
  const img32 = Buffer.from('thirty-two-px-png')
  const img96 = Buffer.from('ninety-six-px-png-bytes')
  const cbdt = Buffer.concat([Buffer.from([0, 3, 0, 0]), img32, img96])

  // CBLC: header, two BitmapSize records, then one index array + subtable each.
  const indexBlock = (dataOffset: number, len: number): Buffer => {
    const b = Buffer.alloc(8 + 8 + 8)
    b.writeUInt16BE(1, 0) // firstGlyph
    b.writeUInt16BE(1, 2) // lastGlyph
    b.writeUInt32BE(8, 4) // subtable right after the array
    b.writeUInt16BE(1, 8) // indexFormat 1
    b.writeUInt16BE(17, 10) // imageFormat 17 (small metrics + PNG)
    b.writeUInt32BE(dataOffset, 12)
    b.writeUInt32BE(0, 16) // sbitOffsets[0]
    b.writeUInt32BE(len, 20) // sbitOffsets[1]
    return b
  }
  const idx32 = indexBlock(4, img32.length)
  const idx96 = indexBlock(4 + img32.length, img96.length)
  const head = Buffer.alloc(8)
  head.writeUInt16BE(3, 0)
  head.writeUInt32BE(2, 4)
  const size = (arrayOff: number, tablesSize: number, ppem: number): Buffer => {
    const b = Buffer.alloc(48)
    b.writeUInt32BE(arrayOff, 0)
    b.writeUInt32BE(tablesSize, 4)
    b.writeUInt32BE(1, 8)
    b.writeUInt16BE(1, 40)
    b.writeUInt16BE(1, 42)
    b[44] = ppem
    b[45] = ppem
    b[46] = 32
    return b
  }
  const at32 = 8 + 96
  const at96 = at32 + idx32.length
  const cblc = Buffer.concat([head, size(at32, idx32.length, 32), size(at96, idx96.length, 96), idx32, idx96])

  const headTable = Buffer.alloc(54)
  const morx = Buffer.from('apple-only')
  const tables: [string, Buffer][] = [
    ['CBDT', cbdt],
    ['CBLC', cblc],
    ['head', headTable],
    ['morx', morx],
  ]
  const dir = Buffer.alloc(12 + tables.length * 16)
  dir.writeUInt32BE(0x00010000, 0)
  dir.writeUInt16BE(tables.length, 4)
  let off = dir.length
  const bodies: Buffer[] = []
  tables.forEach(([tag, body], i) => {
    dir.write(tag, 12 + i * 16, 'latin1')
    dir.writeUInt32BE(off, 12 + i * 16 + 8)
    dir.writeUInt32BE(body.length, 12 + i * 16 + 12)
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4)
    bodies.push(body, pad)
    off += body.length + pad.length
  })
  return Buffer.concat([dir, ...bodies])
}

function readTables(font: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const o = 12 + i * 16
    const off = font.readUInt32BE(o + 8)
    out.set(font.toString('latin1', o, o + 4), font.subarray(off, off + font.readUInt32BE(o + 12)))
  }
  return out
}

describe('keepOneStrike', () => {
  it('keeps only the largest size, and its glyph still points at its own image', () => {
    const { font, ppem } = keepOneStrike(fakeFont())
    expect(ppem).toBe(96)
    const t = readTables(font)
    const cblc = t.get('CBLC')!
    expect(cblc.readUInt32BE(4)).toBe(1)
    expect(cblc[8 + 44]).toBe(96)
    // Follow the index the way a browser would: size record, array, subtable, data.
    const arrayOff = cblc.readUInt32BE(8)
    const sub = arrayOff + cblc.readUInt32BE(arrayOff + 4)
    const dataOff = cblc.readUInt32BE(sub + 4)
    const end = cblc.readUInt32BE(sub + 12)
    expect(t.get('CBDT')!.subarray(dataOff, dataOff + end).toString()).toBe('ninety-six-px-png-bytes')
    expect(t.get('CBDT')!.toString()).not.toContain('thirty-two')
  })

  it('drops the Apple only tables Chromium never reads', () => {
    const t = readTables(keepOneStrike(fakeFont()).font)
    expect(t.has('morx')).toBe(false)
    expect(t.has('head')).toBe(true)
  })

  it('makes the whole file sum to the font magic, like a real font', () => {
    const { font } = keepOneStrike(fakeFont())
    let sum = 0
    const padded = Buffer.concat([font, Buffer.alloc((4 - (font.length % 4)) % 4)])
    for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0
    expect(sum).toBe(0xb1b0afba)
  })

  it('refuses anything that is not a colour bitmap font', () => {
    expect(() => keepOneStrike(Buffer.from('<html>not found</html>'))).toThrow()
  })
})

describe('createEmojiFontStore', () => {
  const source = fakeFont()
  const good = { url: 'https://example.test/font.ttf', sha256: createHash('sha256').update(source).digest('hex') }

  it('fetches once, trims, keeps it in app data, and never fetches again', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'olp-emoji-'))
    const download = vi.fn(async () => source)
    const store = createEmojiFontStore({ dir, download, source: good })
    const [a, b] = await Promise.all([store.read(), store.read()])
    expect(download).toHaveBeenCalledTimes(1)
    expect(a.equals(b)).toBe(true)
    expect(readTables(a).get('CBLC')![8 + 44]).toBe(96)

    const again = createEmojiFontStore({ dir, download, source: good })
    await again.read()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the download does not match its checksum, and tries again next time', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'olp-emoji-'))
    const download = vi.fn(async () => Buffer.from('a login page'))
    const store = createEmojiFontStore({ dir, download, source: good })
    await expect(store.read()).rejects.toThrow(/checksum/)
    expect(existsSync(path.join(dir, 'apple-emoji.ttf'))).toBe(false)
    await expect(store.read()).rejects.toThrow()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('uses a copy already on disk without touching the network', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'olp-emoji-'))
    writeFileSync(path.join(dir, 'apple-emoji.ttf'), 'kept')
    const download = vi.fn(async () => source)
    const store = createEmojiFontStore({ dir, download })
    expect((await store.read()).toString()).toBe('kept')
    expect(download).not.toHaveBeenCalled()
  })

  it('is pinned to one release and one checksum', () => {
    expect(EMOJI_SOURCE.url).toMatch(/^https:\/\/github\.com\/samuelngs\/apple-emoji-ttf\/releases\/download\/[^/]+\/AppleColorEmoji/)
    expect(EMOJI_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is never shipped inside the app', () => {
    const fonts = readFileSync(new URL('../src/assets/fonts/BUNDLED-FONTS.md', import.meta.url), 'utf8')
    expect(fonts).not.toMatch(/AppleColorEmoji/)
    expect(existsSync(new URL('../src/assets/fonts/AppleColorEmoji.ttf', import.meta.url))).toBe(false)
  })
})
