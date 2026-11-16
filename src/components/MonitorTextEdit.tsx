// Type text right on the video. Double click a title in the monitor and a
// transparent textarea lies over its words; he types, the title updates live.
//
// ⛔ WHAT HE SEES IS THE REAL PICTURE, NOT THIS FIELD. The field's text is
// transparent. The title is still drawn by the one shared rasteriser (the same
// raster the export uses), re-drawn on every keystroke because every keystroke
// writes the project. This file only supplies the caret, the selection and the
// keyboard, laid exactly over where the raster puts the words. A look-alike HTML
// copy of the title would drift from the export the first time a font loaded late.
//
// ⛔ THE WORDS GO THROUGH updateTitle, THE ACTION THE INSPECTOR'S TEXT BOX USES,
// with the same merge field ('text'), so a run of typing folds into one undo step
// the way it does there (a pause of a second starts the next step, history.ts).
// Undo and redo inside the field are the browser's own, exactly as in that box.
//
// NOTHING HERE SUBSCRIBES TO THE PLAYHEAD. The overlay hands this component
// numbers, it is memoised, and it reads the title off the store by clip id.

import { memo, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { appleEmojiFor, EMOJI_STACK } from '../engine/render/emojiFont'
import { blockLayout, titleLayout, wrapLinesWith } from '../engine/render/titleRaster'
import { activeSequence, type TitleDef } from '../engine/types'
import { useStore } from '../state/store'
import { updateTitle } from '../state/titleActions'

/** A rectangle in monitor px: measured from the top left of the monitor's picture area. */
export interface MonitorBox {
  left: number
  top: number
  w: number
  h: number
}

export interface TextEditing {
  /** The title clip being typed into. */
  clipId: string
  /**
   * Where its words are on the monitor, in monitor px (the same space the other overlays sit in),
   * rotation included: the box that holds the rotated text. Null until the field has been measured
   * on the first frame. For whatever anchors a floating toolbar above the title.
   */
  box: MonitorBox | null
  /** The clip's rotation, so a toolbar can tell a box that is straight from one that is tipped. */
  rotationDeg: number
}

/**
 * Is a title being edited in place, and which. Local UI state only: nothing is saved with the
 * project and no undo step is made by starting or ending an edit.
 */
export const useTextEdit = create<{ editing: TextEditing | null }>(() => ({ editing: null }))

export const startTextEdit = (clipId: string): void =>
  useTextEdit.setState({ editing: { clipId, box: null, rotationDeg: 0 } })

export const endTextEdit = (): void => {
  if (useTextEdit.getState().editing !== null) useTextEdit.setState({ editing: null })
}

/** A control that belongs to the edit (a floating toolbar): pressing it does not end the typing. */
export const KEEPS_TEXT_EDIT = 'data-keeps-text-edit'

/** The title's font as the rasteriser sets it, so a wrap measured here breaks where the raster breaks. */
function fontOf(def: TitleDef): string {
  const face = appleEmojiFor(def.text) ? `${EMOJI_STACK}, ${def.fontFamily}` : def.fontFamily
  return `${def.italic ? 'italic ' : ''}${def.bold ? '700' : '400'} ${def.fontSizePx}px ${face}`
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null

/** A text measurer in `def`'s font at SEQUENCE px, or null where there is no canvas (node, jsdom). */
function measurerFor(def: TitleDef): ((s: string) => number) | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  if (!measureCtx) measureCtx = new OffscreenCanvas(1, 1).getContext('2d')
  const ctx = measureCtx
  if (!ctx) return null
  ctx.font = fontOf(def)
  return (s) => ctx.measureText(s).width
}

/**
 * The rectangle the title's words are laid out in, in SEQUENCE px of the unrotated, unscaled
 * frame: the wrap width, from the first line's top to the last line's bottom.
 *
 * Laid out by titleLayout, the rasteriser's own layout, so the lines break and the block sits
 * where the raster puts them. Without a measurer (no canvas) the lines are the typed lines, which
 * is right for everything that does not wrap.
 */
export function editBoxSeq(
  def: TitleDef,
  width: number,
  height: number,
  measure: ((s: string) => number) | null,
): { left: number; top: number; width: number; height: number; lineHeightPx: number } {
  if (measure) {
    const L = titleLayout(def, width, height, measure)
    return { left: L.sidePad + def.offsetXPx, top: L.blockTop, width: L.maxWidth, height: L.blockH, lineHeightPx: L.lineHeightPx }
  }
  const sidePad = Math.round(width * 0.06)
  const padPx = Math.round(height * 0.06)
  const lineHeightPx = def.fontSizePx > 0 ? def.fontSizePx * def.lineHeight : 0
  const lines = wrapLinesWith(() => 0, def.text, Math.max(1, width - 2 * sidePad))
  const { blockTop, blockH } = blockLayout({
    lines,
    lineHeightPx,
    vAlign: def.vAlign,
    frameH: height,
    padPx,
    offsetYPx: def.offsetYPx,
  })
  return { left: sidePad + def.offsetXPx, top: blockTop, width: Math.max(1, width - 2 * sidePad), height: blockH, lineHeightPx }
}

export interface MonitorTextEditProps {
  clipId: string
  /** The picture's box inside the monitor's area, in monitor px, and the sequence it shows. */
  canvasLeft: number
  canvasTop: number
  canvasW: number
  canvasH: number
  seqW: number
  seqH: number
  /** The clip's framing as the renderer lays it out at the playhead. */
  x: number
  y: number
  scale: number
  rotationDeg: number
  anchorX: number
  anchorY: number
}

function MonitorTextEditView(p: MonitorTextEditProps) {
  const { clipId, canvasLeft, canvasTop, canvasW, canvasH, seqW, seqH, x, y, scale, rotationDeg, anchorX, anchorY } = p
  const def = useStore((s) =>
    activeSequence(s.project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.title,
  )
  const ref = useRef<HTMLTextAreaElement>(null)

  // Caret at the end of his words, ready to type.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // A press anywhere but the field ends the typing, the way clicking off a text box does. Capture
  // phase, so it runs before whatever the press was for (selecting, scrubbing) and never in its way.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (t instanceof Node && ref.current?.contains(t)) return
      if (t instanceof Element && t.closest(`[${KEEPS_TEXT_EDIT}]`)) return
      endTextEdit()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  const k = canvasW / seqW
  const box = def ? editBoxSeq(def, seqW, seqH, measurerFor(def)) : null

  // Publish the box for whatever anchors to it. The four corners go through the same pivot, scale,
  // rotation and offset the renderer uses (computeQuad), then the bounds are taken.
  const boxLeft = box ? box.left * k : 0
  const boxTop = box ? box.top * k : 0
  const boxW = box ? box.width * k : 0
  const boxH = box ? box.height * k : 0
  const hasBox = box !== null
  useEffect(() => {
    if (!hasBox) return
    const px = anchorX * canvasW
    const py = anchorY * canvasH
    const r = (rotationDeg * Math.PI) / 180
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const xs: number[] = []
    const ys: number[] = []
    for (const [cx, cy] of [
      [boxLeft, boxTop],
      [boxLeft + boxW, boxTop],
      [boxLeft + boxW, boxTop + boxH],
      [boxLeft, boxTop + boxH],
    ]) {
      const dx = (cx - px) * scale
      const dy = (cy - py) * scale
      xs.push(px + x * k + dx * cos - dy * sin)
      ys.push(py + y * k + dx * sin + dy * cos)
    }
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const next: MonitorBox = {
      left: canvasLeft + left,
      top: canvasTop + top,
      w: Math.max(...xs) - left,
      h: Math.max(...ys) - top,
    }
    const cur = useTextEdit.getState().editing
    if (!cur || cur.clipId !== clipId) return
    const b = cur.box
    if (b && b.left === next.left && b.top === next.top && b.w === next.w && b.h === next.h && cur.rotationDeg === rotationDeg) return
    useTextEdit.setState({ editing: { clipId, box: next, rotationDeg } })
  }, [clipId, hasBox, boxLeft, boxTop, boxW, boxH, canvasLeft, canvasTop, canvasW, canvasH, k, x, y, scale, rotationDeg, anchorX, anchorY])

  if (!def || !box) return null

  return (
    // The frame is the whole picture, moved, turned and scaled the way the title's layer is, with the
    // field in it at the title's own layout. A rotated title is typed on tilted, with the CSS twin of
    // the renderer's matrix, instead of a flat box over tilted words.
    <div
      data-testid="text-edit-frame"
      className="pointer-events-none absolute"
      style={{
        left: 0,
        top: 0,
        width: canvasW,
        height: canvasH,
        transformOrigin: `${anchorX * canvasW}px ${anchorY * canvasH}px`,
        transform: `translate(${x * k}px, ${y * k}px) rotate(${rotationDeg}deg) scale(${scale})`,
      }}
    >
      <textarea
        ref={ref}
        data-testid="text-edit-field"
        aria-label="Title text, typed on the video"
        value={def.text}
        onChange={(e) => updateTitle(clipId, { text: e.target.value }, 'text')}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault()
            endTextEdit()
          }
          // Plain Enter is a new line, as in TikTok.
        }}
        // A press on the field is the field's: no scrub, no select, no drag underneath it.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        className="pointer-events-auto absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0"
        style={{
          left: boxLeft,
          top: boxTop,
          width: boxW,
          height: boxH,
          outline: 'none',
          boxShadow: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'var(--color-accent)',
          resize: 'none',
          // The same type, in monitor px: the sequence size times what the monitor shows.
          fontFamily: appleEmojiFor(def.text) ? `${EMOJI_STACK}, ${def.fontFamily}` : def.fontFamily,
          fontSize: `${def.fontSizePx * k}px`,
          fontWeight: def.bold ? 700 : 400,
          fontStyle: def.italic ? 'italic' : 'normal',
          lineHeight: def.lineHeight,
          textAlign: def.align,
          textTransform: def.textCase === 'upper' ? 'uppercase' : def.textCase === 'lower' ? 'lowercase' : 'none',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
        }}
      />
    </div>
  )
}

export const MonitorTextEdit = memo(MonitorTextEditView)
