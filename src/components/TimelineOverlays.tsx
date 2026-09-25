import { RULER_H } from './timelineGeometry'

// The thin things drawn over the lanes while a gesture runs, plus the empty
// timeline hint and the floating readout. Pure presentation: the Timeline
// decides when each one shows.

/**
 * Snap lock line. Give it `key={t}` so landing on a NEW edge remounts it and
 * re-fires the one-shot pulse. Reduced motion collapses the pulse; the line
 * itself always shows.
 */
export function SnapLine({ t, pxPerS }: { t: number; pxPerS: number }) {
  return (
    <div
      data-testid="snap-line"
      className="pointer-events-none absolute bottom-0 z-30 w-px animate-[snap-pulse_240ms_ease-out] bg-accent"
      style={{ left: t * pxPerS, top: RULER_H }}
    />
  )
}

/** Razor hover: the exact cut line the blade will make. */
export function RazorLine({ t, pxPerS }: { t: number; pxPerS: number }) {
  return (
    <div
      data-testid="razor-line"
      className="pointer-events-none absolute bottom-0 z-30 w-px bg-text-primary/70"
      style={{ left: t * pxPerS, top: RULER_H }}
    />
  )
}

/** The rubber-band rectangle of a box-select, corners in drag order. */
export function MarqueeBox({ box }: { box: { x0: number; y0: number; x1: number; y1: number } }) {
  return (
    <div
      className="pointer-events-none absolute z-30 rounded-[2px] border border-accent bg-accent/10"
      style={{
        left: Math.min(box.x0, box.x1),
        top: Math.min(box.y0, box.y1),
        width: Math.abs(box.x1 - box.x0),
        height: Math.abs(box.y1 - box.y0),
      }}
    />
  )
}

/** Shown over empty lanes until the first clip lands. */
export function EmptyTimelineHint() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center"
      style={{ top: RULER_H }}
    >
      <span className="text-[12px] text-text-muted">Drag a clip here to start</span>
    </div>
  )
}

/** The live readout under the pointer during a trim, move, fade and the rest. Viewport coordinates. */
export function TrimTip({ tip }: { tip: { x: number; y: number; text: string } }) {
  return (
    <div
      className="pointer-events-none fixed z-[90] rounded-[4px] border border-border bg-bg-elevated px-2 py-1 font-numeric text-[11px] text-text-primary shadow-pop"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>
  )
}
