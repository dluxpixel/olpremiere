// The Motion Rail: the clip's ruler, the ONE x-axis every motion lane reads,
// and the context that hands out the time mapping, the frame snap, the
// selection and the marquee lasso. Times here are LOCAL to the clip, the way
// keyframe times are, so the timecode under a diamond is the diamond's own t.
//
// THE CRITICAL LINE: the playhead is drawn ONCE, by this component, and moved
// by writing a CSS custom property on the rail container. It is NEVER handed to
// a lane as a React prop. The transport writes ui.playheadS on every animation
// frame; a lane subscribed to it re-renders at the display's refresh rate, and
// re-rendering EffectControls plus the lanes at frame rate was measured as a
// big chunk of playback lag (that is why Inspector.tsx still freezes the whole
// panel behind a sentinel while playing). Here a playhead tick costs two DOM
// writes on one element and ZERO React renders, which is what lets that
// sentinel go. The same rule as PlayheadWidgets.tsx, one panel down.
//
// The rail owns the zoom because the lanes cannot: KeyframeLane used to be
// rendered 240px wide with a 76px label gutter, so a 5-frame punch on a
// 20-second clip was under two pixels and could not be grabbed at all. Wheel to
// zoom, drag to pan, double-click to fit the clip.
//
// Lanes live inside this component's box and must not add a horizontal gutter:
// x = 0 is the rail's left edge for the ruler, every lane and the playhead alike.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MOMENT_EPS } from '../engine/keyframes'
import { formatTimecode } from '../engine/timecode'
import { clipDurationS } from '../engine/timeline'
import type { AnimChannel, Clip } from '../engine/types'
import type { KeyframePick } from '../state/clipEdits'
import { useStore } from '../state/store'
import {
  RAIL_ZOOM_STEP,
  clampStart,
  fitView,
  keyframeKey,
  panBy,
  railMinGapS,
  railSnap,
  railTicks,
  zoomAt,
  type RailView,
} from './motionRuler'

/** What the rail is pointed at: a keyframe, or the segment leaving one. */
export type MotionSelectKind = 'key' | 'segment'

/**
 * The one thing the motion desk is currently shaping. A SEGMENT is addressed by
 * the keyframe it leaves, which is what the curve editor opens on: the thing he
 * clicked is the thing he is shaping.
 */
export interface MotionSelection {
  channel: AnimChannel
  kind: MotionSelectKind
  /** LOCAL clip time of the keyframe, or of the keyframe the segment leaves. */
  t: number
}

/** Everything a lane, a curve editor or anything else on the rail needs. */
export interface MotionRailValue {
  clipId: string
  /** Clip length in seconds: the full extent of the axis. */
  durS: number
  fps: number
  /** Current zoom. */
  pxPerS: number
  /** LOCAL time at x = 0. */
  startS: number
  /** Rail width in px, measured. */
  viewW: number
  /** LOCAL time to a pixel on the rail. */
  tToPx: (tS: number) => number
  /** A pixel on the rail back to LOCAL time. */
  pxToT: (px: number) => number
  /** Frame-snap a local time and hold it inside the clip. */
  snapT: (tS: number) => number
  /**
   * Closest a drag may park two moments: ONE FRAME. The state actions clamp to
   * the same rule, so a lane's live draft lands exactly where the commit does.
   */
  minGapS: number
  selection: MotionSelection | null
  /** Passing additive keeps the existing picks and toggles this one. */
  select: (next: MotionSelection | null, additive?: boolean) => void
  /** The multi-select, by keyframeKey, for O(1) lane lookups. */
  picked: ReadonlySet<string>
  isPicked: (channel: AnimChannel, tS: number) => boolean
  /** The same multi-select as moveKeyframes / scaleKeyframeSpan want it. */
  picks: readonly KeyframePick[]
  clearPicks: () => void
  /**
   * How far a live GROUP drag has slid the multi-select, in seconds, or null
   * when no group drag is running.
   *
   * It lives on the RAIL rather than on the lane that started it because a
   * selection crosses lanes: lasso a scale diamond and a position diamond, drag
   * either one, and both have to travel. A lane holding its own delta would move
   * only its own, and he would let go to find the selection torn apart.
   */
  groupDeltaS: number | null
  setGroupDelta: (deltaS: number | null) => void
  /**
   * Slide every pick by `deltaS`, because the keyframes underneath just moved by
   * exactly that much.
   *
   * Without it a group drag lands and the selection collapses to whichever
   * diamond he happened to have hold of, so nudging the same five twice means
   * lassoing them again in between.
   */
  shiftPicks: (deltaS: number) => void
  /**
   * Whether the LANES draw at all. The rail is always mounted, so a lane never
   * has to ask whether it has an axis; what folds away under the shelf's 'Tune
   * it by hand' is the drawing, not the wiring.
   */
  lanesVisible: boolean
}

export const MotionRailContext = createContext<MotionRailValue | null>(null)

/** Read the rail. Throws outside one, because a lane without an axis is a bug. */
export function useMotionRail(): MotionRailValue {
  const ctx = useContext(MotionRailContext)
  if (!ctx) throw new Error('useMotionRail must be used inside a <MotionRail>')
  return ctx
}

/**
 * Every diamond a lane draws spreads these onto its element. It is the whole
 * registration protocol: the lasso finds keyframes by querying the rail's own
 * subtree, so no lane ever has to publish its geometry to anyone.
 */
export function keyframeMarkProps(
  channel: AnimChannel,
  t: number,
): { 'data-kf-channel': AnimChannel; 'data-kf-t': string } {
  return { 'data-kf-channel': channel, 'data-kf-t': t.toFixed(6) }
}

/** Pointer slop before a press on empty rail becomes a lasso rather than a click. */
const LASSO_SLOP_PX = 3

const samePick = (a: KeyframePick, b: KeyframePick): boolean =>
  a.channel === b.channel && Math.abs(a.t - b.t) <= MOMENT_EPS

/** Keyframe marks whose box intersects the lasso, in client coordinates. */
function keyframesInBox(root: HTMLElement, ax: number, ay: number, bx: number, by: number): KeyframePick[] {
  const x0 = Math.min(ax, bx)
  const x1 = Math.max(ax, bx)
  const y0 = Math.min(ay, by)
  const y1 = Math.max(ay, by)
  const hits: KeyframePick[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-kf-channel]')) {
    const r = el.getBoundingClientRect()
    if (r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1) continue
    const channel = el.dataset.kfChannel as AnimChannel | undefined
    const t = Number(el.dataset.kfT)
    if (!channel || !Number.isFinite(t)) continue
    const pick: KeyframePick = { channel, t }
    if (!hits.some((h) => samePick(h, pick))) hits.push(pick)
  }
  return hits
}

/**
 * Eat the click the browser fires at the end of a lasso drag, so releasing over
 * a lane does not also select the segment under the pointer.
 */
function swallowNextClick(): void {
  const onClick = (e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', onClick, { capture: true, once: true })
  // No click arrived (the release left the window): drop the trap rather than
  // leaving it armed for the next unrelated click.
  setTimeout(() => window.removeEventListener('click', onClick, true), 0)
}

export function MotionRail({
  clip,
  fps,
  children,
  lanes = true,
}: {
  clip: Clip
  fps: number
  children: ReactNode
  /** Draw the ruler, the lanes and the curve editors. Off is the closed shelf. */
  lanes?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)

  const durS = clipDurationS(clip)
  const [viewW, setViewW] = useState(0)
  const [view, setView] = useState<RailView>(() => fitView(durS, 0))
  const [selection, setSelection] = useState<MotionSelection | null>(null)
  const [picks, setPicks] = useState<readonly KeyframePick[]>([])
  const [groupDeltaS, setGroupDeltaS] = useState<number | null>(null)

  // The pointer handlers read the CURRENT view, width and clip through refs, not
  // through the closure they were installed with: the first pointermove after a
  // pointerdown otherwise sees the pre-drag state. Same pattern as the keyframe
  // drag one file over.
  const viewRef = useRef(view)
  viewRef.current = view
  const viewWRef = useRef(viewW)
  viewWRef.current = viewW
  const durRef = useRef(durS)
  durRef.current = durS
  const clipStartRef = useRef(clip.startS)
  clipStartRef.current = clip.startS

  // --- measurement ------------------------------------------------------------

  useLayoutEffect(() => {
    const el = rulerRef.current
    if (!el) return
    const measure = (): void => setViewW(el.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit ONCE per clip (that is "fits the clip on open"), then leave his zoom
  // alone: a panel resize only pulls the view back over the clip.
  const fittedRef = useRef('')
  useLayoutEffect(() => {
    if (viewW <= 0) return
    if (fittedRef.current !== clip.id) {
      fittedRef.current = clip.id
      setView(fitView(durS, viewW))
      return
    }
    setView((v) => {
      const startS = clampStart(v.startS, durS, v.pxPerS, viewW)
      return startS === v.startS ? v : { pxPerS: v.pxPerS, startS }
    })
  }, [clip.id, durS, viewW])

  // A different clip is a different set of moments: nothing stays selected, and
  // a group drag that was running belongs to keyframes no longer on screen.
  useEffect(() => {
    setSelection(null)
    setPicks([])
    setGroupDeltaS(null)
  }, [clip.id])

  // --- the playhead, drawn once -----------------------------------------------

  // Two DOM writes on the container, no React render anywhere. Reads refs only,
  // so it is safe to install once and call from anywhere.
  const writePlayhead = (globalT: number): void => {
    const root = rootRef.current
    if (!root) return
    const v = viewRef.current
    const localT = globalT - clipStartRef.current
    const px = (localT - v.startS) * v.pxPerS
    const onScreen =
      localT >= -MOMENT_EPS && localT <= durRef.current + MOMENT_EPS && px >= 0 && px <= viewWRef.current
    root.style.setProperty('--rail-playhead', `${px}px`)
    root.style.setProperty('--rail-playhead-on', onScreen ? '1' : '0')
  }

  // Subscribed ONCE, for the life of the rail: writePlayhead reads the zoom, the
  // pan and the clip head through refs, so a resubscribe per zoom would buy
  // nothing and drop ticks while it happened.
  useEffect(() => {
    writePlayhead(useStore.getState().ui.playheadS)
    return useStore.subscribe((s) => s.ui.playheadS, writePlayhead)
  }, [])

  // Zoom, pan, resize or a clip switch moved the axis under a stationary
  // playhead: reposition it on the render path, at the time it is already at.
  useLayoutEffect(() => {
    writePlayhead(useStore.getState().ui.playheadS)
  }, [view, viewW, durS, clip.startS])

  // --- zoom and pan -----------------------------------------------------------

  const fitNow = (): void => setView(fitView(durRef.current, viewWRef.current))

  // Non-passive so the wheel zooms the rail instead of scrolling the inspector
  // out from under him. Only over the RULER: a wheel over the lanes still
  // scrolls the panel, which is what a pointer over a list should do.
  useEffect(() => {
    const el = rulerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0) return
      e.preventDefault()
      const px = e.clientX - el.getBoundingClientRect().left
      const factor = e.deltaY < 0 ? RAIL_ZOOM_STEP : 1 / RAIL_ZOOM_STEP
      setView((v) => zoomAt(v, factor, px, durRef.current, viewWRef.current))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // No preventDefault here: cancelling pointerdown is what would cost the rail
  // its double-click-to-fit. `select-none` already stops the drag selecting text.
  const onRulerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const startX = e.clientX
    const from = viewRef.current.startS
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      setView((v) => panBy({ pxPerS: v.pxPerS, startS: from }, dx, durRef.current, viewWRef.current))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- selection --------------------------------------------------------------

  const select = (next: MotionSelection | null, additive = false): void => {
    setSelection(next)
    if (!next || next.kind === 'segment') {
      if (!additive) setPicks([])
      return
    }
    const pick: KeyframePick = { channel: next.channel, t: next.t }
    setPicks((prev) => {
      if (!additive) return [pick]
      return prev.some((p) => samePick(p, pick)) ? prev.filter((p) => !samePick(p, pick)) : [...prev, pick]
    })
  }

  const picked = new Set(picks.map((p) => keyframeKey(p.channel, p.t)))

  const shiftPicks = (deltaS: number): void => {
    if (!Number.isFinite(deltaS) || deltaS === 0) return
    setPicks((prev) => prev.map((p) => ({ ...p, t: p.t + deltaS })))
    // The highlighted moment follows only if it TRAVELLED. A key selection
    // outside the lasso stayed exactly where it was.
    setSelection((prev) => {
      if (!prev || prev.kind !== 'key') return prev
      if (!picked.has(keyframeKey(prev.channel, prev.t))) return prev
      return { ...prev, t: prev.t + deltaS }
    })
  }

  // --- the lasso --------------------------------------------------------------

  // Drawn imperatively for the same reason as the playhead: a lasso across four
  // lanes must not re-render four lanes on every pointermove.
  const onBodyDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const root = rootRef.current
    const box = marqueeRef.current
    if (!root || !box) return
    // A diamond, a field or a button owns its own drag; the lasso starts on
    // empty rail only. The curve editor is listed WHOLE rather than by its
    // parts: its handles are bare <circle>s that match none of the others, so
    // dragging one used to start a lasso as well and the empty box then cleared
    // the selection the editor needs to exist at all. Naming the panel means a
    // control added to it later cannot re-open that hole.
    if (
      (e.target as HTMLElement).closest(
        'button, input, select, textarea, [data-kf-channel], [data-testid="curve-editor"]',
      )
    )
      return
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const x0 = e.clientX
    const y0 = e.clientY
    let moved = false

    const draw = (x: number, y: number): void => {
      const r = root.getBoundingClientRect()
      box.style.left = `${Math.min(x0, x) - r.left}px`
      box.style.top = `${Math.min(y0, y) - r.top}px`
      box.style.width = `${Math.abs(x - x0)}px`
      box.style.height = `${Math.abs(y - y0)}px`
    }
    const onMove = (ev: PointerEvent): void => {
      if (!moved) {
        if (Math.abs(ev.clientX - x0) <= LASSO_SLOP_PX && Math.abs(ev.clientY - y0) <= LASSO_SLOP_PX) return
        moved = true
        box.style.display = 'block'
      }
      draw(ev.clientX, ev.clientY)
    }
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      box.style.display = 'none'
      if (!moved) return
      swallowNextClick()
      const hits = keyframesInBox(root, x0, y0, ev.clientX, ev.clientY)
      setPicks((prev) => {
        if (!additive) return hits
        return [...prev, ...hits.filter((h) => !prev.some((p) => samePick(p, h)))]
      })
      if (hits.length === 0 && !additive) setSelection(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- the axis itself --------------------------------------------------------

  const ctx: MotionRailValue = {
    clipId: clip.id,
    durS,
    fps,
    pxPerS: view.pxPerS,
    startS: view.startS,
    viewW,
    tToPx: (tS) => (tS - view.startS) * view.pxPerS,
    pxToT: (px) => view.startS + (view.pxPerS > 0 ? px / view.pxPerS : 0),
    snapT: (tS) => railSnap(tS, fps, durS),
    minGapS: railMinGapS(fps),
    selection,
    select,
    picked,
    isPicked: (channel, tS) => picked.has(keyframeKey(channel, tS)),
    picks,
    clearPicks: () => setPicks([]),
    groupDeltaS,
    setGroupDelta: setGroupDeltaS,
    shiftPicks,
    lanesVisible: lanes,
  }

  const ticks = railTicks(view, viewW, durS, fps)

  return (
    <MotionRailContext.Provider value={ctx}>
      <div ref={rootRef} data-testid="motion-rail" className="relative flex flex-col gap-1.5">
        <div
          hidden={!lanes}
          ref={rulerRef}
          data-testid="motion-rail-ruler"
          title="Time from the head of the clip · wheel to zoom · drag to pan · double-click to fit"
          onPointerDown={onRulerDown}
          onDoubleClick={fitNow}
          className="relative h-5 shrink-0 cursor-ew-resize select-none overflow-hidden rounded-[3px] bg-bg-input"
          style={{ touchAction: 'none' }}
        >
          {ticks.map((tick) => (
            <div
              key={tick.t}
              className={`pointer-events-none absolute bottom-0 w-px ${tick.major ? 'bg-text-muted' : 'bg-border'}`}
              style={{ left: tick.px, height: tick.major ? 8 : 4 }}
            >
              {tick.major && (
                <span className="absolute bottom-[9px] left-1 whitespace-nowrap font-numeric text-[9px] leading-none text-text-muted">
                  {formatTimecode(tick.t, fps)}
                </span>
              )}
            </div>
          ))}
        </div>

        <div onPointerDown={onBodyDown} className="flex flex-col gap-1.5">
          {children}
        </div>

        {/* ONE playhead for the ruler and every lane under it, moved by the CSS
            custom property this component writes on the container above. */}
        <div
          hidden={!lanes}
          data-testid="motion-rail-playhead"
          className="pointer-events-none absolute inset-y-0 z-20 w-px bg-playhead"
          style={{ left: 'var(--rail-playhead, 0px)', opacity: 'var(--rail-playhead-on, 0)' }}
        />

        <div
          ref={marqueeRef}
          data-testid="motion-rail-marquee"
          className="pointer-events-none absolute z-30 rounded-[2px] border border-accent bg-accent/10"
          style={{ display: 'none' }}
        />
      </div>
    </MotionRailContext.Provider>
  )
}
