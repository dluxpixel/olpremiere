import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { formatTimecode } from '../engine/timecode'
import type { Id, Marker, Sequence } from '../engine/types'
import { workArea } from '../engine/workArea'
import { CLICK_SLOP_PX, RULER_H } from './timelineGeometry'
import { Ruler } from './TimelineRuler'

/**
 * What a marker on the ruler does when he takes hold of it. The Timeline owns
 * the time maths (the content offset, the frame grid, the snap points) and the
 * edits; the ruler only reports the gesture.
 */
export interface MarkerActions {
  /** Where a marker dragged to this pointer lands: a whole frame, snapped, never back onto `originS`. */
  timeAt: (clientX: number, originS: number) => number
  /** The drag is over (the snap line goes). */
  end: () => void
  /** Commit a drag: one undo step. */
  move: (markerId: Id, tS: number) => void
  /** A click: the playhead goes to the marker. */
  jump: (markerId: Id) => void
  /** A right click: name it or remove it. */
  menu: (e: ReactMouseEvent, markerId: Id) => void
}

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
  markerActions,
}: {
  seq: Sequence
  pxPerS: number
  contentWidth: number
  lengthS: number
  winStartS: number
  winEndS: number
  onScrubStart: (clientX: number) => void
  onScrubDrag: (clientX: number) => void
  /** Absent, the markers are only drawn (they take no pointer). */
  markerActions?: MarkerActions
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
        <MarkerPin key={m.id} marker={m} pxPerS={pxPerS} fps={seq.fps} actions={markerActions} />
      ))}
    </div>
  )
}

/**
 * One marker diamond.
 *
 * ⛔ A MARKER TAKES THE POINTER, 2026-10-07. Markers are how he marks beats
 * while the song plays, and they took no pointer at all: a misplaced one could
 * only be deleted with Shift+M and tapped again, and its name never showed,
 * not even as a tooltip. Now a click jumps the playhead to it, a drag moves it
 * (on a whole frame, snapping, one undo step) and a right click names or
 * removes it. The press is the marker's own, so it never scrubs the ruler
 * under it, and a press that stays within the click slop is a click.
 */
function MarkerPin({ marker: m, pxPerS, fps, actions }: { marker: Marker; pxPerS: number; fps: number; actions?: MarkerActions }) {
  const [dragT, setDragT] = useState<number | null>(null)
  const press = useRef<{ x: number; live: boolean } | null>(null)
  const t = dragT ?? m.t
  return (
    <div
      data-testid="marker"
      title={m.label || formatTimecode(m.t, fps)}
      // The diamond is 8 px; the pseudo element widens what the pointer can catch.
      className={`absolute h-2 w-2 rotate-45 rounded-mark ${
        actions ? "cursor-grab before:absolute before:-inset-1 before:content-['']" : 'pointer-events-none'
      }`}
      style={{ left: t * pxPerS - 4, top: RULER_H - 11, background: m.color }}
      onPointerDown={(e) => {
        if (!actions) return
        // Every press is the marker's, a right press too: on to the ruler it
        // scrubbed, so the playhead jumped to the pointer before the menu opened.
        e.stopPropagation()
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        press.current = { x: e.clientX, live: false }
      }}
      onPointerMove={(e) => {
        const p = press.current
        if (!p || !actions) return
        // The marker's own gesture: the ruler under it is not scrubbing.
        e.stopPropagation()
        if (!p.live && Math.abs(e.clientX - p.x) < CLICK_SLOP_PX) return
        p.live = true
        setDragT(actions.timeAt(e.clientX, m.t))
      }}
      onPointerUp={(e) => {
        const p = press.current
        press.current = null
        if (!p || !actions) return
        e.stopPropagation()
        if (!p.live) {
          actions.jump(m.id)
          return
        }
        const to = actions.timeAt(e.clientX, m.t)
        setDragT(null)
        actions.end()
        actions.move(m.id, to)
      }}
      onPointerCancel={() => {
        if (!press.current) return
        press.current = null
        setDragT(null)
        actions?.end()
      }}
      onContextMenu={(e) => {
        if (!actions) return
        // The lanes' own menu (Paste here) is for empty timeline, not this.
        e.stopPropagation()
        actions.menu(e, m.id)
      }}
    />
  )
}
