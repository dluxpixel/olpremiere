import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { clipDurationS, moveSelectionWith, snapTime, splitGroup } from '../engine/timeline'
import { createSnapPointCache } from '../engine/snapPointCache'
import { quantizeToFrame } from '../engine/timecode'
import { activeSequence, audioTracks, videoTracks, type Clip, type Id, type Sequence, type Track } from '../engine/types'
import { openContextMenu } from '../state/contextMenu'
import { pausePlayback } from '../state/playbackControl'
import { updateActiveSequence, useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { usePhoneLayout } from '../ui/phoneLayout'
import { PlayheadLine, RemotePlayheads } from './PlayheadWidgets'
import { pointOnScrollbar } from './scrollbarGuard'
import { TimelineLane } from './TimelineLane'
import { EmptyTimelineHint, MarqueeBox, RazorLine, SnapLine, TrimTip } from './TimelineOverlays'
import { TimelineRulerBar } from './TimelineRulerBar'
import { TimelineToolbar } from './TimelineToolbar'
import { TimelineTrackHeaders } from './TimelineTrackHeaders'
import { clipContextMenuItems } from './timelineClipMenu'
import { useStableCallback, type Drag } from './timelineDrag'
import { ADD_TRACK_ROW_H, CLICK_SLOP_PX, SNAP_PX } from './timelineGeometry'
import {
  carriedOthers,
  dragCommit,
  moveTipText,
  rollPair,
  rollStep,
  slideNeighborIds,
  slideStep,
  slipStep,
  snapMoveStart,
  soloMoveIntent,
  soloTrimIntent,
  stretchStep,
  trimStep,
  type DragStep,
} from './timelineGestures'
import { buildLaneInfos, clipWindowS, laneAtY, lanesCursorClass, marqueeHitIds, silencedTest, timelineLengthS } from './timelineLanes'
import { frameAtOffset } from './timelineZoom'
import { useCoalescedScrub } from './useCoalescedScrub'
import { useEdgeScroll } from './useEdgeScroll'
import { useLanesViewport } from './useLanesViewport'
import { useModifierMods } from './useModifierMods'
import { usePlayheadFollow } from './usePlayheadFollow'
import { useSeenClipIds } from './useSeenClipIds'
import { useTimelineDrop } from './useTimelineDrop'
import { useTimelineZoom } from './useTimelineZoom'

// ---------------------------------------------------------------------------
// Timeline



export function Timeline({ height }: { height: number }) {
  const phone = usePhoneLayout()
  const project = useStore((s) => s.project)
  const seq = activeSequence(project)
  const assets = project.assets
  const pxPerS = useStore((s) => s.ui.pxPerS)
  // DELIBERATELY no playheadS subscription: the transport ticks it every frame,
  // and a hook here re-renders this whole component tree at the display refresh
  // rate - the old "laggy preview". Handlers read it via useStore.getState();
  // the red line + timecodes are imperative leaves (PlayheadWidgets).
  const playing = useStore((s) => s.ui.playing)
  const snapping = useStore((s) => s.ui.snapping)
  const tool = useStore((s) => s.ui.tool)
  const selection = useStore((s) => s.ui.selection)
  const setUI = useStore((s) => s.setUI)
  const show = useToasts((s) => s.show)

  const lanesRef = useRef<HTMLDivElement>(null)
  // Auto-follow suspension: manualScrollUntil holds a timestamp during which the
  // user's own scroll wins; programmaticScroll marks our own scrollLeft writes.
  const manualScrollUntil = useRef(0)
  const programmaticScroll = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)

  const [drag, setDrag] = useState<Drag | null>(null)
  const [previewSeq, setPreviewSeq] = useState<Sequence | null>(null)
  const [snapIndicatorT, setSnapIndicatorT] = useState<number | null>(null)
  const [trimTip, setTrimTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hoverLane, setHoverLane] = useState<{ trackId: Id; valid: boolean } | null>(null)
  const [razorHover, setRazorHover] = useState<{ t: number; top: number } | null>(null)
  const dragFinal = useRef<{ trackId: Id; tS: number } | null>(null)
  /**
   * ⛔ DID THIS GESTURE EVER ACTUALLY MOVE THE CLIP, 2026-08-24. His words: *"I
   * drag, I let go, and it goes back sometimes."*
   *
   * Drag-versus-click used to be decided ONCE, at release, from the straight-line
   * distance between the pointer-up and the pointer-down in CLIENT space. The
   * split itself is right and stays: a click on a clip should scrub to it, not
   * write a no-op move into his undo history.
   *
   * What was wrong is measuring it against a viewport that moves on its own. The
   * drag position is computed in CONTENT space, and two things scroll the lanes
   * under a stationary hand: the edge auto-scroll, which arms on the first
   * pointermove and runs whenever the pointer is within 32px of a lane edge at up
   * to 20px a frame, and the playback auto-follow, which is not suspended during
   * a drag. Grab a clip near the edge, twitch one pixel, watch it fly seconds
   * across the timeline, let go: the pointer is 1px from where it started, the
   * release is read as a CLICK, the commit branch is skipped, and `setPreviewSeq`
   * throws the whole move away. Nothing is logged and there is nothing to undo,
   * because the edit never reached the store. A drag that wanders out and back
   * inside 4px lost the same way.
   *
   * So it is a LATCH on the thing that actually matters, the clip's own position,
   * not a re-measurement of where his hand ended up.
   */
  const dragMoved = useRef(false)
  // Right-drag box-select: a right-button drag on empty timeline rubber-bands a
  // selection (David finds this easier than Ctrl+drag). rightMarqueeRef marks an
  // in-flight right-drag; suppressContextRef swallows the contextmenu that fires
  // on right-button release so a drag-select never pops a menu.
  const rightMarqueeRef = useRef(false)
  // Timestamp of the last right-drag select. The contextmenu fired by that drag
  // is swallowed only if it lands within SUPPRESS_MS - a timestamp (not a bare
  // flag) so a stale suppression can never block a later, legit right-click.
  const suppressContextRef = useRef(0)

  const renderSeq = previewSeq ?? seq
  const vTracks = useMemo(() => [...videoTracks(renderSeq)].reverse(), [renderSeq])
  const aTracks = useMemo(() => audioTracks(renderSeq), [renderSeq])
  const hasClips = seq.tracks.some((t) => t.clips.length > 0)

  const lengthS = timelineLengthS(seq.durationS)
  const contentWidth = lengthS * pxPerS

  // --- Clip virtualization (useLanesViewport) and pop gating (useSeenClipIds)
  const { viewport, scheduleViewportMeasure, measureViewportNow } = useLanesViewport(lanesRef)
  const { winStartS, winEndS } = clipWindowS(viewport, pxPerS)
  const seenClipIds = useSeenClipIds(seq)

  // Lane geometry in content space (below the ruler), for pointer hit tests.
  const laneInfos = useMemo(() => buildLaneInfos(vTracks, aTracks), [vTracks, aTracks])

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const laneAt = (y: number): Track | null => laneAtY(laneInfos, y)

  // Every pointermove during a drag asks for the snap points, and rebuilding
  // them each time walked every clip on every track. Nothing they depend on can
  // move mid-gesture, so the walk is memoized. See snapPointCache.ts.
  const snapPoints = useRef(createSnapPointCache()).current

  const snapWithIndicator = (tS: number, excludeClipId?: Id | Id[]): number => {
    if (!snapping) {
      setSnapIndicatorT(null)
      return tS
    }
    // Exclude the whole link group of EVERY seed id: a linked A/V pair trims/
    // moves together, so the partner's stale edges must not magnetize the
    // gesture back onto itself. Roll/slide pass every clip whose edges ARE the
    // gesture's own origin (left+right of the cut; the slid clip + neighbours)
    // - otherwise the origin stays a snap magnet and fine adjustments no-op.
    const seeds = excludeClipId === undefined ? [] : Array.isArray(excludeClipId) ? excludeClipId : [excludeClipId]
    const points = snapPoints.points(seq, seeds, useStore.getState().ui.playheadS)
    const r = snapTime(tS, points, SNAP_PX / pxPerS)
    setSnapIndicatorT(r.snapped ? r.t : null)
    return r.t
  }

  const { zoomFit } = useTimelineZoom(lanesRef, measureViewportNow, seq.durationS)

  // --- pointer interactions -------------------------------------------------

  const beginDrag = (e: ReactPointerEvent, d: Drag) => {
    lanesRef.current?.setPointerCapture(e.pointerId)
    setDrag(d)
  }

  // --- edge auto-scroll during drags (useEdgeScroll) -----------------------
  const { lastDragPointer, maybeEdgeScroll, stopEdgeScroll } = useEdgeScroll(lanesRef, programmaticScroll)

  const handleClipPointerDown = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    // Any fresh press on a clip clears a stale right-drag suppression (e.g. a
    // right-drag that released over the track headers/monitor never got cleared),
    // so the next right-click always opens the menu.
    suppressContextRef.current = 0
    if (e.button !== 0) return
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (!track) return
    if (tool === 'hand') {
      beginHand(e)
      return
    }
    if (tool === 'razor') {
      if (track.locked) {
        show('That track is locked, so the razor cannot cut it')
        return
      }
      const t = quantizeToFrame(contentPoint(e).x / pxPerS, seq.fps)
      // splitClip refuses a cut within one frame of either edge, and a refused
      // split returns the sequence UNCHANGED, so dispatch drops it: no undo
      // entry, no redraw, no anything. On a cut-dense timeline, where clips are
      // routinely a few frames long, that reads as the razor having stopped
      // working. The refusal is right, the silence was not.
      const before = useStore.getState().project
      updateActiveSequence('Split clip', (sq) => splitGroup(sq, clip.id, t))
      if (useStore.getState().project === before) {
        show('Too close to the edge of the clip to cut there')
      }
      return
    }
    // Selection tool: select, then start a move (or Alt = slip) drag.
    // Read the A/V-link intent BEFORE the select below, exactly like the trim
    // path: grabbing always selects the clip, so asking afterwards would report
    // "solo" every time and quietly kill linked slipping.
    const soloSlip = soloTrimIntent(seq, selection, clip.id)
    // MOVE is solo by default; read before the select() below (see soloMoveIntent).
    const soloMove = soloMoveIntent(seq, selection, clip.id)
    if (e.shiftKey) {
      setUI({
        selection: selection.includes(clip.id)
          ? selection.filter((id) => id !== clip.id)
          : [...selection, clip.id],
      })
    } else if (!selection.includes(clip.id)) {
      setUI({ selection: [clip.id] })
    }
    if (track.locked) return
    const { x } = contentPoint(e)
    dragFinal.current = null
    dragMoved.current = false
    // Ctrl+Alt = the advanced-trim pair (roll on an edge, slide on the body).
    // Checked before plain Alt: a Ctrl+Alt press has altKey === true too.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const neighborIds = slideNeighborIds(track, clip.id)
      beginDrag(e, { kind: 'slide', clipId: clip.id, grabOffsetS: x / pxPerS - clip.startS, neighborIds })
      return
    }
    if (e.altKey) {
      beginDrag(e, { kind: 'slip', clipId: clip.id, startXPx: x, solo: soloSlip })
      return
    }
    // Multi-selection: the whole selection travels (see carriedOthers).
    const selNow = useStore.getState().ui.selection
    const others = carriedOthers(seq, selNow, clip.id)
    beginDrag(e, {
      kind: 'move',
      clipId: clip.id,
      grabOffsetS: x / pxPerS - clip.startS,
      trackKind: track.kind,
      downClientX: e.clientX,
      downClientY: e.clientY,
      others,
      collapseCandidate: !e.shiftKey && selNow.includes(clip.id) && selNow.length > 1,
      solo: soloMove,
    })
  }

  const handleClipContextMenu = (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => {
    // A right-drag box-select that happened to end over a clip must NOT open the
    // clip menu - swallow this one contextmenu (only if it's fresh). 0 is the
    // "nothing pending" sentinel and must never suppress: with no guard, every
    // right-click during the first 500ms after navigation (performance.now()
    // still < 500) would be swallowed.
    if (suppressContextRef.current > 0 && performance.now() - suppressContextRef.current < 500) {
      suppressContextRef.current = 0
      e.preventDefault()
      return
    }
    // Right-clicking a clip that's part of a multi-selection KEEPS the selection
    // (so "apply to all" acts on every selected clip); otherwise select just it.
    const keepSelection = selection.includes(clip.id) && selection.length > 1
    if (!keepSelection) setUI({ selection: [clip.id] })
    const selNow = keepSelection ? selection : [clip.id]
    const playheadS = useStore.getState().ui.playheadS
    openContextMenu(e, clipContextMenuItems({ clip, seq, assets, selNow, keepSelection, playheadS, show }))
  }

  const handleTrimPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: Clip,
    edge: 'in' | 'out',
  ) => {
    if (e.button !== 0 || tool !== 'select') return
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (!track || track.locked) return
    // Read the intent BEFORE the select below: grabbing the edge always selects
    // the clip, so asking afterwards would say "solo" every time and quietly
    // kill linked trimming. Having singled this half out ALREADY (clicked it,
    // partner not selected) is what means "trim just this one".
    const solo = soloTrimIntent(seq, selection, clip.id)
    setUI({ selection: [clip.id] })
    dragFinal.current = null
    dragMoved.current = false
    // Edge modifiers: Ctrl = ripple trim, Alt = rate stretch, Ctrl+Alt = roll.
    // Roll is checked FIRST - a Ctrl+Alt press satisfies both single checks.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const pair = rollPair(track, clip.id, edge)
      if (pair) {
        beginDrag(e, { kind: 'roll', ...pair })
        return
      }
      // No neighbour to roll against - fall through to a plain trim.
    }
    if (e.altKey && !(e.ctrlKey || e.metaKey)) {
      beginDrag(e, { kind: 'stretch', clipId: clip.id, edge })
      return
    }
    // `!e.altKey` keeps the no-neighbour Ctrl+Alt fallthrough a PLAIN trim, as
    // documented above - Ctrl alone still means ripple.
    beginDrag(e, {
      kind: 'trim',
      clipId: clip.id,
      edge,
      ripple: (e.ctrlKey || e.metaKey) && !e.altKey,
      solo,
    })
  }

  const beginHand = (e: ReactPointerEvent) => {
    const el = lanesRef.current
    if (!el) return
    beginDrag(e, {
      kind: 'hand',
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    })
  }

  const scrubPlayheadTo = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    setUI({ playheadS: frameAtOffset(clientX - rect.left, pxPerS, seq.fps) })
  }

  // Vegas-style: click empty space (a track lane, or the blank area below the
  // tracks) to move the playhead there; drag to scrub. Deselects clips.
  const beginEmptyScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'hand') beginHand(e)
    else if (tool === 'select') {
      // Shift OR Ctrl/Cmd + drag = rubber-band select; plain click/drag =
      // scrub (Vegas). Ctrl/Cmd is additive (matches desktop box-select), Shift
      // replaces - so either modifier lets you "click and drag to select
      // multiple", the way David expects it to work.
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const { x, y } = contentPoint(e)
        const additive = e.ctrlKey || e.metaKey
        setMarquee({ x0: x, y0: y, x1: x, y1: y })
        beginDrag(e, {
          kind: 'marquee',
          x0: x,
          y0: y,
          additive,
          base: additive ? [...useStore.getState().ui.selection] : [],
        })
        return
      }
      pausePlayback()
      setUI({ selection: [] })
      scrubPlayheadTo(e.clientX)
      beginDrag(e, { kind: 'scrub' })
    }
  }

  // Right-button drag on empty timeline = rubber-band box-select (any tool).
  // Reuses the exact marquee drag machinery; replace-mode (fresh box).
  const beginRightMarquee = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = contentPoint(e)
    rightMarqueeRef.current = true
    suppressContextRef.current = 0
    setMarquee({ x0: x, y0: y, x1: x, y1: y })
    beginDrag(e, { kind: 'marquee', x0: x, y0: y, additive: false, base: [] })
  }

  const handleLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.button === 2) {
      beginRightMarquee(e)
      return
    }
    if (e.button !== 0) return
    beginEmptyScrub(e)
  }

  // The scroll container's own background (the blank area beneath the last
  // track). Bubbled events from lanes/clips/ruler are ignored via the target
  // check, so only a click on the empty background scrubs.
  const handleLanesBackgroundPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return
    // Ignore clicks on the native scrollbars: they sit inside the element's box
    // but past its client area, so without this, dragging the horizontal scrollbar
    // scrubs the playhead to it.
    const el = e.currentTarget
    if (pointOnScrollbar(el.getBoundingClientRect(), el.clientWidth, el.clientHeight, e.clientX, e.clientY)) return
    if (e.target !== e.currentTarget && e.target !== contentRef.current) return
    if (e.button === 2) {
      beginRightMarquee(e)
      return
    }
    beginEmptyScrub(e)
  }

  const handleLanesPointerMove = (e: { clientX: number; clientY: number }) => {
    if (!drag) {
      // Razor hover: preview the exact cut line the blade will make.
      if (tool === 'razor') {
        const { x, y } = contentPoint(e)
        const lane = laneAt(y)
        setRazorHover(lane ? { t: quantizeToFrame(Math.max(0, x / pxPerS), seq.fps), top: y } : null)
      } else if (razorHover) {
        setRazorHover(null)
      }
      return
    }
    if (razorHover) setRazorHover(null)
    if (drag.kind === 'hand') {
      const el = lanesRef.current
      if (el) {
        el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
        el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
      }
      return
    }
    // Every non-hand drag edge-scrolls: park the pointer near a side and the
    // view travels, re-running this handler from the parked coordinates so the
    // clip/trim/scrub keeps following. Pro-NLE table stakes.
    lastDragPointer.current = { clientX: e.clientX, clientY: e.clientY }
    maybeEdgeScroll(handleLanesPointerMove)
    if (drag.kind === 'scrub') {
      scrubPlayheadTo(e.clientX)
      return
    }
    if (drag.kind === 'marquee') {
      // A right-drag that actually moved must swallow the contextmenu that fires
      // on button release, or the box-select would also pop a menu.
      if (rightMarqueeRef.current) suppressContextRef.current = performance.now()
      const p = contentPoint(e)
      setMarquee({ x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y })
      // Live-select every clip whose box overlaps the rectangle.
      const hits = marqueeHitIds(laneInfos, pxPerS, { x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y })
      // Additive (Ctrl/Cmd): fold the box onto the pre-drag selection, deduped.
      setUI({ selection: drag.additive ? [...new Set([...drag.base, ...hits])] : hits })
      return
    }
    const { x, y } = contentPoint(e)
    if (drag.kind === 'move') {
      const desiredRaw = quantizeToFrame(Math.max(0, x / pxPerS - drag.grabOffsetS), seq.fps)
      const current = seq.tracks.find((t) => t.clips.some((c) => c.id === drag.clipId))
      const clip = current?.clips.find((c) => c.id === drag.clipId)
      if (!current || !clip) return
      const durS = clipDurationS(clip)
      // Snap the leading edge, then the trailing edge; keep the closer catch.
      // The dragged clip's whole link group is excluded: its audio partner's
      // stale edges would otherwise snap the drag back to where it started.
      // ⛔ EVERY CLIP THAT IS MOVING IS EXCLUDED, not just the grabbed one.
      //
      // The grabbed clip's link group was already excluded, for exactly the
      // right reason: an audio partner travelling with the drag would otherwise
      // offer its OLD edges as snap targets and yank the drag back to where it
      // started. **The clips carried in `drag.others` travel too, and they were
      // still in the points.** So dragging a multi-selection fought the user:
      // every carried clip's original edges pulled the whole selection back
      // toward the spot it was trying to leave, and the harder the selection,
      // the stickier it felt.
      const points = snapping
        ? snapPoints.points(
            seq,
            [drag.clipId, ...drag.others.map((o) => o.id)],
            useStore.getState().ui.playheadS,
          )
        : []
      let desired = desiredRaw
      if (snapping) {
        const snapped = snapMoveStart(desiredRaw, durS, points, SNAP_PX / pxPerS)
        desired = snapped.desired
        setSnapIndicatorT(snapped.indicatorT)
      }
      const hovered = laneAt(y)
      const valid = !!hovered && hovered.kind === drag.trackKind && !hovered.locked
      const target = valid ? hovered! : current
      // Tint the lane you're over - green ok, red no (wrong kind / locked).
      setHoverLane(hovered && hovered.id !== current.id ? { trackId: hovered.id, valid } : null)
      const finalT = Math.max(0, desired)
      dragFinal.current = { trackId: target.id, tS: finalT }
      // ⛔ THE LATCH. Once a move has genuinely moved, it is a DRAG for the rest
      // of the gesture, and it stays one however the pointer ends up on release.
      // See the comment on `dragMoved` for what this was costing him.
      if (!dragMoved.current && Math.abs(finalT - clip.startS) > 1e-6) dragMoved.current = true
      if (!dragMoved.current && target.id !== current.id) dragMoved.current = true
      // Moves get the live readout too: new start timecode + signed delta.
      // Suppressed inside the click slop so a plain click never flashes it.
      if (dragMoved.current) setTrimTip({ x: e.clientX, y: e.clientY - 34, text: moveTipText(finalT, clip.startS, seq.fps) })
      setPreviewSeq(moveSelectionWith(seq, drag.clipId, target.id, finalT, drag.others, drag.solo))
    } else {
      // Slip, roll, slide, stretch and trim: the preview and its readout come
      // from timelineGestures.ts. Roll excludes BOTH sides of the cut and slide
      // its neighbours from the snap set: those edges ARE the gesture's origin,
      // and leaving them in magnetizes every fine adjustment back to a no-op.
      // Stretch still snaps: ending exactly on a marker or a neighbour's edge
      // is the whole point of the gesture half the time.
      let step: DragStep
      if (drag.kind === 'slip') {
        const deltaS = quantizeToFrame((x - drag.startXPx) / pxPerS, seq.fps)
        dragFinal.current = { trackId: '', tS: deltaS }
        step = slipStep(seq, assets, drag, deltaS)
      } else if (drag.kind === 'slide') {
        const tRaw = quantizeToFrame(Math.max(0, x / pxPerS - drag.grabOffsetS), seq.fps)
        const t = snapWithIndicator(tRaw, [drag.clipId, ...drag.neighborIds])
        dragFinal.current = { trackId: '', tS: t }
        step = slideStep(seq, assets, drag, t)
      } else {
        const tRaw = frameAtOffset(x, pxPerS, seq.fps)
        const t = snapWithIndicator(tRaw, drag.kind === 'roll' ? [drag.leftId, drag.rightId] : drag.clipId)
        dragFinal.current = { trackId: '', tS: t }
        step =
          drag.kind === 'roll'
            ? rollStep(seq, assets, drag, t)
            : drag.kind === 'stretch'
              ? stretchStep(seq, drag, t)
              : trimStep(seq, assets, drag, t)
      }
      setPreviewSeq(step.next)
      if (step.tip !== null) setTrimTip({ x: e.clientX, y: e.clientY - 34, text: step.tip })
    }
  }

  const handleLanesPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    stopEdgeScroll()
    lastDragPointer.current = null
    setHoverLane(null)
    // Let go of the playhead and the scrubbing stops with it, including any
    // grain still decoding.
    lanesRef.current?.releasePointerCapture(e.pointerId)
    // Marquee is selection-only (no undo dispatch) - just drop the rectangle.
    if (drag.kind === 'marquee') {
      rightMarqueeRef.current = false // keep suppressContextRef for the imminent contextmenu
      setMarquee(null)
      setDrag(null)
      return
    }
    // A release within the slop of the pointer-down is a CLICK on the clip, not
    // a drag: move the playhead there so the preview shows the spot you clicked
    // (CapCut-style), and skip the no-op move commit (keeps undo history clean).
    // ⚠️ THE LATCH, NOT THE POINTER. `dragMoved` is set the moment the clip's own
    // start or track actually changes, so a move the lanes scrolled out from
    // under his hand still commits. See its declaration for what that cost.
    // A gesture that never moved the clip is still a click, which is the half of
    // this that was always right.
    const isClipClick =
      drag.kind === 'move' &&
      !dragMoved.current &&
      Math.hypot(e.clientX - drag.downClientX, e.clientY - drag.downClientY) < CLICK_SLOP_PX
    if (isClipClick) {
      // Narrow a multi-selection to the clicked clip (drags keep the group).
      if (drag.kind === 'move' && drag.collapseCandidate) setUI({ selection: [drag.clipId] })
      scrubTo(drag.downClientX)
    } else if (dragFinal.current) {
      const commit = dragCommit(drag, dragFinal.current, seq, assets)
      if (commit) updateActiveSequence(commit.label, commit.apply)
    }
    setDrag(null)
    setPreviewSeq(null)
    setSnapIndicatorT(null)
    setTrimTip(null)
    dragFinal.current = null
  }

  /**
   * A finger the browser took back to scroll never meant an edit (2026-09-23,
   * the phone). On a phone a swipe that starts on a clip scrolls the timeline,
   * and the browser sends pointercancel once it decides so. The few moves before
   * that decision must not nudge the clip, so a cancelled touch is dropped, not
   * committed. A mouse keeps its old ending.
   */
  const handleLanesPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' || !drag) {
      handleLanesPointerUp(e)
      return
    }
    stopEdgeScroll()
    lastDragPointer.current = null
    rightMarqueeRef.current = false
    setHoverLane(null)
    setMarquee(null)
    setDrag(null)
    setPreviewSeq(null)
    setSnapIndicatorT(null)
    setTrimTip(null)
    dragFinal.current = null
  }

  // --- drop from the media bin (useTimelineDrop) ---------------------------
  const { dropPreview, setDropPreview, handleDragOver, handleDrop } = useTimelineDrop({
    seq,
    assets,
    pxPerS,
    snapping,
    contentPoint,
    laneAt,
    snapWithIndicator,
    setSnapIndicatorT,
    lastDragPointer,
    maybeEdgeScroll,
    stopEdgeScroll,
    onEdgeStep: (p: { clientX: number; clientY: number }) => handleLanesPointerMove(p),
  })

  // --- scroll behaviors -----------------------------------------------------
  useModifierMods(lanesRef)
  usePlayheadFollow(lanesRef, pxPerS, playing, manualScrollUntil, programmaticScroll)

  const scrubTo = (clientX: number) => {
    pausePlayback()
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    setUI({ playheadS: frameAtOffset(clientX - rect.left, pxPerS, seq.fps) })
  }

  // Dragging the playhead: one scrub per animation frame (useCoalescedScrub).
  const scrubDrag = useCoalescedScrub(scrubTo)

  const cursorClass = lanesCursorClass(tool, drag?.kind)

  // Stable identities for the ClipView handler props - without these, every
  // Timeline render (each pointermove during a drag) would hand every ClipView
  // fresh functions and defeat its memo().
  const stableClipPointerDown = useStableCallback(handleClipPointerDown)
  const stableTrimPointerDown = useStableCallback(handleTrimPointerDown)
  const stableClipContextMenu = useStableCallback(handleClipContextMenu)

  const isSilenced = silencedTest(seq.tracks)

  const renderLane = (track: Track, tint: string) => (
    <TimelineLane
      key={track.id}
      track={track}
      tint={tint}
      fps={seq.fps}
      assets={assets}
      pxPerS={pxPerS}
      selection={selection}
      tool={tool}
      seenClipIds={seenClipIds}
      winStartS={winStartS}
      winEndS={winEndS}
      hoverLane={hoverLane}
      dropPreview={dropPreview}
      silenced={isSilenced(track)}
      onLanePointerDown={handleLanePointerDown}
      onClipPointerDown={stableClipPointerDown}
      onTrimPointerDown={stableTrimPointerDown}
      onClipContextMenu={stableClipContextMenu}
      onFadePreview={setTrimTip}
    />
  )

  return (
    <section
      data-testid="timeline"
      aria-label="Timeline"
      className="flex shrink-0 flex-col bg-bg-panel"
      style={{ height }}
    >
      <TimelineToolbar onZoomFit={zoomFit} />
      <div className="flex min-h-0 flex-1">
        <TimelineTrackHeaders columnRef={headersRef} lanesRef={lanesRef} phone={phone} vTracks={vTracks} aTracks={aTracks} />

        <div
          ref={lanesRef}
          className={`relative min-w-0 flex-1 overflow-auto ${cursorClass}`}
          data-testid="timeline-lanes"
          data-tool={tool}
          onContextMenu={(e) => {
            // No browser menu on the timeline background; also clears the
            // right-drag-select suppression flag after it's served its purpose.
            e.preventDefault()
            suppressContextRef.current = 0
          }}
          onPointerDown={handleLanesBackgroundPointerDown}
          onPointerMove={handleLanesPointerMove}
          onPointerLeave={() => razorHover && setRazorHover(null)}
          onPointerUp={handleLanesPointerUp}
          onPointerCancel={handleLanesPointerCancel}
          // A finger pans the lanes and never pinch zooms the whole page. A
          // SELECTED clip turns panning off under itself (ClipView), so tap to
          // pick a clip, then drag it.
          style={{ touchAction: 'pan-x pan-y' }}
          onScroll={(e) => {
            // Track headers share vertical scroll with the lanes.
            if (headersRef.current) headersRef.current.scrollTop = e.currentTarget.scrollTop
            // A scroll we didn't trigger is the user's - suspend auto-follow so
            // playback doesn't yank the view back while they drag the scrollbar.
            if (programmaticScroll.current) programmaticScroll.current = false
            else manualScrollUntil.current = performance.now() + 2000
            // Virtualization window follows the scroll (rAF-throttled).
            scheduleViewportMeasure()
          }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={(e) => {
            if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
              setDropPreview(null)
              setSnapIndicatorT(null)
            }
          }}
        >
          <div ref={contentRef} className="relative" style={{ width: contentWidth }}>
            <TimelineRulerBar
              seq={seq}
              pxPerS={pxPerS}
              contentWidth={contentWidth}
              lengthS={lengthS}
              winStartS={winStartS}
              winEndS={winEndS}
              onScrubStart={scrubTo}
              onScrubDrag={scrubDrag}
            />

            {/* Alternating lane tints: with 3+ tracks a flat wash makes lane
                targeting during drags pure guesswork. Audio lanes carry a
                whisper of the audio-clip green so the zone reads instantly. */}
            {vTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-bg-input/30' : 'bg-bg-input/[0.12]'))}
            <div className="h-[2px] bg-border-strong" />
            {aTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-clip-audio/[0.08]' : 'bg-transparent'))}
            {/* Mirrors the headers' add-track row so both columns scroll to the
                same depth and those buttons stay reachable with many tracks. */}
            <div className="shrink-0" style={{ height: ADD_TRACK_ROW_H }} />

            {/* Keyed on the snapped time: a NEW edge re-fires the pulse. */}
            {snapIndicatorT !== null && <SnapLine key={snapIndicatorT} t={snapIndicatorT} pxPerS={pxPerS} />}

            {razorHover && tool === 'razor' && <RazorLine t={razorHover.t} pxPerS={pxPerS} />}

            {marquee && <MarqueeBox box={marquee} />}

            <RemotePlayheads pxPerS={pxPerS} />
            <PlayheadLine pxPerS={pxPerS} />
          </div>

          {!hasClips && <EmptyTimelineHint />}
        </div>
      </div>

      {trimTip && <TrimTip tip={trimTip} />}
    </section>
  )
}
