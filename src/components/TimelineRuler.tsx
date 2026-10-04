import { memo } from 'react'
import { useStore } from '../state/store'
import { RULER_H, tickSpecFor, rulerLabel } from './timelineGeometry'

/**
 * Ticks are built ONLY for the visible window and the component is memoized.
 * Zoomed in, majorStepS drops to 0.1s, so a 5-minute project meant ~3,600 majors
 * x 7 DOM nodes, and Ruler re-rendered with its parent, i.e. on every pointermove
 * of a clip drag or a zoom-slider drag. It sits inside the same content div as the
 * clips, which are already virtualized and memoized for exactly this reason.
 */
export const Ruler = memo(function Ruler({
  contentWidth,
  lengthS,
  winStartS,
  winEndS,
}: {
  contentWidth: number
  lengthS: number
  winStartS: number
  winEndS: number
}) {
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const { majorStepS, minorStepS, minorParts } = tickSpecFor(pxPerS)

  // Snap the window to the tick grid so labels never shift as you scroll. The
  // ticks are COUNTED, not summed: adding 0.1 a few hundred times drifts, and a
  // drifted tick is drawn a hair off its own label.
  const from = Number.isFinite(winStartS) ? Math.max(0, Math.floor(winStartS / majorStepS)) : 0
  const to = Number.isFinite(winEndS) ? Math.min(lengthS, winEndS) : lengthS
  const majors: number[] = []
  for (let i = from; i * majorStepS <= to + 1e-9; i++) majors.push(i)
  const minors = Array.from({ length: minorParts - 1 }, (_, i) => i + 1)

  return (
    <div
      className="pointer-events-none relative shrink-0 border-b border-border bg-bg-panel"
      style={{ width: contentWidth, height: RULER_H }}
    >
      {majors.map((i) => (
        <div key={i} className="absolute bottom-0 top-0" style={{ left: i * majorStepS * pxPerS }}>
          <div className="absolute bottom-0 h-2.5 w-px bg-border-strong" />
          <span className="absolute left-1 top-1 font-numeric text-[11px] text-text-muted">
            {rulerLabel(i * majorStepS, majorStepS)}
          </span>
          {minors.map((m) => (
            <div
              key={m}
              className="absolute bottom-0 h-1 w-px bg-border"
              style={{ left: m * minorStepS * pxPerS }}
            />
          ))}
        </div>
      ))}
    </div>
  )
})
