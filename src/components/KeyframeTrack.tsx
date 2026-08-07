// ONE lane for ONE property, hosted on the Motion Rail.
//
// Every keyframe is a diamond at its own LOCAL clip time, placed through the
// rail's tToPx, so this lane, the ruler, the playhead and every other lane can
// never disagree about where a moment is. There is no label gutter any more:
// the PropRow directly above already names the property, and the 76px that
// gutter used to eat is exactly what makes a 5-frame punch wide enough to grab.
// The playhead is not drawn here either; the rail draws it once, for all lanes.
//
// KEPT from the old KeyframeLane, because both were hard-won:
//   - the drag. Window-level move/up listeners installed on pointerdown (a
//     12px diamond is far too small to trust pointer capture on), a 3px slop
//     before a press counts as a drag, and the drag's truth in a REF so the
//     first pointermove never reads the pre-drag closure.
//   - the Zoom colouring. AMBER when a diamond zooms IN from the one before
//     it, BLUE when it zooms OUT. Nothing else in the app reads that fast.
//
// ADDED: Alt-drag copies a diamond, carrying its value, its ease AND its
// curve, to wherever he drops it. Clicking the rail BETWEEN two diamonds
// selects that SEGMENT, which is the thing the curve editor opens on.
//
// GONE: the five ease buttons. Easing belongs to the segment, not to the
// keyframe it happens to start at, and it is shaped in the curve editor now.
//
// The maths a lane runs on - where a diamond sits, what colour it reads, which
// segment a click landed in - lives in keyframeMarks.ts, so it can be tested
// without the React/DOM stack the way motionRuler.ts is.

import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { channelKeyframes, isChannelAnimated } from '../engine/effects/channels'
import { MOMENT_EPS } from '../engine/keyframes'
import { formatTimecode } from '../engine/timecode'
import type { AnimChannel, Clip, Keyframe } from '../engine/types'
import { duplicateKeyframe, moveKeyframeTime, removeKeyframeAtTime } from '../state/clipEdits'
import { IconButton } from '../ui/Button'
import { ScrubField, type Spec } from './EffectControls'
import {
  CULL_PAD_PX,
  DRAG_SLOP_PX,
  ZOOM_IN,
  ZOOM_OUT,
  diamondColor,
  dragTargetT,
  friendly,
  segmentIndexAt,
} from './keyframeMarks'
import { keyframeMarkProps, useMotionRail } from './MotionRail'

interface DragState {
  origT: number
  draftT: number
  /** Zoom as it was when the press landed, so the drag keeps one scale throughout. */
  pxPerS: number
  startX: number
  moved: boolean
  /** Alt was down on the press: this drag copies the diamond instead of moving it. */
  copy: boolean
}

/** What the render needs to draw the diamond mid-drag (the ref holds the truth). */
interface DragView {
  origT: number
  t: number
  copy: boolean
}

export function KeyframeTrack({ clip, channel }: { clip: Clip; channel: AnimChannel }) {
  const rail = useMotionRail()
  // The drag's authoritative data lives in a ref so pointer handlers never read
  // a stale closure (the first pointermove after pointerdown otherwise sees the
  // pre-drag state). `dragView` mirrors just enough for the render.
  const dragRef = useRef<DragState | null>(null)
  const [dragView, setDragView] = useState<DragView | null>(null)
  // A drag that ends over the rail still fires a click there; without this the
  // retime he just made would also open the curve editor on whatever segment
  // he happened to release over. Same one-shot trap the rail's lasso uses.
  const swallowClickRef = useRef(false)

  if (!isChannelAnimated(clip, channel)) return null

  const kfs = channelKeyframes(clip, channel)
  const { durS, fps, selection, viewW } = rail
  const name = friendly(channel)

  const selKey =
    selection && selection.kind === 'key' && selection.channel === channel ? selection.t : null
  const selSeg =
    selection && selection.kind === 'segment' && selection.channel === channel ? selection.t : null
  const selKf = selKey === null ? null : kfs.find((k) => Math.abs(k.t - selKey) <= MOMENT_EPS) ?? null

  const onScreen = (px: number): boolean =>
    viewW <= 0 || (px >= -CULL_PAD_PX && px <= viewW + CULL_PAD_PX)
  const clampPx = (px: number): number => (viewW <= 0 ? px : Math.min(Math.max(px, 0), viewW))

  // Window-level move/up listeners (installed on pointerdown, removed on up) so
  // the drag keeps tracking even when the pointer leaves the small diamond - more
  // robust than relying on pointer capture for such a tiny target.
  const onDiamondDown = (e: React.PointerEvent<HTMLButtonElement>, k: Keyframe) => {
    if (e.button !== 0) return
    e.preventDefault()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    dragRef.current = {
      origT: k.t,
      draftT: k.t,
      pxPerS: rail.pxPerS,
      startX: e.clientX,
      moved: false,
      copy: e.altKey,
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      d.moved = d.moved || Math.abs(dx) > DRAG_SLOP_PX
      d.draftT = rail.snapT(dragTargetT(d.origT, dx, d.pxPerS))
      if (d.moved) setDragView({ origT: d.origT, t: d.draftT, copy: d.copy })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDragView(null)
      if (!d) return
      if (d.moved) {
        swallowClickRef.current = true
        setTimeout(() => {
          swallowClickRef.current = false
        }, 0)
      }
      if (d.moved && Math.abs(d.draftT - d.origT) > 1e-6) {
        // Alt: the same shaped moment, value, ease and curve, somewhere else.
        if (d.copy) duplicateKeyframe(clip.id, channel, d.origT, d.draftT)
        else moveKeyframeTime(clip.id, channel, d.origT, d.draftT)
        rail.select({ channel, kind: 'key', t: d.draftT })
      } else {
        // A click (no meaningful drag): toggle selection. The rail owns it now,
        // so the toggle compares against the selection as it was on the press.
        const already = selKey !== null && Math.abs(selKey - k.t) <= MOMENT_EPS
        rail.select(already && !additive ? null : { channel, kind: 'key', t: k.t }, additive)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Click the rail BETWEEN two diamonds and that SEGMENT is what he is shaping.
  // Outside the animated span there is no move, so the click clears instead.
  const onRailClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false
      return
    }
    if ((e.target as HTMLElement).closest('[data-kf-channel]')) return
    const t = rail.pxToT(e.clientX - e.currentTarget.getBoundingClientRect().left)
    const i = segmentIndexAt(kfs, t)
    if (i < 0) {
      rail.select(null)
      return
    }
    const segT = kfs[i].t
    const already = selSeg !== null && Math.abs(selSeg - segT) <= MOMENT_EPS
    rail.select(already ? null : { channel, kind: 'segment', t: segT })
  }

  const timeSpec: Spec = {
    min: 0,
    max: Math.max(0.01, durS),
    step: fps > 0 ? 1 / fps : 0.01,
    sens: durS / 280,
  }

  // The selected segment, drawn as a band under the diamonds: the move he is
  // shaping, highlighted the length it actually runs.
  const segIdx = selSeg === null ? -1 : kfs.findIndex((k) => Math.abs(k.t - selSeg) <= MOMENT_EPS)
  const segBand =
    segIdx >= 0 && segIdx < kfs.length - 1
      ? { left: clampPx(rail.tToPx(kfs[segIdx].t)), right: clampPx(rail.tToPx(kfs[segIdx + 1].t)) }
      : null

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="keyframe-track"
        data-channel={channel}
        onClick={onRailClick}
        title={`${name} keyframes · drag to retime · Alt-drag to duplicate · click between two diamonds to shape that move`}
        className="relative h-5 w-full rounded-[3px] bg-bg-input"
      >
        {/* mid-line rail */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {segBand && (
          <div
            data-testid="keyframe-segment"
            className="pointer-events-none absolute inset-y-0 rounded-[2px] bg-accent-quiet"
            style={{ left: segBand.left, width: Math.max(2, segBand.right - segBand.left) }}
          />
        )}
        {kfs.map((k, i) => {
          const dragging = dragView !== null && Math.abs(dragView.origT - k.t) <= MOMENT_EPS
          // A copy drag leaves the original exactly where it is and carries a ghost.
          const t = dragging && !dragView!.copy ? dragView!.t : k.t
          const px = rail.tToPx(t)
          if (!onScreen(px)) return null
          const isSel = selKey !== null && Math.abs(selKey - k.t) <= MOMENT_EPS
          const picked = rail.isPicked(channel, k.t)
          const color =
            dragging && !dragView!.copy ? 'var(--color-accent)' : diamondColor(channel, kfs, i, isSel)
          return (
            <button
              key={k.t}
              type="button"
              data-testid="keyframe"
              {...keyframeMarkProps(channel, k.t)}
              aria-label={`${name} keyframe at ${t.toFixed(2)}s, value ${k.value}`}
              title={`${name} = ${Math.round(k.value * 100) / 100} @ ${t.toFixed(2)}s · ${k.ease} · drag to retime · Alt-drag to duplicate`}
              onPointerDown={(e) => onDiamondDown(e, k)}
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize rounded-[2px] border border-black/30 transition-[background,box-shadow,transform] duration-[120ms] hover:scale-110"
              style={{
                left: px,
                touchAction: 'none',
                background: color,
                boxShadow: isSel || picked || dragging ? '0 0 0 2px var(--color-accent)' : undefined,
              }}
            />
          )
        })}
        {/* The copy an Alt-drag is about to drop, hollow until he lets go. */}
        {dragView?.copy && onScreen(rail.tToPx(dragView.t)) && (
          <div
            data-testid="keyframe-ghost"
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border border-accent"
            style={{ left: rail.tToPx(dragView.t), background: 'var(--color-accent-quiet)' }}
          />
        )}
        {/* Live time readout while dragging a diamond on this lane. */}
        {dragView && (
          <div
            className="pointer-events-none absolute -top-4 z-10 -translate-x-1/2 whitespace-nowrap rounded-[3px] border border-border bg-bg-elevated px-1 py-px font-numeric text-[9px] text-text-primary shadow-pop"
            style={{ left: clampPx(rail.tToPx(dragView.t)) }}
          >
            {dragView.copy ? '+ ' : ''}
            {formatTimecode(dragView.t, fps)}
          </div>
        )}
      </div>

      {/* Legend for the zoom colour-coding - only on the Zoom lane. */}
      {channel === 'scale' && (
        <div className="flex flex-wrap items-center gap-3 text-[9px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: ZOOM_IN }} /> zoom in
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: ZOOM_OUT }} /> zoom out
          </span>
          <span className="text-text-muted/70">· click between two diamonds to shape that move</span>
        </div>
      )}

      {selKf && (
        <div className="flex flex-wrap items-center gap-2 rounded-overlay bg-bg-elevated/60 p-2">
          <span className="text-[10px] uppercase tracking-[0.04em] text-text-muted">Time</span>
          <ScrubField
            value={selKf.t}
            spec={timeSpec}
            testId="keyframe-time"
            ariaLabel="Keyframe time (seconds)"
            onCommit={(v) => {
              const t = rail.snapT(v)
              moveKeyframeTime(clip.id, channel, selKf.t, t)
              rail.select({ channel, kind: 'key', t })
            }}
          />
          <IconButton
            size="compact"
            label="Delete keyframe"
            data-testid="keyframe-delete"
            onClick={() => {
              removeKeyframeAtTime(clip.id, channel, selKf.t)
              rail.select(null)
            }}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      )}
    </div>
  )
}
