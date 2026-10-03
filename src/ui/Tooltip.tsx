import { useRef, useState, type ReactNode } from 'react'

export interface TooltipProps {
  label: string
  /** Already human-formatted, e.g. "Ctrl+K" - use comboLabel(). */
  shortcut?: string
  side?: 'top' | 'bottom'
  children: ReactNode
}

/** Air left between a tooltip and the edge of whatever would cut it off. */
const EDGE_GAP = 4

/**
 * The horizontal span a tooltip can paint in: inside the nearest ancestor that hides
 * or scrolls overflow (the inspector, a dialog), else the window. Anything past it
 * is cut off, so that is the edge to stay inside, not the screen's.
 */
function visibleSpan(from: HTMLElement): { left: number; right: number } {
  for (let p = from.parentElement; p; p = p.parentElement) {
    if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX)) {
      const r = p.getBoundingClientRect()
      return { left: Math.max(0, r.left + p.clientLeft), right: Math.min(window.innerWidth, r.left + p.clientLeft + p.clientWidth) }
    }
  }
  return { left: 0, right: window.innerWidth }
}

/**
 * Lightweight CSS-only tooltip. Every toolbar control shows its shortcut here
 * (spec §7). Rendered inline; fine for toolbars, not for viewport edges.
 *
 * ⛔ IT IS CENTRED ON ITS BUTTON, AND A BUTTON AT THE EDGE OF A PANEL PUT HALF THE
 * WORDS OUTSIDE IT (2026-10-03). The stopwatch sits in the first 24px of every
 * inspector row, so "Animate volume (keyframes)" centred on it ran 60px past the
 * panel's left edge and the panel, which scrolls, cut it to "nimating volume".
 * CSS cannot know where the edge is, so on hover the tooltip is measured once and
 * slid back inside it. The button never moves, and a tooltip that already fits is
 * not touched.
 */
export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  const pos = side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
  const wrap = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)

  // The tooltip only exists on screen once the hover that triggered this has taken
  // effect, so the measuring waits one frame.
  const fitInside = () => {
    requestAnimationFrame(() => {
      const t = tip.current
      const w = wrap.current
      if (!t || !w) return
      const r = t.getBoundingClientRect()
      if (r.width === 0) return
      const span = visibleSpan(w)
      const left = r.left - shift
      const right = r.right - shift
      let dx = 0
      if (left < span.left + EDGE_GAP) dx = span.left + EDGE_GAP - left
      else if (right > span.right - EDGE_GAP) dx = span.right - EDGE_GAP - right
      if (dx !== shift) setShift(dx)
    })
  }

  return (
    <span ref={wrap} className="group/tip relative inline-flex" onMouseEnter={fitInside}>
      {children}
      <span
        ref={tip}
        role="tooltip"
        style={shift ? { marginLeft: shift } : undefined}
        className={`pointer-events-none absolute left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded-field border border-border bg-bg-elevated px-2 py-1 text-ui-sm text-text-primary shadow-pop group-hover/tip:block ${pos}`}
      >
        {label}
        {shortcut && <span className="ml-1.5 text-text-muted">{shortcut}</span>}
      </span>
    </span>
  )
}
