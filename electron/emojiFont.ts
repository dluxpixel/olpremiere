// The Apple emoji face, fetched onto THIS computer the first time a title needs
// it. His ask, 2026-09-28: *"make it so when I play, paste in emojis, it's the
// Apple emojis."*
//
// ⛔ IT IS NEVER SHIPPED IN THE APP. Apple does not give its emoji out, and this
// repo and its releases are public: a copy of Apple's font inside the installer
// would be Apple's font published for anyone to download, and a takedown of
// the repo would also take down his update feed. So the app fetches the copy
// he approved (github.com/samuelngs/apple-emoji-ttf, 2026-09-28) straight onto
// his machine, the same as installing a font for himself, and keeps it in his
// app data. The renderer asks for it at app://<host>/user-fonts/apple-emoji.ttf,
// and that request is what starts the fetch.
//
// The source carries every emoji at twelve sizes, 20 to 96 px a side. Only the
// largest is kept: a title draws emoji at caption size, the browser scales it
// down cleanly for small text, and nothing sharper exists in the source.
// Dropping the rest is most of the file, and the file is what sits in memory
// while a title with an emoji is on screen.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Pinned to one release and one checksum, so the bytes can never change under him. */
export const EMOJI_SOURCE = {
  url: 'https://github.com/samuelngs/apple-emoji-ttf/releases/download/macos-26-20260722-484daf4e/AppleColorEmoji-Linux.ttf',
  sha256: 'e37c7af6265ac4a0af6d57bc65e86109a776d9966e8343334557f63da482516f',
}

/** The path the renderer asks for under app://. */
export const EMOJI_ROUTE = '/user-fonts/apple-emoji.ttf'

/** Tables Chromium never reads (Apple's own shaping and tracking), and a signature this edit breaks. */
const DROP_TABLES = new Set(['DSIG', 'morx', 'feat', 'trak', 'bgcl'])

/**
 * Keep one bitmap size of a CBDT colour font: `ppem`, or the largest when 0.
 * Pure. Throws on anything that is not a CBDT font it understands, so a bad
 * download is never written out as a font.
 */
export function keepOneStrike(buf: Buffer, ppem = 0): { font: Buffer; ppem: number } {
  if (buf.length < 12) throw new Error('not a font')
  const numTables = buf.readUInt16BE(4)
  const tables = new Map<string, { off: number; len: number }>()
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    tables.set(buf.toString('latin1', o, o + 4), { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) })
  }
  const cblc = tables.get('CBLC')
  const cbdt = tables.get('CBDT')
  if (!cblc || !cbdt || !tables.has('head')) throw new Error('not a CBDT colour font')

  const numSizes = buf.readUInt32BE(cblc.off + 4)
  let pick = -1
  let picked = 0
  for (let i = 0; i < numSizes; i++) {
    const p = buf[cblc.off + 8 + i * 48 + 44]!
    if (ppem ? p === ppem : p > picked) {
      pick = i
      picked = p
    }
  }
  if (pick < 0) throw new Error(`no ${ppem} px size in the font`)

  const recAt = cblc.off + 8 + pick * 48
  const sizeRec = Buffer.from(buf.subarray(recAt, recAt + 48))
  const arrayOff = sizeRec.readUInt32BE(0)
  const tablesSize = sizeRec.readUInt32BE(4)
  const subCount = sizeRec.readUInt32BE(8)
  const index = Buffer.from(buf.subarray(cblc.off + arrayOff, cblc.off + arrayOff + tablesSize))

  // Copy the image data each index subtable points at, and point it at the copy.
  const parts: Buffer[] = [Buffer.from([0, 3, 0, 0])] // CBDT version 3.0
  let dataLen = 4
  for (let k = 0; k < subCount; k++) {
    const first = index.readUInt16BE(k * 8)
    const last = index.readUInt16BE(k * 8 + 2)
    const sub = index.readUInt32BE(k * 8 + 4)
    const indexFormat = index.readUInt16BE(sub)
    const imageDataOffset = index.readUInt32BE(sub + 4)
    const n = last - first + 1
    let end: number
    if (indexFormat === 1) end = index.readUInt32BE(sub + 8 + n * 4)
    else if (indexFormat === 2) end = index.readUInt32BE(sub + 8) * n
    else if (indexFormat === 3) end = index.readUInt16BE(sub + 8 + n * 2)
    else if (indexFormat === 4) end = index.readUInt16BE(sub + 12 + index.readUInt32BE(sub + 8) * 4 + 2)
    else if (indexFormat === 5) end = index.readUInt32BE(sub + 8) * index.readUInt32BE(sub + 20)
    else throw new Error(`index format ${indexFormat} is not handled`)
    parts.push(buf.subarray(cbdt.off + imageDataOffset, cbdt.off + imageDataOffset + end))
    index.writeUInt32BE(dataLen, sub + 4)
    dataLen += end
  }

  const cblcHead = Buffer.alloc(8)
  cblcHead.writeUInt16BE(3, 0)
  cblcHead.writeUInt32BE(1, 4)
  sizeRec.writeUInt32BE(8 + 48, 0)

  const out = new Map<string, Buffer>()
  for (const [tag, t] of tables) {
    if (DROP_TABLES.has(tag)) continue
    out.set(tag, Buffer.from(buf.subarray(t.off, t.off + t.len)))
  }
  out.set('CBDT', Buffer.concat(parts))
  out.set('CBLC', Buffer.concat([cblcHead, sizeRec, index]))
  out.get('head')!.writeUInt32BE(0, 8) // checkSumAdjustment, set once the file is whole

  const tags = [...out.keys()].sort()
  const entrySelector = Math.floor(Math.log2(tags.length))
  const searchRange = 2 ** entrySelector * 16
  const header = Buffer.alloc(12 + tags.length * 16)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tags.length, 4)
  header.writeUInt16BE(searchRange, 6)
  header.writeUInt16BE(entrySelector, 8)
  header.writeUInt16BE(tags.length * 16 - searchRange, 10)
  let offset = header.length
  const bodies: Buffer[] = []
  tags.forEach((tag, i) => {
    const body = out.get(tag)!
    const o = 12 + i * 16
    header.write(tag, o, 'latin1')
    header.writeUInt32BE(tableChecksum(body), o + 4)
    header.writeUInt32BE(offset, o + 8)
    header.writeUInt32BE(body.length, o + 12)
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4)
    bodies.push(body, pad)
    offset += body.length + pad.length
  })
  const font = Buffer.concat([header, ...bodies])
  const headAt = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8)
  font.writeUInt32BE((0xb1b0afba - tableChecksum(font)) >>> 0, headAt + 8)
  return { font, ppem: picked }
}

function tableChecksum(b: Buffer): number {
  let sum = 0
  const whole = b.length - (b.length % 4)
  for (let i = 0; i < whole; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0
  if (whole < b.length) {
    const tail = Buffer.alloc(4)
    b.copy(tail, 0, whole)
    sum = (sum + tail.readUInt32BE(0)) >>> 0
  }
  return sum
}

export interface EmojiFontDeps {
  /** Where the kept copy lives: his app data, never the install folder. */
  dir: string
  /** Fetch the source font's bytes. */
  download: (url: string) => Promise<Buffer>
  /** Tests only: a source other than the pinned one. */
  source?: { url: string; sha256: string }
}

/**
 * The path of the trimmed Apple emoji font on this computer, fetching and
 * trimming it the first time. One fetch at a time: every request while it runs
 * waits on the same one. A failed fetch is not remembered, so the next title
 * with an emoji tries again (he may just have been offline).
 */
export function createEmojiFontStore(deps: EmojiFontDeps) {
  const target = path.join(deps.dir, 'apple-emoji.ttf')
  let pending: Promise<string> | null = null

  const fetchOnce = async (): Promise<string> => {
    try {
      if ((await stat(target)).size > 0) return target
    } catch {
      // Not fetched yet.
    }
    const from = deps.source ?? EMOJI_SOURCE
    const source = await deps.download(from.url)
    const sha = createHash('sha256').update(source).digest('hex')
    if (sha !== from.sha256) throw new Error('the emoji font download did not match its checksum')
    const { font } = keepOneStrike(source)
    await mkdir(deps.dir, { recursive: true })
    const temp = `${target}.part`
    await writeFile(temp, font)
    await rename(temp, target).catch(async (err: unknown) => {
      await unlink(temp).catch(() => undefined)
      throw err
    })
    return target
  }

  const fontPath = (): Promise<string> => {
    pending ??= fetchOnce().catch((err: unknown) => {
      pending = null
      throw err
    })
    return pending
  }

  return {
    path: fontPath,
    read: async (): Promise<Buffer> => readFile(await fontPath()),
  }
}

/**
 * The real download. Main passes Electron's net.fetch: Node's own fetch took over
 * two minutes for this file inside the app, Chromium's network stack a fraction of
 * that. Either follows GitHub's redirect to the file.
 */
export async function downloadBytes(url: string, fetchImpl: (url: string) => Promise<Response> = fetch): Promise<Buffer> {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`the emoji font download answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
