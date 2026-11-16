// The small bar over a title while it is typed on, in TikTok text mode. It borrows TikTok's
// layout (a style button, an alignment button, a row of colour dots) and wears THIS app's look:
// the elevated panel, the overlay radius and the monitor bar's small icon buttons.
//
// It styles THIS title and nothing else: the style button cycles the four TikTok looks, taking
// each look's styling (colour, shadow, outline, line highlight) and leaving the title's words,
// position and size where they are. Every press is its own undo step, through updateTitle.
//
// ⛔ A PRESS ON THE BAR MUST NOT END THE TYPING. The monitor ends a typing session on any press
// outside the field, except on what is marked KEEPS_TEXT_EDIT, which the bar is. And the press is
// kept from taking the focus off the field, so he can go on typing after a click on a dot.
//
// Where it sits comes from useTextEdit, which MonitorTextEdit fills with the title's box in
// monitor px. NOTHING HERE SUBSCRIBES TO THE PLAYHEAD.

import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { contrastTextColor } from '../engine/render/lineBox'
import { activeSequence, type TitleDef } from '../engine/types'
import { useSettings } from '../state/settings'
import { useStore } from '../state/store'
import { setTitleAlign, updateTitle } from '../state/titleActions'
import { titleLookById } from '../state/titleShelf'
import { IconButton } from '../ui/Button'
import { KEEPS_TEXT_EDIT, useTextEdit } from './MonitorTextEdit'

/**
 * The colours the dots offer: white, black, red, orange, yellow, green, cyan, blue, purple, pink.
 * PROVISIONAL: picked by eye to read like TikTok's row, not measured against a recording, so a
 * later measurement changes this list and nothing else.
 */
export const TIKTOK_DOTS: readonly { id: string; label: string; color: string }[] = [
  { id: 'white', label: 'White', color: '#ffffff' },
  { id: 'black', label: 'Black', color: '#000000' },
  { id: 'red', label: 'Red', color: '#fe2c55' },
  { id: 'orange', label: 'Orange', color: '#ff9500' },
  { id: 'yellow', label: 'Yellow', color: '#ffdf00' },
  { id: 'green', label: 'Green', color: '#34c759' },
  { id: 'cyan', label: 'Cyan', color: '#25f4ee' },
  { id: 'blue', label: 'Blue', color: '#0a84ff' },
  { id: 'purple', label: 'Purple', color: '#af52de' },
  { id: 'pink', label: 'Pink', color: '#ff6eb4' },
]

type TikTokStyle = 'plain' | 'highlight' | 'soft' | 'outline'

/** The order the style button goes round in, and the shelf look each one takes its styling from. */
const STYLE_CYCLE: readonly TikTokStyle[] = ['plain', 'highlight', 'soft', 'outline']
const STYLE_LOOK: Record<TikTokStyle, string> = {
  plain: 'tiktok-plain',
  highlight: 'tiktok-highlight',
  soft: 'tiktok-soft',
  outline: 'tiktok-outline',
}
const STYLE_NAME: Record<TikTokStyle, string> = { plain: 'Plain', highlight: 'Highlight', soft: 'Soft', outline: 'Outline' }

const ALIGN_CYCLE = ['left', 'center', 'right'] as const
const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight } as const
const ALIGN_NAME = { left: 'left', center: 'centre', right: 'right' } as const

/**
 * Air between the bar and the text box, in monitor px, above it or below it. The bar casts no wide
 * drop shadow (a 32 px blur falls 44 px below a panel, over the first line of the words); its border
 * and panel colour set it off, so nothing of it lands on the text.
 */
const GAP = 20
/** Air between the bar and the monitor's edge, in monitor px. */
const EDGE = 4
/** Before the bar has been measured: about one row of small buttons and a little padding. */
const FALLBACK_H = 36

/** Which of the four looks a title is wearing: a highlight that is see-through is soft, an outline is outline, anything else plain. */
function styleOf(def: TitleDef): TikTokStyle {
  if (def.lineBox) return def.lineBox.opacity < 1 ? 'soft' : 'highlight'
  return def.outline && def.outline.widthPx > 0 ? 'outline' : 'plain'
}

/** The styling of a look, as a patch that also clears what the look does not have. */
function lookPatch(style: TikTokStyle): Partial<TitleDef> | null {
  const s = titleLookById(STYLE_LOOK[style])?.style
  if (!s) return null
  return { fontFamily: s.fontFamily, bold: s.bold, color: s.color, shadow: s.shadow, outline: s.outline, lineBox: s.lineBox }
}

export function TikTokTextBar() {
  const tiktokMode = useSettings((s) => s.tiktokMode)
  const editing = useTextEdit((s) => s.editing)
  const def = useStore((s) =>
    editing
      ? activeSequence(s.project)
          .tracks.flatMap((t) => t.clips)
          .find((c) => c.id === editing.clipId)?.title
      : undefined,
  )
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0, cw: 0, ch: 0 })
  const shown = tiktokMode && !!editing?.box && !!def

  // The bar's own size and the monitor's, read when the bar appears and again whenever either one
  // is resized, so a monitor that is resized keeps the bar where it belongs. Where the bar sits
  // against the text box is worked out in render from the box, which follows the title's size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const host = el.parentElement
    const read = () => {
      const next = { w: el.offsetWidth, h: el.offsetHeight, cw: host?.clientWidth ?? 0, ch: host?.clientHeight ?? 0 }
      setSize((prev) => (prev.w === next.w && prev.h === next.h && prev.cw === next.cw && prev.ch === next.ch ? prev : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    if (host) ro.observe(host)
    return () => ro.disconnect()
  }, [shown])

  if (!shown || !editing?.box || !def) return null

  const { box, clipId } = editing
  const style = styleOf(def)
  const align = def.align
  const AlignIcon = ALIGN_ICON[align]
  const wearing = (def.lineBox ? def.lineBox.color : def.color).toLowerCase()

  const barH = size.h || FALLBACK_H
  // Above the box, or below it when the top of the monitor leaves no room.
  const above = box.top - barH - GAP
  const sitsAbove = above >= EDGE
  let top = sitsAbove ? above : box.top + box.h + GAP
  if (size.ch > 0) top = Math.min(top, size.ch - barH - EDGE)
  let left = box.left + box.w / 2 - size.w / 2
  if (size.cw > 0) left = Math.min(left, size.cw - size.w - EDGE)
  left = Math.max(EDGE, left)

  // The tooltips open on the side away from the text: up while the bar is above it, down once it has flipped below.
  const tipSide = sitsAbove ? 'top' : 'bottom'
  const nextStyle = STYLE_CYCLE[(STYLE_CYCLE.indexOf(style) + 1) % STYLE_CYCLE.length]!
  const nextAlign = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(align) + 1) % ALIGN_CYCLE.length]!

  const cycleStyle = () => {
    const patch = lookPatch(nextStyle)
    if (patch) updateTitle(clipId, patch)
  }
  const pickDot = (color: string) => {
    // A highlight takes the colour on its box and the text flips to whatever reads on it; any other
    // look takes it on the text.
    if (def.lineBox) updateTitle(clipId, { lineBox: { ...def.lineBox, color }, color: contrastTextColor(color) })
    else updateTitle(clipId, { color })
  }

  return (
    <div
      ref={ref}
      data-testid="tiktok-text-bar"
      {...{ [KEEPS_TEXT_EDIT]: '' }}
      role="toolbar"
      aria-label="TikTok text style"
      className="pointer-events-auto absolute z-20 flex items-center gap-1 rounded-overlay border border-border-strong bg-bg-elevated p-1"
      style={{ left, top }}
      // A press here is the bar's: not the picture's under it, and not a move of the focus off the field.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <IconButton
        tipSide={tipSide}
        label={`Text style: ${STYLE_NAME[style]}. Click for ${STYLE_NAME[nextStyle]}.`}
        active={style !== 'plain'}
        onClick={cycleStyle}
        data-testid="tiktok-style"
        data-style={style}
      >
        <span className="text-ui font-semibold leading-none" aria-hidden>
          A
        </span>
      </IconButton>
      <IconButton
        tipSide={tipSide}
        label={`Align text: ${ALIGN_NAME[align]}. Click for ${ALIGN_NAME[nextAlign]}.`}
        onClick={() => setTitleAlign(clipId, nextAlign)}
        data-testid="tiktok-align"
        data-align={align}
      >
        <AlignIcon size={14} strokeWidth={1.5} aria-hidden />
      </IconButton>
      <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-1 px-0.5">
        {TIKTOK_DOTS.map((d) => {
          const on = wearing === d.color
          return (
            <button
              key={d.id}
              type="button"
              aria-label={`${def.lineBox ? 'Highlight' : 'Text'} colour: ${d.label}`}
              aria-pressed={on}
              data-testid={`tiktok-dot-${d.id}`}
              onClick={() => pickDot(d.color)}
              className={`size-4 shrink-0 cursor-default rounded-full border-2 transition-transform duration-[120ms] active:scale-90 ${
                on ? 'border-accent' : 'border-border-strong hover:border-text-secondary'
              }`}
              style={{ background: d.color }}
            />
          )
        })}
      </div>
    </div>
  )
}
