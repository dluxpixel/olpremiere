// Shared title rasterizer. Runs in BOTH the main thread (preview.ts) and the
// export worker (exportWorker.ts), so it may only touch OffscreenCanvas, never
// document/window. Preview and export call rasterizeTitle with identical def +
// dims and hit the SAME cache, so the pixels are byte-for-byte identical.

import { scaleTitleDef, type TitleDef } from '../types'

// ---------------------------------------------------------------------------
// Pure helpers (no canvas), unit-tested in node.

/**
 * Greedy word-wrap driven by a measure() callback instead of a canvas context,
 * so it is testable without OffscreenCanvas. Hard-wraps on '\n' first, then
 * greedily packs words into each paragraph up to maxWidthPx. A single word
 * wider than maxWidth is NOT broken: it stays alone on its own line.
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
// Layout: where the text actually lands inside the frame.

export interface TitleLayout {
  sidePad: number
  padPx: number
  maxWidth: number
  lines: string[]
  hasText: boolean
  lineHeightPx: number
  firstBaselineY: number
  blockTop: number
  blockH: number
  /** Widest measured line, 0 when there is no text. */
  textW: number
  /** X the lines are drawn from, matching ctx.textAlign. */
  anchorX: number
}

/**
 * Everything about WHERE a title's text sits. `measure` reports the width of a
 * string in the title's font (the caller owns the font state), the same
 * injection wrapLinesWith uses, so this is testable without a canvas.
 *
 * Shared by the rasterizer and by hit-testing so the two can never disagree
 * about where a caption is. The renderer draws into a full-frame canvas, but
 * the ink is only ever a small part of it.
 */
export function titleLayout(
  def: TitleDef,
  width: number,
  height: number,
  measure: (s: string) => number,
): TitleLayout {
  const sidePad = Math.round(width * 0.06)
  const padPx = Math.round(height * 0.06)
  const maxWidth = Math.max(1, width - 2 * sidePad)

  const fontSizeOk = def.fontSizePx > 0

  // Non-destructive case: the typed text stays put; only the drawn glyphs change.
  const shownText =
    def.textCase === 'upper' ? def.text.toUpperCase() : def.textCase === 'lower' ? def.text.toLowerCase() : def.text
  const lines = fontSizeOk ? wrapLinesWith(measure, shownText, maxWidth) : ['']
  const hasText = fontSizeOk && shownText !== '' && lines.some((l) => l !== '')
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
      const w = measure(line)
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

  return { sidePad, padPx, maxWidth, lines, hasText, lineHeightPx, firstBaselineY, blockTop, blockH, textW, anchorX }
}

/** Left edge of the text block for the current alignment. */
function textLeftOf(anchorX: number, textW: number, align: TitleDef['align']): number {
  if (align === 'left') return anchorX
  if (align === 'right') return anchorX - textW
  return anchorX - textW / 2
}

// One shared 1×1 canvas for measurement-only calls; its size never matters
// because nothing is drawn into it.
let measureCtx: OffscreenCanvasRenderingContext2D | null = null

/** Text measurer for `def`'s font, or null where there is no canvas (node). */
function canvasMeasurer(def: TitleDef): ((s: string) => number) | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  if (!measureCtx) measureCtx = new OffscreenCanvas(1, 1).getContext('2d')
  const ctx = measureCtx
  if (!ctx) return null
  ctx.font = fontString(def)
  return (str) => ctx.measureText(str).width
}

/**
 * The rectangle a title's INK actually occupies inside its frame, as fractions
 * of the frame (0..1), including its box, outline and shadow.
 *
 * A title rasterizes into a FULL-FRAME texture, so treating the texture as the
 * clip's shape makes every caption's hit area the whole picture: once captions
 * exist, clicking anywhere in the monitor selects a caption and the footage
 * underneath can never be clicked at all. Returns null when the title draws
 * nothing (empty text, no box), which is not selectable either.
 */
export function titleInkBoxUV(
  def: TitleDef,
  width: number,
  height: number,
  measure: ((s: string) => number) | null = canvasMeasurer(def),
): { u0: number; v0: number; u1: number; v1: number } | null {
  if (width <= 0 || height <= 0 || !measure) return null
  const L = titleLayout(def, width, height, measure)

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (ax0: number, ay0: number, ax1: number, ay1: number) => {
    if (ax1 <= ax0 || ay1 <= ay0) return
    x0 = Math.min(x0, ax0)
    y0 = Math.min(y0, ay0)
    x1 = Math.max(x1, ax1)
    y1 = Math.max(y1, ay1)
  }

  if (L.hasText) {
    const left = textLeftOf(L.anchorX, L.textW, def.align)
    // The outline strokes OUTWARD by half its width; the shadow offsets and blurs.
    const grow = def.outline && def.outline.widthPx > 0 ? def.outline.widthPx / 2 : 0
    add(left - grow, L.blockTop - grow, left + L.textW + grow, L.blockTop + L.blockH + grow)
    if (def.shadow) {
      const b = def.shadow.blurPx
      add(
        left - grow + def.shadow.dx - b,
        L.blockTop - grow + def.shadow.dy - b,
        left + L.textW + grow + def.shadow.dx + b,
        L.blockTop + L.blockH + grow + def.shadow.dy + b,
      )
    }
  }

  if (def.box) {
    const pad = def.box.paddingPx
    const boxW = L.hasText ? L.textW + 2 * pad : L.maxWidth + 2 * pad
    const boxLeft = L.hasText
      ? textLeftOf(L.anchorX, L.textW, def.align) - pad
      : textLeftOf(L.anchorX, L.maxWidth, def.align) - pad
    add(boxLeft, L.blockTop - pad, boxLeft + boxW, L.blockTop + L.blockH + pad)
  }

  if (!Number.isFinite(x0)) return null
  // The raster clips to the frame, so the hit area does too.
  return {
    u0: Math.max(0, x0 / width),
    v0: Math.max(0, y0 / height),
    u1: Math.min(1, x1 / width),
    v1: Math.min(1, y1 / height),
  }
}

// ---------------------------------------------------------------------------
// Rasterization.

interface CacheEntry {
  key: string
  canvas: OffscreenCanvas
  /** The def that keys this entry in identityCache, so eviction can drop it too. */
  def: TitleDef
}

/**
 * Memory the rasterized-title cache may hold, in bytes.
 *
 * This was a COUNT of 32, which says nothing about memory: every entry is a
 * FULL-FRAME canvas, so 32 of them is 8 MB at 640x360 and 265 MB on a 1080x1920
 * Short. A word-caption timeline makes one entry per word, so the large case is
 * the normal one. Counting bytes turns the guess into a policy.
 */
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024

/** RGBA bytes one rasterized title holds. */
const canvasBytes = (c: OffscreenCanvas): number => Math.max(1, c.width * c.height * 4)

// Insertion-ordered LRU-ish list; oldest at index 0, evicted first.
const cache: CacheEntry[] = []
let cacheBytes = 0

// Per-frame fast path: the SAME TitleDef object is drawn every frame during
// playback (the def lives on the clip, unchanged until an edit makes a new one).
// Keying a WeakMap by that object identity skips the JSON.stringify + linear scan
// of the string cache on every hit. An edit → new def object → miss → re-raster.
//
// It is a WeakMap, but its keys are the STORE's own TitleDef objects, which live
// as long as the project does, so an entry left here pins a full sequence-
// resolution canvas (a 1080x1920 Short = 8.3 MB) for the whole session. Every
// eviction from the bounded list MUST delete the matching identity entry, or a
// word-caption timeline (one title clip per word) retains one canvas per word and
// CACHE_LIMIT bounds nothing.
let identityCache = new WeakMap<TitleDef, { w: number; h: number; canvas: OffscreenCanvas }>()

export function clearTitleCache(): void {
  cache.length = 0
  cacheBytes = 0
  identityCache = new WeakMap()
}

/** Bytes the title cache is currently holding (for tests and diagnostics). */
export const titleCacheBytes = (): number => cacheBytes

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
 * is cached by JSON(def)+dims, and identical inputs return the SAME canvas
 * instance, so preview and export rasterize identically. Never throws.
 */
export function rasterizeTitle(
  defIn: TitleDef,
  width: number,
  height: number,
  /**
   * Raster height ÷ SEQUENCE height. A title's metrics are absolute sequence px,
   * so drawing it into a different raster has to bring them along:
   *   - the PREVIEW passes < 1 and draws a small canvas. A 1080×1920 caption is an
   *     8.3 MB allocation plus a full-frame text raster on the main thread plus a
   *     texture upload and mipmap, and on a 2-word caption cadence that fires
   *     roughly twice a second DURING playback. At preview size it is a fraction
   *     of that, and identical on screen.
   *   - the EXPORT passes > 1 when it upscales, which genuinely sharpens: font
   *     outlines are the only thing in the frame with real detail left to give,
   *     and rasterizing at the sequence size threw it away.
   * 1 keeps the old behaviour byte for byte.
   */
  scale = 1,
): OffscreenCanvas {
  const fast = identityCache.get(defIn)
  if (fast && fast.w === width && fast.h === height) return fast.canvas
  // Everything below reads the SCALED def; the identity cache stays keyed on the
  // caller's original object, which is the one the store holds.
  const def = scaleTitleDef(defIn, scale)
  const key = cacheKey(def, width, height)
  const hitIdx = cache.findIndex((e) => e.key === key)
  if (hitIdx !== -1) {
    const [hit] = cache.splice(hitIdx, 1)
    // Re-key the entry to the def we were just handed: that is the object the
    // identity map now points at, so it is the one eviction has to clear.
    if (hit.def !== defIn) identityCache.delete(hit.def)
    hit.def = defIn
    cache.push(hit) // touch → most-recently-used
    identityCache.set(defIn, { w: width, h: height, canvas: hit.canvas })
    return hit.canvas
  }

  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  const ctx = canvas.getContext('2d')!

  ctx.font = fontString(def)
  ctx.textAlign = def.align
  ctx.textBaseline = 'alphabetic'

  const { maxWidth, lines, hasText, lineHeightPx, firstBaselineY, blockTop, blockH, textW, anchorX } = titleLayout(
    def,
    width,
    height,
    (str) => ctx.measureText(str).width,
  )

  // BOX: drawn behind the text. If there is no text but a box is set, draw a
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

  // TEXT: optional outline (stroke) then fill, with an optional shadow. Guard
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

  cache.push({ key, canvas, def: defIn })
  cacheBytes += canvasBytes(canvas)
  // Always keep the raster we were just asked for, even if it alone exceeds the
  // budget, because refusing it would re-rasterize it on the very next frame.
  while (cacheBytes > CACHE_BUDGET_BYTES && cache.length > 1) {
    const evicted = cache.shift()
    if (!evicted) break
    cacheBytes -= canvasBytes(evicted.canvas)
    identityCache.delete(evicted.def)
  }
  identityCache.set(defIn, { w: width, h: height, canvas })
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
