// Shared title rasterizer. Runs in BOTH the main thread (preview.ts) and the
// export worker (exportWorker.ts), so it may only touch OffscreenCanvas, never
// document/window. Preview and export call rasterizeTitle with identical def +
// dims and hit the SAME cache, so the pixels are byte-for-byte identical.

import { POP_EMPHASIS_BOOST, scaleTitleDef, splitWords, type TitleDef } from '../types'
import { appleEmojiFor, EMOJI_STACK } from './emojiFont'

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
  /**
   * Lines already decided elsewhere, used as they are instead of wrapping here.
   * rasterizeTitle passes the lines it decided at the SEQUENCE geometry when it
   * draws at another scale (titleLinesAt), so a preview raster never re-wraps.
   */
  given?: readonly string[],
): TitleLayout {
  const sidePad = Math.round(width * 0.06)
  const padPx = Math.round(height * 0.06)
  const maxWidth = Math.max(1, width - 2 * sidePad)

  const fontSizeOk = def.fontSizePx > 0

  const shownText = shownTextOf(def)
  const lines = !fontSizeOk ? [''] : given ? [...given] : wrapLinesWith(measure, shownText, maxWidth)
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

/** Non-destructive case: the typed text stays put; only the drawn glyphs change. */
function shownTextOf(def: TitleDef): string {
  return def.textCase === 'upper' ? def.text.toUpperCase() : def.textCase === 'lower' ? def.text.toLowerCase() : def.text
}

/**
 * The lines a title drawn at `scale` into a `width` px raster shows, decided
 * ONCE at the sequence geometry with the unscaled def, which is exactly what the
 * export at scale 1 and the caption fitter decide. Undefined at scale 1 on a raster
 * of the sequence's own width (the raster IS the sequence geometry, so its own wrap
 * is already that answer) and where there is no measurer.
 *
 * Why: scaleTitleDef rounds the font size and titleLayout rounds the side pad in
 * SCALED px, so a line that just fits at the sequence size (Oswald "AWAKE
 * DOESN'T REALLY" in the Word box style is 948.7 px on a 950 px Phone line) can
 * wrap at 0.875 or 0.375 in the monitor and not in the export. Deciding the
 * breaks here makes the two agree by construction at every scale.
 *
 * `seqWidth` is the sequence's own width, which both callers have and pass
 * (preview.ts frameW, exportWorker.ts seqW). It has to be passed: from the
 * raster alone the width can only be guessed as round(width / scale), and the
 * guess is exact only when the raster is a whole number of scale steps wide.
 * It is off by 1 to 2 px on a width such as 1350 at 0.375 (506 px wide, read
 * back as 1349), 1366 or 1081, and where an odd sequence height makes the
 * export scale outH / seqH rather than 1 (1920x1079 read back as 1918). One
 * px of line width is enough to wrap a caption that sits at the limit. The
 * guess stays as the fallback for a caller that does not know the width.
 */
export function titleLinesAt(
  def: TitleDef,
  width: number,
  scale: number,
  measureFor: (def: TitleDef) => ((s: string) => number) | null,
  seqWidth?: number,
): string[] | undefined {
  if (!(scale > 0) || !(def.fontSizePx > 0)) return undefined
  // At scale 1 the raster is the sequence only when it has the sequence's width (evenFit makes 1081 into 1082).
  if (Math.abs(scale - 1) < 1e-6 && (seqWidth === undefined || seqWidth === width)) return undefined
  const measure = measureFor(def)
  if (!measure) return undefined
  const seqW = seqWidth ?? Math.max(1, Math.round(width / scale))
  const maxWidth = Math.max(1, seqW - 2 * Math.round(seqW * 0.06))
  return wrapLinesWith(measure, shownTextOf(def), maxWidth)
}

/** Left edge of the text block for the current alignment. */
function textLeftOf(anchorX: number, textW: number, align: TitleDef['align']): number {
  if (align === 'left') return anchorX
  if (align === 'right') return anchorX - textW
  return anchorX - textW / 2
}

/**
 * Letters and digits only, any case: how a coloured word is matched to the word on
 * screen. A word with none (an emoji, "!!") is matched as itself, lowercased and
 * trimmed, so it still gets its box, its pop and its colour. Empty only when the
 * word itself is empty, and an empty word is skipped.
 */
const bareWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || w.toLowerCase().trim()

/**
 * The colour each shown word wears, or null for the title's own. Each entry
 * goes on the same word nearest the place it was given, so a caption retyped
 * around the word keeps it lit, and nowhere once the word itself is gone:
 * painting whatever word now sits there would light a word he never leaned on.
 */
export function wordColorsOn(words: readonly string[], wordColors: TitleDef['wordColors']): (string | null)[] {
  const out: (string | null)[] = words.map(() => null)
  for (const c of wordColors ?? []) {
    const want = bareWord(c.word)
    if (!want) continue
    let best = -1
    for (let i = 0; i < words.length; i++) {
      if (bareWord(words[i]!) === want && (best < 0 || Math.abs(i - c.at) < Math.abs(best - c.at))) best = i
    }
    if (best >= 0) out[best] = c.color
  }
  return out
}

/** One stretch of a line in one colour, drawn left aligned from `x`. */
export interface ColorRun {
  text: string
  x: number
  color: string
}

/**
 * Each line's fill as runs of one colour, each starting at the x it has inside
 * the line drawn whole, so a lit word lands exactly where it always sat (CA-13).
 * Null when no word wears a colour of its own, and then the line is drawn whole,
 * so every title made before this draws exactly as it did.
 */
export function colorRuns(
  lines: readonly string[],
  wordColors: TitleDef['wordColors'],
  base: string,
  measure: (s: string) => number,
  anchorX: number,
  align: TitleDef['align'],
): ColorRun[][] | null {
  if (!wordColors?.length) return null
  const perLine = lines.map(splitWords)
  const colors = wordColorsOn(perLine.flat(), wordColors)
  if (colors.every((c) => c === null)) return null
  let k = 0
  return perLine.map((words) => {
    const left = textLeftOf(anchorX, measure(words.join(' ')), align)
    const runs: ColorRun[] = []
    let from = 0
    while (from < words.length) {
      const color = colors[k + from] ?? base
      let to = from + 1
      while (to < words.length && (colors[k + to] ?? base) === color) to++
      const before = from > 0 ? `${words.slice(0, from).join(' ')} ` : ''
      runs.push({ text: words.slice(from, to).join(' '), x: left + (before ? measure(before) : 0), color })
      from = to
    }
    k += words.length
    return runs
  })
}

/** Where one word of the shown lines sits: its line, its place in that line, and its place in the whole text. */
export interface WordPlace {
  line: number
  col: number
  index: number
}

/**
 * The word `target` names, or null when it is no longer on screen (a retyped
 * caption). Found the way a lit word is: the same word (letters and digits only,
 * any case) nearest its `at`, the first of two equally near. One search for the
 * lit word, the box and the pop, so they can never land on different words.
 */
export function locateWord(lines: readonly string[], target: { at: number; word: string }): WordPlace | null {
  const want = bareWord(target.word)
  if (!want) return null
  let best: WordPlace | null = null
  let bestGap = Infinity
  let k = 0
  lines.forEach((l, line) => {
    splitWords(l).forEach((w, col) => {
      const gap = Math.abs(k - target.at)
      if (bareWord(w) === want && gap < bestGap) {
        best = { line, col, index: k }
        bestGap = gap
      }
      k++
    })
  })
  return best
}

/** One shown word and where the whole line puts it: `x` is its left edge, `baseline` its baseline. */
export interface WordSlot extends WordPlace {
  text: string
  x: number
  baseline: number
}

/**
 * Every shown word with the place its line puts it, left aligned from `x`: the
 * line's left edge plus the width of the words before it and their spaces. The
 * same sum the colour runs and the word box use, so a word drawn on its own lands
 * exactly where the whole line would have put it.
 */
export function wordSlots(
  lines: readonly string[],
  measure: (s: string) => number,
  anchorX: number,
  align: TitleDef['align'],
  firstBaselineY: number,
  lineHeightPx: number,
): WordSlot[] {
  const out: WordSlot[] = []
  let index = 0
  lines.forEach((l, line) => {
    const words = splitWords(l)
    const left = textLeftOf(anchorX, measure(words.join(' ')), align)
    words.forEach((text, col) => {
      const before = col > 0 ? `${words.slice(0, col).join(' ')} ` : ''
      out.push({ line, col, index: index++, text, x: left + (before ? measure(before) : 0), baseline: firstBaselineY + line * lineHeightPx })
    })
  })
  return out
}

/**
 * The biggest scale, from `want` down to 1, at which `ext` scaled about (cx, cy)
 * still lies inside the canvas. A popped word on the top or bottom line, or at a
 * side, would otherwise grow off the edge and be cut. Never below 1: a word that
 * already reaches the edge stays as it was drawn, it is not shrunk.
 */
export function fitScaleAbout(
  cx: number,
  cy: number,
  ext: { x0: number; y0: number; x1: number; y1: number },
  width: number,
  height: number,
  want: number,
): number {
  if (![cx, cy, ext.x0, ext.y0, ext.x1, ext.y1, width, height, want].every(Number.isFinite)) return 1
  let s = want
  // How far each side of the extent is from the centre, and how far the canvas lets it go.
  if (ext.x1 > cx) s = Math.min(s, (width - cx) / (ext.x1 - cx))
  if (ext.x0 < cx) s = Math.min(s, cx / (cx - ext.x0))
  if (ext.y1 > cy) s = Math.min(s, (height - cy) / (ext.y1 - cy))
  if (ext.y0 < cy) s = Math.min(s, cy / (cy - ext.y0))
  return Math.max(1, s)
}

/** Where a word's ink starts and ends inside its own advance, and how far it reaches above and below the baseline. */
export interface WordInk {
  left: number
  right: number
  ascent?: number
  descent?: number
}

/**
 * The centre a popped word grows about, and everything that grows with it before
 * it is scaled: the ink, half the outline, the shadow's reach, and the box with
 * its thin edge when it has one. One sum for the draw (which fits the scale to the
 * canvas with it) and for the click target (which scales it by the biggest pop).
 * `cap` stands in for the ascent of a word with no ink metrics.
 */
function popFootprint(
  def: TitleDef,
  slot: { x: number; baseline: number },
  ink: WordInk,
  cap: number,
  box: WordBoxRect | null,
): { cx: number; cy: number; ext: { x0: number; y0: number; x1: number; y1: number } } {
  const ascent = ink.ascent ?? cap
  const descent = ink.descent ?? 0
  // Grow about the middle of the word: across its ink, and up and down its box
  // when it has one, else its ink.
  const cx = slot.x + (ink.left + ink.right) / 2
  const cy = box ? box.y + box.h / 2 : slot.baseline - (ascent - descent) / 2
  const ow = def.outline && def.outline.widthPx > 0 ? def.outline.widthPx / 2 : 0
  const sh = def.shadow
  const blur = sh ? Math.max(0, sh.blurPx) : 0
  const ext = {
    x0: slot.x + ink.left - ow - (sh ? Math.max(0, blur - sh.dx) : 0),
    x1: slot.x + ink.right + ow + (sh ? Math.max(0, blur + sh.dx) : 0),
    y0: slot.baseline - ascent - ow - (sh ? Math.max(0, blur - sh.dy) : 0),
    y1: slot.baseline + descent + ow + (sh ? Math.max(0, blur + sh.dy) : 0),
  }
  if (box) {
    ext.x0 = Math.min(ext.x0, box.x - box.edge)
    ext.x1 = Math.max(ext.x1, box.x + box.w + box.edge)
    ext.y0 = Math.min(ext.y0, box.y - box.edge)
    ext.y1 = Math.max(ext.y1, box.y + box.h + box.edge)
  }
  return { cx, cy, ext }
}

/**
 * The word box's measurements, in his frame's em: measured off his frame
 * 2026-10-19 (a Short, 414 x 107, the cap 25 px at a 36 px size).
 *   side     glyph edge to the box's outer edge, each side
 *   top      the box's outer edge above the cap top, or above the ink of a
 *            letter taller than the caps (the accent on a Czech Š or Á)
 *   bottom   the box's outer edge below the baseline, or below the ink of a
 *            letter that hangs under it (g, y, p)
 *   border   thickness of the coloured border, inside the outer edge
 *   radius   corner radius of the outer edge
 *   edge     the thin dark line just outside the border
 */
export const WORD_BOX_EM = {
  side: 0.19,
  top: 0.29,
  bottom: 0.18,
  border: 0.11,
  radius: 0.22,
  edge: 0.05,
} as const

/**
 * His frame's cap height in its own em (25 px of a 36 px size). The table above
 * is in THAT em, so the box is sized from the cap height the face really has: a
 * face whose caps are taller or shorter than 0.694 of its size gets the same
 * box round its letters, which is what he sees, not the same box round its size.
 */
export const WORD_BOX_CAP_EM = 25 / 36

/** The dark line outside the word box's border, as it shows over the picture. */
const WORD_BOX_EDGE_COLOR = 'rgba(0,0,0,0.55)'

/** The box round the word being said, in canvas px. */
export interface WordBoxRect {
  x: number
  y: number
  w: number
  h: number
  radius: number
  border: number
  edge: number
}

/**
 * Where the word box goes: round the word `boxWord` names, or null when that
 * word is no longer on screen (a retyped caption). The word is found the way a
 * lit word is (nearest its `at`, letters and digits only), and sits where the
 * whole line puts it, so the box is an overlay and never moves a word (CA-13).
 *
 * `inkOf` says where a word's ink starts and ends inside its own advance, and how
 * far its ink reaches above and below the baseline, so every margin is measured
 * from the glyph edge the way it was off his frame (a g gets its tail inside the
 * box, a Czech Š its accent); without it the advance box, the cap top and the
 * baseline stand in.
 * `capHeightPx` is the face's cap height at the title's size. Words are split by
 * `splitWords`, the way wordPop.ts counts them, so `at` names the same word.
 */
export function wordBoxRect(
  lines: readonly string[],
  boxWord: NonNullable<TitleDef['boxWord']>,
  measure: (s: string) => number,
  anchorX: number,
  align: TitleDef['align'],
  firstBaselineY: number,
  lineHeightPx: number,
  capHeightPx: number,
  inkOf?: (word: string) => WordInk,
): WordBoxRect | null {
  if (!(capHeightPx > 0)) return null
  const place = locateWord(lines, boxWord)
  if (!place) return null
  const { line, col } = place
  const words = splitWords(lines[line]!)
  const before = col > 0 ? `${words.slice(0, col).join(' ')} ` : ''
  const x = textLeftOf(anchorX, measure(words.join(' ')), align) + (before ? measure(before) : 0)
  const word = words[col]!
  const ink: WordInk = inkOf?.(word) ?? { left: 0, right: measure(word) }
  const em = capHeightPx / WORD_BOX_CAP_EM
  const baseline = firstBaselineY + line * lineHeightPx
  const x0 = x + ink.left - WORD_BOX_EM.side * em
  const x1 = x + ink.right + WORD_BOX_EM.side * em
  const y0 = baseline - Math.max(capHeightPx, ink.ascent ?? 0) - WORD_BOX_EM.top * em
  const y1 = baseline + Math.max(0, ink.descent ?? 0) + WORD_BOX_EM.bottom * em
  if (![x0, x1, y0, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)) return null
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    radius: WORD_BOX_EM.radius * em,
    border: WORD_BOX_EM.border * em,
    edge: WORD_BOX_EM.edge * em,
  }
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
 * Where a word's ink sits, measured on `ctx` (its font already set, textAlign
 * 'left'): from the glyph edges, so a g gets its tail and a Czech Š its accent.
 * Without ink metrics the word's advance stands in.
 */
function inkOfIn(ctx: OffscreenCanvasRenderingContext2D, word: string): WordInk {
  const m = ctx.measureText(word)
  return Number.isFinite(m.actualBoundingBoxLeft) && Number.isFinite(m.actualBoundingBoxRight)
    ? {
        left: -m.actualBoundingBoxLeft,
        right: m.actualBoundingBoxRight,
        ...(Number.isFinite(m.actualBoundingBoxAscent) ? { ascent: m.actualBoundingBoxAscent } : {}),
        ...(Number.isFinite(m.actualBoundingBoxDescent) ? { descent: m.actualBoundingBoxDescent } : {}),
      }
    : { left: 0, right: m.width }
}

/** The face's cap height at the title's size, measured on `ctx`; the usual 0.70 em where it cannot be. */
function capHeightIn(ctx: OffscreenCanvasRenderingContext2D, def: TitleDef): number {
  const cap = ctx.measureText('H').actualBoundingBoxAscent
  return cap > 0 ? cap : 0.7 * def.fontSizePx
}

/** What a canvas can say about `def`'s ink: its cap height and where a word's ink sits. Null in node. */
interface InkMeter {
  capPx: number
  inkOf: (word: string) => WordInk
}

function canvasInkMeter(def: TitleDef): InkMeter | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  if (!measureCtx) measureCtx = new OffscreenCanvas(1, 1).getContext('2d')
  const ctx = measureCtx
  if (!ctx) return null
  ctx.font = fontString(def)
  ctx.textAlign = 'left'
  return { capPx: capHeightIn(ctx, def), inkOf: (word) => inkOfIn(ctx, word) }
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
  /** The ink measures of the box round a word; the default reads the canvas, where there is one. */
  ink: InkMeter | null = canvasInkMeter(def),
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
    // Suppressed decorations do not grow the CLICK TARGET either, or an
    // inverted caption is selectable well outside the only pixels it draws.
    const grow =
      !def.invertBackdrop && def.outline && def.outline.widthPx > 0 ? def.outline.widthPx / 2 : 0
    add(left - grow, L.blockTop - grow, left + L.textW + grow, L.blockTop + L.blockH + grow)
    if (def.shadow && !def.invertBackdrop) {
      const b = def.shadow.blurPx
      add(
        left - grow + def.shadow.dx - b,
        L.blockTop - grow + def.shadow.dy - b,
        left + L.textW + grow + def.shadow.dx + b,
        L.blockTop + L.blockH + grow + def.shadow.dy + b,
      )
    }
  }

  // The word box can sit round any word, so the click target grows by its
  // margins (and its dark edge) all round the text, measured the way the box is:
  // from the cap top, or from the ink of a letter taller than the caps (a Czech Š),
  // down to the baseline, or to the ink of a letter that hangs under it (a g). The
  // cap height is the usual 0.70 em where there is no canvas to measure the real one.
  if (def.wordBox && L.hasText && !def.invertBackdrop) {
    const cap = ink && ink.capPx > 0 ? ink.capPx : 0.7 * def.fontSizePx
    let reachUp = cap
    let reachDown = 0
    if (ink) {
      for (const word of L.lines.flatMap(splitWords)) {
        const w = ink.inkOf(word)
        reachUp = Math.max(reachUp, w.ascent ?? 0)
        reachDown = Math.max(reachDown, w.descent ?? 0)
      }
    }
    const em = cap / WORD_BOX_CAP_EM
    const left = textLeftOf(L.anchorX, L.textW, def.align)
    const gx = (WORD_BOX_EM.side + WORD_BOX_EM.edge) * em
    const lastBaselineY = L.firstBaselineY + (Math.max(L.lines.length, 1) - 1) * L.lineHeightPx
    add(
      left - gx,
      L.firstBaselineY - reachUp - (WORD_BOX_EM.top + WORD_BOX_EM.edge) * em,
      left + L.textW + gx,
      lastBaselineY + reachDown + (WORD_BOX_EM.bottom + WORD_BOX_EM.edge) * em,
    )
  }

  // A size pop draws the word being said bigger, about its own centre, and it can
  // reach outside everything above. Any word can be the one popping, so every word
  // grows by the biggest pop there is (the emphasis peak), measured the way the
  // draw measures it. The frame clip below still applies.
  if (
    L.hasText &&
    !def.invertBackdrop &&
    typeof def.wordPopSize === 'number' &&
    Number.isFinite(def.wordPopSize) &&
    def.wordPopSize > 1
  ) {
    const cap = ink && ink.capPx > 0 ? ink.capPx : 0.7 * def.fontSizePx
    const top = 1 + (def.wordPopSize - 1) * POP_EMPHASIS_BOOST
    for (const slot of wordSlots(L.lines, measure, L.anchorX, def.align, L.firstBaselineY, L.lineHeightPx)) {
      const wordInk: WordInk = ink ? ink.inkOf(slot.text) : { left: 0, right: measure(slot.text) }
      const rect = def.wordBox
        ? wordBoxRect(
            L.lines,
            { at: slot.index, word: slot.text },
            measure,
            L.anchorX,
            def.align,
            L.firstBaselineY,
            L.lineHeightPx,
            cap,
            ink?.inkOf,
          )
        : null
      const { cx, cy, ext } = popFootprint(def, slot, wordInk, cap, rect)
      add(cx + (ext.x0 - cx) * top, cy + (ext.y0 - cy) * top, cx + (ext.x1 - cx) * top, cy + (ext.y1 - cy) * top)
    }
  }

  if (def.box && !def.invertBackdrop) {
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
  /** The beginTitleFrame() count this raster was last asked for in (0: never counted). */
  frame: number
}

/**
 * Memory the rasterized-title cache may hold, in bytes.
 *
 * This was a COUNT of 32, which says nothing about memory: every entry is a
 * FULL-FRAME canvas, so 32 of them is 8 MB at 640x360 and 265 MB on a 1080x1920
 * Short. A word-caption timeline makes one entry per word, so the large case is
 * the normal one. Counting bytes turns the guess into a policy.
 *
 * ⛔ ONE NUMBER COULD NOT SERVE BOTH SIDES. 48 MB is six rasters on a 1080x1920
 * Short, and one word caption is one raster: a captioned Short thrashes the whole
 * cache several times a second while he scrubs, re-drawing text that has not
 * changed. But the EXPORT worker rasterises the same titles while it also holds
 * the encoder, the frame pipeline and the audio mix, and it has no business
 * taking a quarter of a gigabyte for cached text.
 *
 * So the budget is per context. A worker has no `window`, which is exactly the
 * line between the two: the export worker keeps the old careful number, the
 * interface he is looking at gets thirty-odd captions of headroom on a machine
 * with 32 GB in it.
 *
 * ⛔ IN THE EXPORT THE BUDGET NEVER EVICTS A TITLE THE CURRENT FRAME IS USING
 * (2026-10-16). 48 MB is six rasters at 1080x1920 but only five at the Phone
 * shape, 1080x2112. With six titles on screen at once the oldest was evicted to
 * make room for the sixth, then asked for again next frame, so EVERY title was
 * drawn and uploaded again on EVERY frame: a 2 s test export ran at 16.9 frames a
 * second at 9:16 and 2.9 at Phone, and his own Phone export crawled at 22%. The
 * worker now calls beginTitleFrame() once per frame, and a raster asked for since
 * then is held whatever the budget says, because the frame cannot be drawn
 * without it. Only rasters from earlier frames are evicted to the budget. That
 * holds a frame's own titles and nothing more, which the GPU holds anyway. The
 * preview never calls it and keeps the plain budget.
 */
export const TITLE_CACHE_BUDGET_BYTES = typeof window === 'undefined' ? 48 * 1024 * 1024 : 256 * 1024 * 1024
const CACHE_BUDGET_BYTES = TITLE_CACHE_BUDGET_BYTES

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
let identityCache = new WeakMap<TitleDef, { w: number; h: number; seqW: number | undefined; entry: CacheEntry }>()

/** Frames counted by beginTitleFrame(). 0 until the first call, which is the preview's case. */
let frameNo = 0

/**
 * A new output frame starts: the rasters it asks for from here on are held until
 * the next call, whatever the budget (see TITLE_CACHE_BUDGET_BYTES). The export
 * worker calls this once per frame.
 */
export function beginTitleFrame(): void {
  frameNo++
}

/** Is this entry asked for by the frame being drawn now? Never true without beginTitleFrame(). */
const inThisFrame = (e: CacheEntry): boolean => frameNo !== 0 && e.frame === frameNo

export function clearTitleCache(): void {
  cache.length = 0
  cacheBytes = 0
  identityCache = new WeakMap()
  frameNo = 0
}

/** Bytes the title cache is currently holding (for tests and diagnostics). */
export const titleCacheBytes = (): number => cacheBytes

function cacheKey(def: TitleDef, width: number, height: number): string {
  return `${JSON.stringify(def)}|${width}x${height}`
}

function fontString(def: TitleDef): string {
  const style = def.italic ? 'italic ' : ''
  const weight = def.bold ? '700' : '400'
  // The Apple emoji face goes first and answers for emoji only (emojiFont.ts),
  // so every other character still draws in the title's own font.
  const face = appleEmojiFor(def.text) ? `${EMOJI_STACK}, ${def.fontFamily}` : def.fontFamily
  return `${style}${weight} ${def.fontSizePx}px ${face}`
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
  /**
   * The SEQUENCE width, for a `scale` other than 1 or a raster that is not the
   * sequence's width (1082 px for a 1081 px sequence): the line width the breaks
   * are decided at (titleLinesAt) is the sequence's, and a raster of another size
   * cannot give it back exactly. Both callers know it and pass it.
   */
  seqWidth?: number,
): OffscreenCanvas {
  const fast = identityCache.get(defIn)
  if (fast && fast.w === width && fast.h === height && fast.seqW === seqWidth) {
    fast.entry.frame = frameNo
    return fast.entry.canvas
  }
  // Everything below reads the SCALED def; the identity cache stays keyed on the
  // caller's original object, which is the one the store holds.
  const def = scaleTitleDef(defIn, scale)
  // The breaks come from the sequence geometry, not from this raster's rounded
  // font and pad (titleLinesAt), so the monitor never wraps where the export
  // does not. They join the key: the same scaled def can only break one way here.
  // Asked at scale 1 too: an export at 1082 px of a 1081 px sequence has scale 1
  // and not the sequence's width, and it still has to break at the sequence's.
  const seqLines = titleLinesAt(defIn, width, scale, canvasMeasurer, seqWidth)
  const key = seqLines ? `${cacheKey(def, width, height)}|${JSON.stringify(seqLines)}` : cacheKey(def, width, height)
  const hitIdx = cache.findIndex((e) => e.key === key)
  if (hitIdx !== -1) {
    const [hit] = cache.splice(hitIdx, 1)
    // Re-key the entry to the def we were just handed: that is the object the
    // identity map now points at, so it is the one eviction has to clear.
    if (hit.def !== defIn) identityCache.delete(hit.def)
    hit.def = defIn
    hit.frame = frameNo
    cache.push(hit) // touch → most-recently-used
    identityCache.set(defIn, { w: width, h: height, seqW: seqWidth, entry: hit })
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
    seqLines,
  )

  // BOX: drawn behind the text. If there is no text but a box is set, draw a
  // plain rectangle centered on the block (the "basic shape" path).
  // Suppressed with the rest of the decorations: a box behind an inverted
  // word would be inverted along with it, which is a solid inverse-backdrop
  // rectangle rather than a caption.
  if (def.box && !def.invertBackdrop) {
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

  // SIZE POP: a title with a pop size draws its words one at a time, on EVERY
  // frame and not only the popped ones. Each word goes exactly where the whole
  // line would put it (wordSlots), so a frame mid pop and a frame after it differ
  // in the popped word alone and every other word is the same pixels in both.
  // Not on an inverted title, which is a stencil and takes no decoration.
  const popsWords =
    hasText &&
    !def.invertBackdrop &&
    typeof def.wordPopSize === 'number' &&
    Number.isFinite(def.wordPopSize) &&
    def.wordPopSize > 1
  // The word being popped right now: null between pops, and when the caption was
  // retyped so the word is gone.
  const popPlace =
    popsWords && def.popWord && def.popWord.scale > 1 && Number.isFinite(def.popWord.scale)
      ? locateWord(lines, def.popWord)
      : null

  // WORD BOX: the rounded box round the word being said, behind the letters. An
  // overlay: it is drawn from where the line already put the word and never moves
  // one. Suppressed with the rest of the decorations on an inverted title, and
  // skipped (not thrown) when the stored colours are not strings.
  let focusBox: WordBoxRect | null = null
  if (
    hasText &&
    !def.invertBackdrop &&
    def.wordBox &&
    def.boxWord &&
    typeof def.wordBox.color === 'string' &&
    typeof def.wordBox.borderColor === 'string'
  ) {
    const cap = capHeightIn(ctx, def)
    ctx.textAlign = 'left'
    const rect = wordBoxRect(
      lines,
      def.boxWord,
      (str) => ctx.measureText(str).width,
      anchorX,
      def.align,
      firstBaselineY,
      lineHeightPx,
      cap,
      (word) => inkOfIn(ctx, word),
    )
    ctx.textAlign = def.align
    if (rect && rect.x < width && rect.x + rect.w > 0 && rect.y < height && rect.y + rect.h > 0) {
      // The box of the word that is popping pops with it, and is drawn with it
      // after the other words; any other box stays behind the text as it was.
      if (popPlace && locateWord(lines, def.boxWord)?.index === popPlace.index) focusBox = rect
      else drawWordBox(ctx, rect, def.wordBox)
    }
  }

  // TEXT: optional outline (stroke) then fill, with an optional shadow. Guard
  // against no text / bad font size.
  if (hasText && def.invertBackdrop) {
    // ⛔ A COVERAGE STENCIL, NOT A PICTURE. The renderer keys the inversion on
    // src.a ALONE, so the fill is opaque white and the shadow, outline and box
    // are skipped entirely.
    //
    // The decorations are not skipped for tidiness. They write ALPHA, and the
    // invert keys on alpha, so an inverted shadow is a soft halo of
    // inverse-backdrop around every letter rather than a shadow. That is not
    // the look in the reel he sent, and it is not a look anybody wants.
    //
    // ⚠️ WHITE IS THE GRACEFUL VALUE, and it is chosen rather than arbitrary.
    // `renderSideToFbo` in glRenderer flattens a non-normal blend to `normal`
    // inside a transition window, so an inverted title caught mid-transition
    // draws its raster directly. White text is a readable fallback; black
    // would vanish into the letterbox.
    ctx.fillStyle = "#ffffff"
    let y = firstBaselineY
    for (const line of lines) {
      if (line !== "") ctx.fillText(line, anchorX, y)
      y += lineHeightPx
    }
  } else if (popsWords) {
    drawWordsOneByOne(
      ctx,
      def,
      width,
      height,
      lines,
      anchorX,
      firstBaselineY,
      lineHeightPx,
      popPlace && def.popWord ? { place: popPlace, scale: def.popWord.scale } : null,
      focusBox,
    )
  } else if (hasText) {
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

    // A lit word inside the caption is filled in its own colour, in runs laid
    // where the whole line would have put them; the outline above is one piece.
    const runs = colorRuns(lines, def.wordColors, def.color, (str) => ctx.measureText(str).width, anchorX, def.align)
    let y = firstBaselineY
    if (runs) {
      ctx.textAlign = 'left'
      for (const line of runs) {
        for (const run of line) {
          ctx.fillStyle = run.color
          ctx.fillText(run.text, run.x, y)
        }
        y += lineHeightPx
      }
      ctx.textAlign = def.align
    } else {
      ctx.fillStyle = def.color
      for (const line of lines) {
        if (line !== '') ctx.fillText(line, anchorX, y)
        y += lineHeightPx
      }
    }
    // Reset so a later cached draw on this ctx can't inherit the shadow.
    if (def.shadow && !hasOutline) clearShadow()
  }

  const entry: CacheEntry = { key, canvas, def: defIn, frame: frameNo }
  cache.push(entry)
  cacheBytes += canvasBytes(canvas)
  // Always keep the raster we were just asked for (the last one), even if it
  // alone exceeds the budget, because refusing it would re-rasterize it on the
  // very next frame. For the same reason, skip every raster the current frame
  // has asked for (inThisFrame), oldest first otherwise.
  for (let i = 0; cacheBytes > CACHE_BUDGET_BYTES && i < cache.length - 1; ) {
    const e = cache[i]
    if (inThisFrame(e)) {
      i++
      continue
    }
    cache.splice(i, 1)
    cacheBytes -= canvasBytes(e.canvas)
    identityCache.delete(e.def)
  }
  identityCache.set(defIn, { w: width, h: height, seqW: seqWidth, entry })
  return canvas
}

/** The word box: fill, the coloured border just inside its edge, and the thin dark line just outside. */
function drawWordBox(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: WordBoxRect,
  wordBox: NonNullable<TitleDef['wordBox']>,
): void {
  const { x, y, w, h, edge } = rect
  const border = Math.min(rect.border, w / 2, h / 2)
  const radius = Math.max(0, Math.min(rect.radius, w / 2, h / 2))
  ctx.beginPath()
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = wordBox.color
  ctx.fill()
  // The border sits INSIDE the outer edge: a stroke centred half its width in.
  ctx.beginPath()
  roundRect(ctx, x + border / 2, y + border / 2, w - border, h - border, Math.max(0, radius - border / 2))
  ctx.strokeStyle = wordBox.borderColor
  ctx.lineWidth = border
  ctx.stroke()
  // The thin dark line just OUTSIDE the border, centred half its width out.
  ctx.beginPath()
  roundRect(ctx, x - edge / 2, y - edge / 2, w + edge, h + edge, radius + edge / 2)
  ctx.strokeStyle = WORD_BOX_EDGE_COLOR
  ctx.lineWidth = edge
  ctx.stroke()
}

/**
 * The text of a title that pops its words, one word at a time. Every word is
 * drawn at the place the whole line gives it, in the order the whole line is
 * drawn (outlines, then fills), so the words that are not popping are the same
 * pixels on every frame. The popping word, and its box, are drawn last, grown
 * about their own centre by `focus.scale` (less where it would leave the canvas).
 * Fill, outline and shadow grow with it; the shadow is scaled by hand because
 * a canvas shadow ignores the transform.
 */
function drawWordsOneByOne(
  ctx: OffscreenCanvasRenderingContext2D,
  def: TitleDef,
  width: number,
  height: number,
  lines: readonly string[],
  anchorX: number,
  firstBaselineY: number,
  lineHeightPx: number,
  focus: { place: WordPlace; scale: number } | null,
  focusBox: WordBoxRect | null,
): void {
  const slots = wordSlots(lines, (s) => ctx.measureText(s).width, anchorX, def.align, firstBaselineY, lineHeightPx)
  const colors = wordColorsOn(
    slots.map((s) => s.text),
    def.wordColors,
  )
  const hasOutline = !!def.outline && def.outline.widthPx > 0
  const setShadow = (k: number): void => {
    if (!def.shadow) return
    ctx.shadowColor = def.shadow.color
    ctx.shadowBlur = def.shadow.blurPx * k
    ctx.shadowOffsetX = def.shadow.dx * k
    ctx.shadowOffsetY = def.shadow.dy * k
  }
  const clearShadow = (): void => {
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }
  const setStroke = (): void => {
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = def.outline!.color
    ctx.lineWidth = def.outline!.widthPx
  }
  const popped = focus ? (slots[focus.place.index] ?? null) : null

  ctx.textAlign = 'left'

  // The other words: the outline is the bottom layer and casts the shadow, the
  // fills land on top of it, as they do when the line is drawn whole.
  const others = slots.filter((s) => s !== popped)
  setShadow(1)
  if (hasOutline) {
    setStroke()
    for (const s of others) ctx.strokeText(s.text, s.x, s.baseline)
    clearShadow()
  }
  for (const s of others) {
    ctx.fillStyle = colors[s.index] ?? def.color
    ctx.fillText(s.text, s.x, s.baseline)
  }
  clearShadow()

  if (focus && popped) {
    // Everything that grows with it must stay inside the canvas, so the scale is
    // fitted to the footprint: the ink, half the outline, the shadow's reach, the box and its thin edge.
    const { cx, cy, ext } = popFootprint(def, popped, inkOfIn(ctx, popped.text), capHeightIn(ctx, def), focusBox)
    const k = fitScaleAbout(cx, cy, ext, width, height, focus.scale)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(k, k)
    ctx.translate(-cx, -cy)
    if (focusBox && def.wordBox) drawWordBox(ctx, focusBox, def.wordBox)
    setShadow(k)
    if (hasOutline) {
      setStroke()
      ctx.strokeText(popped.text, popped.x, popped.baseline)
      clearShadow()
    }
    ctx.fillStyle = colors[popped.index] ?? def.color
    ctx.fillText(popped.text, popped.x, popped.baseline)
    clearShadow()
    ctx.restore()
  }

  ctx.textAlign = def.align
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
