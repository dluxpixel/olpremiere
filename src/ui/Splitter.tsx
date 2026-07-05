import { useRef, type PointerEvent } from 'react'

export interface SplitterProps {
  /** 'vertical' splits left/right (drag on X); 'horizontal' splits top/bottom (drag on Y). */
  orientation: 'vertical' | 'horizontal'
  /** Called with the pointer delta in px since the last event. */
  onDrag: (deltaPx: number) => void
  onDragEnd?: () => void
  testId?: string
}

/** 4px-hit-area resizable splitter (spec §6.4). */
export function Splitter({ orientation, onDrag, onDragEnd, testId }: SplitterProps) {
  const last = useRef(0)
  const vertical = orientation === 'vertical'

  const handleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = vertical ? e.clientX : e.clientY
  }
  const handleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const pos = vertical ? e.clientX : e.clientY
    const delta = pos - last.current
    if (delta !== 0) {
      last.current = pos
      onDrag(delta)
    }
  }
  const handleUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      onDragEnd?.()
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
