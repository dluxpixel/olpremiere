import { formatTimecode } from '../engine/timecode'
import type { Sequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { RULER_H } from './timelineGeometry'
import { Ruler } from './TimelineRuler'

/**
 * The strip above the lanes: the time ruler, the work area and the markers.
 * It sticks to the top of the scroll and scrubs the playhead: a press lands
 * on its own frame (`onScrubStart`), a drag streams through `onScrubDrag`.
 */
export function TimelineRulerBar({
  seq,
  pxPerS,
  contentWidth,
  lengthS,
  winStartS,
  winEndS,
  onScrubStart,
  onScrubDrag,
}: {
  seq: Sequence
  pxPerS: number
  contentWidth: number
  lengthS: number
  winStartS: number
  winEndS: number
  onScrubStart: (clientX: number) => void
  onScrubDrag: (clientX: number) => void
}) {
  const area = workArea(seq)
  return (
    <div
      className="sticky top-0 z-20 cursor-ew-resize"
      data-testid="ruler"
      // A finger on the ruler scrubs, it does not scroll.
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        onScrubStart(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrubDrag(e.clientX)
      }}
    >
      <Ruler contentWidth={contentWidth} lengthS={lengthS} winStartS={winStartS} winEndS={winEndS} />
      {/* Work area: the range an export renders. Drawn under the markers
          so a marker sitting on the in point stays legible. */}
      {area.active && (
        <>
          <div
            data-testid="work-area"
            className="pointer-events-none absolute top-0 border-x border-accent bg-accent/20"
            style={{
              left: area.startS * pxPerS,
              width: Math.max(1, (area.endS - area.startS) * pxPerS),
              height: RULER_H,
            }}
          />
          <div
            data-testid="work-area-in"
            title={`In ${formatTimecode(area.startS, seq.fps)}`}
            className="pointer-events-none absolute h-2 w-2 bg-accent"
            style={{ left: area.startS * pxPerS, top: 0, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
          />
          <div
            data-testid="work-area-out"
            title={`Out ${formatTimecode(area.endS, seq.fps)}`}
            className="pointer-events-none absolute h-2 w-2 bg-accent"
            style={{ left: area.endS * pxPerS - 8, top: 0, clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
          />
        </>
      )}
      {seq.markers.map((m) => (
        <div
          key={m.id}
          data-testid="marker"
          title={m.label || formatTimecode(m.t, seq.fps)}
          className="pointer-events-none absolute h-2 w-2 rotate-45 rounded-[1px]"
          style={{ left: m.t * pxPerS - 4, top: RULER_H - 11, background: m.color }}
        />
      ))}
    </div>
  )
}
