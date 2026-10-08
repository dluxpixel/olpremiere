import { useRef, type PointerEvent } from 'react'

export interface SplitterProps {
  /** 'vertical' splits left/right (drag on X); 'horizontal' splits top/bottom (drag on Y). */
  orientation: 'vertical' | 'horizontal'
  /**
   * Called with how far the pointer has moved since the press, in px.
   *
   * ⛔ THE TOTAL, NOT THE STEP (2026-10-07). It used to send the move since the last event,
   * and the panel added each one to its size. Past a panel's limit the size stopped but the
   * pointer went on, so on the way back the panel moved at once and the edge ended up far
   * from the pointer. Size at the press plus the total, clamped, keeps the edge under it.
   */
  onDrag: (totalPx: number) => void
  /** The press, before the first move. */
  onDragStart?: () => void
  onDragEnd?: () => void
  testId?: string
}

/** 4px-hit-area resizable splitter (spec §6.4). */
export function Splitter({ orientation, onDrag, onDragStart, onDragEnd, testId }: SplitterProps) {
  const start = useRef(0)
  const sent = useRef(0)
  /** Between the press and the drag's one end. */
  const dragging = useRef(false)
  const vertical = orientation === 'vertical'

  const handleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = vertical ? e.clientX : e.clientY
    sent.current = 0
    dragging.current = true
    onDragStart?.()
  }
  const handleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const total = (vertical ? e.clientX : e.clientY) - start.current
    if (total !== sent.current) {
      sent.current = total
      onDrag(total)
    }
  }
  // ⛔ A DRAG ENDS ONCE, ALSO WHEN THE HANDLE LOSES THE POINTER WITHOUT A RELEASE (2026-10-07).
  // The layout is written when a drag ends, not on every move (useLayoutSizes), so a drag whose
  // end never came would keep the new size on screen and forget it at the next start.
  const finish = () => {
    if (!dragging.current) return
    dragging.current = false
    onDragEnd?.()
  }
  const handleUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      finish()
    }
  }

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={`group relative z-10 shrink-0 ${vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'} bg-border`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onLostPointerCapture={finish}
    >
      {/* Invisible 4px hit area + hover/active highlight */}
      <div
        className={`absolute transition-colors duration-[120ms] group-hover:bg-border-strong group-active:bg-accent ${
          vertical ? '-left-[2px] top-0 h-full w-[5px]' : '-top-[2px] left-0 h-[5px] w-full'
        }`}
      />
    </div>
  )
}
