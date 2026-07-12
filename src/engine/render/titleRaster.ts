// Shared title rasterizer. Runs in BOTH the main thread (preview.ts) and the
// export worker (exportWorker.ts), so it may only touch OffscreenCanvas — no
// document/window. Preview and export call rasterizeTitle with identical def +
// dims and hit the SAME cache, so the pixels are byte-for-byte identical.

import type { TitleDef } from '../types'

// ---------------------------------------------------------------------------
// Pure helpers (no canvas) — unit-tested in node.

/**
 * Greedy word-wrap driven by a measure() callback instead of a canvas context,
 * so it is testable without OffscreenCanvas. Hard-wraps on '\n' first, then
 * greedily packs words into each paragraph up to maxWidthPx. A single word
 * wider than maxWidth is NOT broken — it stays alone on its own line.
 */
export function wrapLinesWith(
  measure: (s: string) => number,
  text: string,
  maxWidthPx: number,
): string[] {
  const out: string[] = []
  // '\n' hard breaks are authored line boundaries; each becomes its own block.
  const paragraphs = text.split('\n')
  for (const para of paragraphs) {
    const words = para.split(' ')
    let line = ''
    for (const word of words) {
      // Skip empty tokens from doubled spaces so they don't force blank lines,
      // but preserve a genuinely empty paragraph (handled after the loop).
      if (word === '') continue
      const candidate = line === '' ? word : `${line} ${word}`
      if (line !== '' && measure(candidate) > maxWidthPx) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    // A paragraph always contributes at least one line (possibly empty), so an
    // empty string / blank paragraph round-trips to a single '' line.
    out.push(line)
  }
  return out
}

/** Canvas-backed wrap used by rasterizeTitle; delegates to wrapLinesWith. */
export function wrapLines(
  ctx: { measureText: (s: string) => { width: number } },
  text: string,
  maxWidthPx: number,
): string[] {
  return wrapLinesWith((s) => ctx.measureText(s).width, text, maxWidthPx)
}

/**
 * Vertical placement of the text block. Returns the baseline y of the FIRST
 * line plus the block's bounding box (top + height). Baselines advance by
 * lineHeightPx; the block top sits one ascent (~0.8 * lineHeight) above the
 * first baseline so top/bottom padding measure against the visual glyph box.
 */
export function blockLayout(opts: {
  lines: string[]
  lineHeightPx: number
  vAlign: 'top' | 'middle' | 'bottom'
  frameH: number
  padPx: number
  offsetYPx: number
}): { firstBaselineY: number; blockTop: number; blockH: number } {
  const { lines, lineHeightPx, vAlign, frameH, padPx, offsetYPx } = opts
  const n = Math.max(lines.length, 1)
  const blockH = n * lineHeightPx
  // Approx ascent within a line box; keeps the visual block inside the padding.
  const ascent = lineHeightPx * 0.8
  let blockTop: number
  if (vAlign === 'top') {
    blockTop = padPx
  } else if (vAlign === 'bottom') {
    blockTop = frameH - padPx - blockH
  } else {
    blockTop = (frameH - blockH) / 2
  }
  blockTop += offsetYPx
  const firstBaselineY = blockTop + ascent
  return { firstBaselineY, blockTop, blockH }
}

// ---------------------------------------------------------------------------
// Rasterization.

interface CacheEntry {
  key: string
  canvas: OffscreenCanvas
}

const CACHE_LIMIT = 32
// Insertion-ordered LRU-ish list; oldest at index 0, evicted first.
const cache: CacheEntry[] = []

export function clearTitleCache(): void {
  cache.length = 0
}

function cacheKey(def: TitleDef, width: number, height: number): string {
  return `${JSON.stringify(def)}|${width}x${height}`
}

function fontString(def: TitleDef): string {
  const style = def.italic ? 'italic ' : ''
  const weight = def.bold ? '700' : '400'
  return `${style}${weight} ${def.fontSizePx}px ${def.fontFamily}`
}

/**
 * Rasterize a title into a width×height OffscreenCanvas at sequence resolution
 * (so text is crisp at output res). Transparent except the optional box. Result
 * is cached by JSON(def)+dims — identical inputs return the SAME canvas
 * instance, so preview and export rasterize identically. Never throws.
 */
export function rasterizeTitle(def: TitleDef, width: number, height: number): OffscreenCanvas {
  const key = cacheKey(def, width, height)
  const hitIdx = cache.findIndex((e) => e.key === key)
  if (hitIdx !== -1) {
    const [hit] = cache.splice(hitIdx, 1)
    cache.push(hit) // touch → most-recently-used
    return hit.canvas
  }

  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  const ctx = canvas.getContext('2d')!

  const sidePad = Math.round(width * 0.06)
  const padPx = Math.round(height * 0.06)
  const maxWidth = Math.max(1, width - 2 * sidePad)

  const fontSizeOk = def.fontSizePx > 0
  ctx.font = fontString(def)
  ctx.textAlign = def.align
  ctx.textBaseline = 'alphabetic'

  const lines = fontSizeOk ? wrapLines(ctx, def.text, maxWidth) : ['']
  const hasText = fontSizeOk && def.text !== '' && lines.some((l) => l !== '')
  const lineHeightPx = fontSizeOk ? def.fontSizePx * def.lineHeight : 0

  const { firstBaselineY, blockTop, blockH } = blockLayout({
    lines,
    lineHeightPx,
    vAlign: def.vAlign,
    frameH: height,
    padPx,
    offsetYPx: def.offsetYPx,
  })

  // Widest measured line → text-block width (0 when there is no text).
  let textW = 0
  if (hasText) {
    for (const line of lines) {
      const w = ctx.measureText(line).width
      if (w > textW) textW = w
    }
  }

  // X anchor by alignment (matches ctx.textAlign, offset by offsetXPx).
  let anchorX: number
  if (def.align === 'left') {
    anchorX = sidePad + def.offsetXPx
  } else if (def.align === 'right') {
    anchorX = width - sidePad + def.offsetXPx
  } else {
    anchorX = width / 2 + def.offsetXPx
  }

  // BOX — drawn behind the text. If there is no text but a box is set, draw a
  // plain rectangle centered on the block (the "basic shape" path).
  if (def.box) {
    const pad = def.box.paddingPx
    let boxW: number
    let boxLeft: number
    if (hasText) {
      boxW = textW + 2 * pad
      // Box hugs the text; its left edge depends on the text alignment.
      let textLeft: number
      if (def.align === 'left') textLeft = anchorX
      else if (def.align === 'right') textLeft = anchorX - textW
      else textLeft = anchorX - textW / 2
      boxLeft = textLeft - pad
    } else {
      // No text: a shape sized off the usable width, anchored like the text.
      boxW = maxWidth + 2 * pad
      if (def.align === 'left') boxLeft = anchorX - pad
      else if (def.align === 'right') boxLeft = anchorX - maxWidth - pad
      else boxLeft = anchorX - maxWidth / 2 - pad
    }
    const boxTop = blockTop - pad
    const boxH = blockH + 2 * pad

    // Clamp to the canvas so the shape never spills off-frame.
    const x0 = Math.max(0, boxLeft)
    const y0 = Math.max(0, boxTop)
    let x1 = Math.min(width, boxLeft + boxW)
    let y1 = Math.min(height, boxTop + boxH)
    if (x1 < x0) x1 = x0
    if (y1 < y0) y1 = y0
    const w = x1 - x0
    const h = y1 - y0
    if (w > 0 && h > 0) {
      const r = Math.max(0, Math.min(def.box.radiusPx, w / 2, h / 2))
      ctx.beginPath()
      roundRect(ctx, x0, y0, w, h, r)
      ctx.fillStyle = def.box.color
      ctx.fill()
    }
  }

  // TEXT — optional outline (stroke) then fill, with an optional shadow. Guard
  // against no text / bad font size.
  if (hasText) {
    const hasOutline = !!def.outline && def.outline.widthPx > 0
    const clearShadow = (): void => {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }
    if (def.shadow) {
      ctx.shadowColor = def.shadow.color
      ctx.shadowBlur = def.shadow.blurPx
      ctx.shadowOffsetX = def.shadow.dx
      ctx.shadowOffsetY = def.shadow.dy
    }

    // Outline is the BOTTOM layer: it (not the fill) casts the shadow, and the
    // fill lands crisply on top so only the outer half of the stroke shows.
    if (hasOutline) {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.strokeStyle = def.outline!.color
      ctx.lineWidth = def.outline!.widthPx
      let y = firstBaselineY
      for (const line of lines) {
        if (line !== '') ctx.strokeText(line, anchorX, y)
        y += lineHeightPx
      }
      if (def.shadow) clearShadow() // the fill on top must not double the shadow
    }

    ctx.fillStyle = def.color
    let y = firstBaselineY
    for (const line of lines) {
      if (line !== '') ctx.fillText(line, anchorX, y)
      y += lineHeightPx
    }
    // Reset so a later cached draw on this ctx can't inherit the shadow.
    if (def.shadow && !hasOutline) clearShadow()
  }

  cache.push({ key, canvas })
  if (cache.length > CACHE_LIMIT) cache.shift() // evict oldest
  return canvas
}

/** Rounded-rect path; roundRect() isn't in every OffscreenCanvas ctx yet. */
function roundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
