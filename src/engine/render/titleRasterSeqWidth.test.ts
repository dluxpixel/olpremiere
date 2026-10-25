// The sequence width rasterizeTitle breaks lines at.
//
// The monitor draws a caption small and the export draws it at the export size, and both have to
// break it into the same lines as the sequence does. The line width the breaks are decided at is the
// SEQUENCE's, which a raster cannot give back exactly: the export of a 1081 px wide sequence is 1082 px
// wide at a scale of exactly 1 (exportRaster rounds the width and the height to even separately), and
// the monitor's round(width / scale) is a pixel off on many widths. So preview.ts and exportWorker.ts
// pass the width, and rasterizeTitle hands it to titleLinesAt, also at scale 1.
//
// This file pins the three links of that chain that no other test looked at: rasterizeTitle using the
// width at scale 1, rasterizeTitle using it at the monitor's scale, and the two callers passing it. The
// canvas is a stub whose text width is a fractional number that follows the font size, so a caption can
// be set a fraction of a pixel inside one line width and outside the next.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, type TitleDef } from '../types'

const fillText = vi.fn()

/** Width of one character as a fraction of the font size; set per case so the whole caption is a chosen width at the sequence size. */
let advance = 0.5

/** Just enough 2D context for rasterizeTitle to run headlessly, measuring text by the font size it was given. */
class StubContext {
  font = ''
  textAlign = 'center'
  textBaseline = 'alphabetic'
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 0
  lineCap = 'round'
  lineJoin = 'round'
  shadowBlur = 0
  shadowColor = ''
  shadowOffsetX = 0
  shadowOffsetY = 0
  fillText = fillText
  strokeText = vi.fn()
  beginPath = vi.fn()
  closePath = vi.fn()
  moveTo = vi.fn()
  arcTo = vi.fn()
  fill = vi.fn()
  /** Only the width, which is all wrapLinesWith and inkOfIn's fallback read. */
  measureText(s: string): { width: number } {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0)
    return { width: s.length * size * advance }
  }
}

class StubOffscreenCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext(): unknown {
    return new StubContext()
  }
}

vi.stubGlobal('OffscreenCanvas', StubOffscreenCanvas)

const { clearTitleCache, rasterizeTitle } = await import('./titleRaster')

const TEXT = 'abcdefghi jklmnopqr'
const SIZE = 100
const ONE_LINE = [TEXT]
const TWO_LINES = ['abcdefghi', 'jklmnopqr']

/** A title in 100 px type whose whole line is `widthPx` wide at the sequence size. */
function captionAt(widthPx: number): TitleDef {
  advance = widthPx / (TEXT.length * SIZE)
  return { ...defaultTitleDef(TEXT), fontSizePx: SIZE }
}

/** The lines rasterizeTitle draws, read from the fillText calls it makes. A cached raster draws nothing, so each call starts from an empty cache. */
function drawn(def: TitleDef, width: number, height: number, scale?: number, seqWidth?: number): string[] {
  clearTitleCache()
  fillText.mockClear()
  if (scale === undefined) rasterizeTitle(def, width, height)
  else rasterizeTitle(def, width, height, scale, seqWidth)
  return fillText.mock.calls.map((c) => c[0] as string)
}

beforeEach(() => clearTitleCache())

// A 1081x1350 sequence: its line is 1081 - 2 * round(64.86) = 951 px wide. The export is 1082x1350
// at a scale of exactly 1, where the raster's own line is 952 px. The monitor draws it at 0.25, a raster
// 270 x 338, where round(270 / 0.25) = 1080 would read back a line of 950 px.
const SEQ = { width: 1081, height: 1350 }
const OUT = { width: 1082, height: 1350 }
const MONITOR = { width: 270, height: 338, scale: 0.25 }

describe('rasterizeTitle breaks lines at the sequence width it is given', () => {
  it('a caption 951.5 px wide breaks the same in the 1082 px export as in the 0.25 monitor, because the line is 951', () => {
    const def = captionAt(951.5)
    const monitor = drawn(def, MONITOR.width, MONITOR.height, MONITOR.scale, SEQ.width)
    const exported = drawn(def, OUT.width, OUT.height, 1, SEQ.width)
    expect(monitor).toEqual(TWO_LINES)
    expect(exported).toEqual(TWO_LINES)
  })

  it('the 1082 px export without the width wraps in its own raster, a pixel wider, and keeps the caption on one line', () => {
    const def = captionAt(951.5)
    expect(drawn(def, OUT.width, OUT.height, 1)).toEqual(ONE_LINE)
    expect(drawn(def, OUT.width, OUT.height, 1)).not.toEqual(drawn(def, MONITOR.width, MONITOR.height, MONITOR.scale, SEQ.width))
  })

  it('the monitor uses the width it is given and not round(width / scale), which is 1080 here', () => {
    // 950.5 px fits the sequence's 951 and not the 950 the width read back from the raster would give.
    const def = captionAt(950.5)
    expect(drawn(def, MONITOR.width, MONITOR.height, MONITOR.scale, SEQ.width)).toEqual(ONE_LINE)
    expect(drawn(def, MONITOR.width, MONITOR.height, MONITOR.scale)).toEqual(TWO_LINES)
    // And the export agrees with the monitor given the width.
    expect(drawn(def, OUT.width, OUT.height, 1, SEQ.width)).toEqual(ONE_LINE)
  })

  it('a raster of the sequence width at scale 1 is wrapped as it is, with or without the width', () => {
    const def = captionAt(951.5)
    expect(drawn(def, SEQ.width, SEQ.height, 1, SEQ.width)).toEqual(TWO_LINES)
    expect(drawn(def, SEQ.width, SEQ.height)).toEqual(TWO_LINES)
  })

  it('the same title object asked with and without the width is two different rasters, and the first one comes back', () => {
    const def = captionAt(951.5)
    const withWidth = rasterizeTitle(def, OUT.width, OUT.height, 1, SEQ.width)
    const without = rasterizeTitle(def, OUT.width, OUT.height, 1)
    expect(without).not.toBe(withWidth)
    expect(rasterizeTitle(def, OUT.width, OUT.height, 1, SEQ.width)).toBe(withWidth)
    expect(rasterizeTitle(def, OUT.width, OUT.height, 1)).toBe(without)
  })
})

// The callers have the width and are the only ones who do. A rasterizeTitle that takes it is no use
// if the call that draws the monitor or the export leaves it out, and a call with a scale and no width
// compiles, runs, and breaks a caption a pixel from the limit on the wrong line.
describe('the monitor and the export pass the sequence width to rasterizeTitle', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  /** The arguments of every call to rasterizeTitle in the source, split at the commas outside any bracket. */
  const callsOf = (src: string): string[][] => {
    const calls: string[][] = []
    const re = /\brasterizeTitle\(/g
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (/function\s+$/.test(src.slice(0, m.index))) continue
      const args: string[] = []
      let depth = 1
      let from = re.lastIndex
      for (let i = from; i < src.length && depth > 0; i++) {
        const ch = src[i]!
        if (ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === ')' || ch === ']' || ch === '}') {
          depth--
          if (depth === 0) args.push(src.slice(from, i).trim())
        } else if (ch === ',' && depth === 1) {
          args.push(src.slice(from, i).trim())
          from = i + 1
        }
      }
      calls.push(args.filter((a) => a !== ''))
    }
    return calls
  }

  it('preview.ts passes frameW as the fifth argument of every call that passes a scale', () => {
    const calls = callsOf(read('../preview.ts'))
    const scaled = calls.filter((c) => c.length > 3)
    expect(scaled.length).toBeGreaterThan(0)
    for (const c of scaled) {
      expect(c.length, c.join(', ')).toBe(5)
      expect(c[3], c.join(', ')).toBe('scale')
      expect(c[4], c.join(', ')).toBe('frameW')
    }
  })

  it('exportWorker.ts passes seqW as the fifth argument of every call that passes a scale', () => {
    const calls = callsOf(read('../export/exportWorker.ts'))
    const scaled = calls.filter((c) => c.length > 3)
    expect(scaled.length).toBeGreaterThan(0)
    for (const c of scaled) {
      expect(c.length, c.join(', ')).toBe(5)
      expect(c[3], c.join(', ')).toBe('outH / seqH')
      expect(c[4], c.join(', ')).toBe('seqW')
    }
  })

  it('the scan sees the calls it is about, so it cannot go quiet', () => {
    expect(callsOf(read('../preview.ts')).length).toBeGreaterThanOrEqual(2)
    expect(callsOf(read('../export/exportWorker.ts')).length).toBeGreaterThanOrEqual(2)
  })
})
