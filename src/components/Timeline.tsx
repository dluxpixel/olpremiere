import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { addClipFromAsset, addClipWithLinkedAudio, addTrack, clipDurationS, clipEndS, clipGroupIds, closeAllGaps, closeGapBefore, collectSnapPoints, gapBefore, moveSelectionWith, rateStretchGroup, rippleTrimGroup, rippleTrimTo, rollEditTo, slideClip, slipClip, slipGroup, snapTime, splitGroup, trimClipTo, trimGroup } from '../engine/timeline'
import { createSnapPointCache } from '../engine/snapPointCache'
import { TRANSITION_KINDS, TRANSITION_LABELS } from '../engine/render/types'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { transitionMarkSpans } from '../engine/transitionMarks'
import { workArea } from '../engine/workArea'
import { applyEffect, removeClipTransition, setClipTransition } from '../state/clipEdits'
import { ASSET_MIME, SFX_MIME } from '../state/dnd'
import { insertSfxAtPlayhead } from '../state/sfxActions'
import { comboLabel } from '../keymap'
import { activeSequence, audioTracks, videoTracks, type Clip, type Id, type Sequence, type Track } from '../engine/types'
import { pausePlayback } from '../state/playbackControl'
import { copySelection, cutSelection, duplicateSelection, pasteAtPlayhead } from '../state/clipboard'
import { copyClipAttributes, hasClipAttributes, pasteClipAttributes } from '../state/attributes'
import { balanceAllClipLoudness, normalizeClipGain } from '../state/audioActions'
import { allTextPresets, applyTextPresetToClips, saveAsCaptionStyle, useTextPresets } from '../state/textPresets'
import { crossfadeWithNeighbour, deleteSelected, setClipFade, splitAtPlayhead, topAndTail } from '../state/clipEdits'
import { cutPunchAtPlayhead, impactAtPlayhead, punchInAtPlayhead, punchOnBeats, punchOutAtPlayhead, rampWorkArea, whipToNext } from '../state/motionActions'
import { MOVES } from '../engine/moves'
import { applyMoveToSelection } from '../state/moveActions'
import { autoCaptionEveryClip, autoCaptionFromClip } from '../state/transcribeActions'
import { appearanceMenuItems, titleFontSizeItems } from '../state/clipMenus'
import { openContextMenu, type MenuItem } from '../state/contextMenu'
import { PlayheadLine, RemotePlayheads } from './PlayheadWidgets'
import { pointOnScrollbar } from './scrollbarGuard'
import { MAX_PX_PER_S, MIN_PX_PER_S, updateActiveSequence, useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { RULER_H, HEADERS_W, SNAP_PX, CLICK_SLOP_PX, fmtDelta, ADD_TRACK_ROW_H } from './timelineGeometry'
import { Ruler } from './TimelineRuler'
import { TrackHeader } from './TrackHeaderControls'
import { TimelineToolbar } from './TimelineToolbar'
import { ClipView } from './ClipView'
import { useStableCallback, type Drag } from './timelineDrag'
import { TrackPresetMenuButton } from './TrackPresetMenuButton'

// ---------------------------------------------------------------------------
// Timeline



export function Timeline({ height }: { height: number }) {
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

  /**
   * Had the user singled this clip out BEFORE grabbing its edge? Selecting ONE
   * half of a linked A/V pair and trimming it means "trim just this clip", so
   * shortening the audio no longer shortens the video. With nothing selected -
   * or the whole pair selected - the edge still trims the pair together, which
   * IS the point of the link. Must be read before the grab's own select().
   */
  const soloTrimIntent = (clipId: Id): boolean =>
    selection.length > 0 &&
    selection.includes(clipId) &&
    !clipGroupIds(seq, clipId).every((g) => selection.includes(g))

  /**
   * Trimming never touches linkId, so a solo-trimmed pair stays linked and keeps
   * moving together - only their lengths differ.
   */
  const trimFnFor = (solo: boolean, ripple: boolean) => {
    if (solo) return ripple ? rippleTrimTo : trimClipTo
    return ripple ? rippleTrimGroup : trimGroup
  }

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
  const [dropPreview, setDropPreview] = useState<{ trackId: Id; tS: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hoverLane, setHoverLane] = useState<{ trackId: Id; valid: boolean } | null>(null)
  const [razorHover, setRazorHover] = useState<{ t: number; top: number } | null>(null)
  const dragFinal = useRef<{ trackId: Id; tS: number } | null>(null)
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
  const area = workArea(seq)

  const lengthS = Math.max(120, seq.durationS + 60)
  const contentWidth = lengthS * pxPerS

  // --- Clip virtualization -------------------------------------------------
  // Only clips intersecting the visible time range (+ one full viewport of
  // margin each side, so ordinary scrolling never pops clips in at the edge)
  // are mounted. Until the first measure, everything renders (null viewport).
  const [viewport, setViewport] = useState<{ left: number; width: number } | null>(null)
  const scrollRafRef = useRef(0)
  const scheduleViewportMeasure = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = lanesRef.current
      if (el) setViewport({ left: el.scrollLeft, width: el.clientWidth })
    })
  }, [])
  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
    const ro = new ResizeObserver(scheduleViewportMeasure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
  }, [scheduleViewportMeasure])
  const winStartS = viewport ? (viewport.left - viewport.width) / pxPerS : -Infinity
  const winEndS = viewport ? (viewport.left + viewport.width * 2) / pxPerS : Infinity

  // Pop gating: ids seen on the previous commit. A clip id NOT in the set is
  // genuinely new (add / paste / undo-restore) and gets the one-shot pulse; a
  // virtualization remount is already in the set and stays quiet.
  const seenClipIdsRef = useRef<Set<string>>(new Set())
  const seenClipIds = seenClipIdsRef.current
  useEffect(() => {
    const ids = new Set<string>()
    for (const t of seq.tracks) for (const c of t.clips) ids.add(c.id)
    seenClipIdsRef.current = ids
  }, [seq])

  // Lane geometry in content space (below the ruler), for pointer hit tests.
  const laneInfos = useMemo(() => {
    const infos: { track: Track; top: number }[] = []
    let top = RULER_H
    for (const t of vTracks) {
      infos.push({ track: t, top })
      top += t.height
    }
    top += 2 // video/audio divider
    for (const t of aTracks) {
      infos.push({ track: t, top })
      top += t.height
    }
    return infos
  }, [vTracks, aTracks])

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const laneAt = (y: number): Track | null => {
    for (const { track, top } of laneInfos) {
      if (y >= top && y < top + track.height) return track
    }
    return null
  }

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

  // Zoom re-anchors scrollLeft in the SAME event as the pxPerS change, so the
  // virtualization window must be re-measured synchronously too - the async
  // scroll-event measure lands after paint, and one frame culled against the
  // stale scrollLeft blanks every visible clip.
  const measureViewportNow = () => {
    const el = lanesRef.current
    if (!el) return
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
  }

  const zoomAround = (clientX: number, factor: number) => {
    const el = lanesRef.current
    if (!el) return
    const old = useStore.getState().ui.pxPerS
    const next = Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, old * factor))
    if (next === old) return
    const rect = el.getBoundingClientRect()
    const tAt = (clientX - rect.left + el.scrollLeft) / old
    setUI({ pxPerS: next })
    el.scrollLeft = Math.max(0, tAt * next - (clientX - rect.left))
    measureViewportNow()
  }

  // Keyboard / toolbar / slider zoom: anchor on the playhead when it's in
  // view, else the viewport center - zooming must never slide the thing you
  // are looking at out of the window (raw setUI({pxPerS}) drifts toward t=0).
  const zoomTo = (nextRaw: number) => {
    const el = lanesRef.current
    if (!el) return
    const old = useStore.getState().ui.pxPerS
    const next = Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, nextRaw))
    if (next === old) return
    const playheadS = useStore.getState().ui.playheadS
    const viewStartS = el.scrollLeft / old
    const viewEndS = (el.scrollLeft + el.clientWidth) / old
    const anchorS =
      playheadS >= viewStartS && playheadS <= viewEndS ? playheadS : (viewStartS + viewEndS) / 2
    const anchorPx = anchorS * old - el.scrollLeft
    setUI({ pxPerS: next })
    el.scrollLeft = Math.max(0, anchorS * next - anchorPx)
    measureViewportNow()
  }

  // "=" / "-" in the central keymap (store.zoomIn/zoomOut dispatch this).
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent<{ factor?: number; pxPerS?: number }>).detail
      if (detail?.pxPerS !== undefined) zoomTo(detail.pxPerS)
      else zoomTo(useStore.getState().ui.pxPerS * (detail?.factor ?? 1))
    }
    window.addEventListener('olpremiere:zoom', onZoom)
    return () => window.removeEventListener('olpremiere:zoom', onZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- pointer interactions -------------------------------------------------

  const beginDrag = (e: ReactPointerEvent, d: Drag) => {
    lanesRef.current?.setPointerCapture(e.pointerId)
    setDrag(d)
  }

  // --- edge auto-scroll during drags ---------------------------------------
  // Speed ramps 4→20 px/frame with proximity to the container edge. The rAF
  // loop marks its scrollLeft writes as programmatic (playback-follow must not
  // suspend) and re-runs the drag math from the last pointer position.
  const lastDragPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const edgeScrollRaf = useRef<number | null>(null)
  const EDGE_ZONE_PX = 32

  const edgeSpeed = (el: HTMLElement, clientX: number): number => {
    const r = el.getBoundingClientRect()
    const leftGap = clientX - r.left
    const rightGap = r.right - clientX
    if (leftGap < EDGE_ZONE_PX) return -(4 + (16 * (EDGE_ZONE_PX - Math.max(0, leftGap))) / EDGE_ZONE_PX)
    if (rightGap < EDGE_ZONE_PX) return 4 + (16 * (EDGE_ZONE_PX - Math.max(0, rightGap))) / EDGE_ZONE_PX
    return 0
  }

  const stopEdgeScroll = () => {
    if (edgeScrollRaf.current !== null) cancelAnimationFrame(edgeScrollRaf.current)
    edgeScrollRaf.current = null
  }

  const maybeEdgeScroll = () => {
    const el = lanesRef.current
    const p = lastDragPointer.current
    if (!el || !p || edgeSpeed(el, p.clientX) === 0) {
      stopEdgeScroll()
      return
    }
    if (edgeScrollRaf.current !== null) return // loop already alive
    const step = () => {
      const el2 = lanesRef.current
      const p2 = lastDragPointer.current
      if (!el2 || !p2) {
        edgeScrollRaf.current = null
        return
      }
      const sp = edgeSpeed(el2, p2.clientX)
      if (sp === 0) {
        edgeScrollRaf.current = null
        return
      }
      const before = el2.scrollLeft
      programmaticScroll.current = true
      el2.scrollLeft = Math.max(0, before + sp)
      // At the rail ends nothing moved - don't spin the loop for free.
      if (el2.scrollLeft === before) {
        edgeScrollRaf.current = null
        return
      }
      handleLanesPointerMove(p2)
      edgeScrollRaf.current = requestAnimationFrame(step)
    }
    edgeScrollRaf.current = requestAnimationFrame(step)
  }

  // A dying component must never leave a scroll loop running.
  useEffect(() => stopEdgeScroll, [])


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
    const soloSlip = soloTrimIntent(clip.id)
    /**
     * MOVE is solo by default. His words, 2026-08-05, after a first attempt that
     * only went solo once he had selected the clip: "when I drag the video clip,
     * it automatically drags the audio clip. Can you make it so the audio and
     * video clips can be dragged separately?"
     *
     * Requiring a click before the drag was a fix that asked him to change how
     * he works, which is not a fix. Grabbing a clip and moving it in one motion
     * is the gesture, so that gesture has to mean "move this clip". Selecting
     * BOTH halves still moves them together, which is the deliberate way to say
     * "keep these in sync" and the only way it happens now.
     *
     * Read before the select() below, like soloSlip: after it, the grabbed clip
     * is always selected and the question answers itself.
     */
    const soloMove = !clipGroupIds(seq, clip.id).every((g) => selection.includes(g))
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
    // Ctrl+Alt = the advanced-trim pair (roll on an edge, slide on the body).
    // Checked before plain Alt: a Ctrl+Alt press has altKey === true too.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const idx = track.clips.findIndex((c) => c.id === clip.id)
      const neighborIds = [track.clips[idx - 1]?.id, track.clips[idx + 1]?.id].filter((id): id is Id => !!id)
      beginDrag(e, { kind: 'slide', clipId: clip.id, grabOffsetS: x / pxPerS - clip.startS, neighborIds })
      return
    }
    if (e.altKey) {
      beginDrag(e, { kind: 'slip', clipId: clip.id, startXPx: x, solo: soloSlip })
      return
    }
    // Multi-selection: carry every OTHER selected unlocked clip (deduped by
    // link group - moveGroup moves partners) so the whole selection travels.
    const selNow = useStore.getState().ui.selection
    const others: { id: Id; startS0: number }[] = []
    if (selNow.includes(clip.id) && selNow.length > 1) {
      const seen = new Set<Id>(clipGroupIds(seq, clip.id))
      for (const tr of seq.tracks) {
        if (tr.locked) continue
        for (const c of tr.clips) {
          if (!selNow.includes(c.id) || seen.has(c.id)) continue
          for (const gid of clipGroupIds(seq, c.id)) seen.add(gid)
          others.push({ id: c.id, startS0: c.startS })
        }
      }
    }
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
    const titleIdsSel = seq.tracks
      .flatMap((t) => t.clips)
      .filter((c) => selNow.includes(c.id) && c.title)
      .map((c) => c.id)
    const playheadS = useStore.getState().ui.playheadS
    const playheadInside = playheadS > clip.startS && playheadS < clipEndS(clip)
    // Audio clips adjacent to a same-track neighbour can be crossfaded.
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    const idx = track ? track.clips.findIndex((c) => c.id === clip.id) : -1
    const prev = track && idx > 0 ? track.clips[idx - 1] : undefined
    const next = track ? track.clips[idx + 1] : undefined
    const canXfadePrev = !!prev && Math.abs(clipEndS(prev) - clip.startS) < 1e-3
    const canXfadeNext = !!next && Math.abs(clipEndS(clip) - next.startS) < 1e-3
    const crossfadeItems =
      track?.kind === 'audio' && (canXfadePrev || canXfadeNext)
        ? [
            ...(canXfadePrev
              ? [{ label: 'Crossfade with previous', onClick: () => crossfadeWithNeighbour(clip.id, 'prev') }]
              : []),
            ...(canXfadeNext
              ? [{ label: 'Crossfade with next', separator: !canXfadePrev, onClick: () => crossfadeWithNeighbour(clip.id, 'next') }]
              : []),
          ]
        : []

    // Local Whisper captions + beat-driven punches, for audio clips with sound.
    const captionItems =
      track?.kind === 'audio' && assets[clip.assetId]?.hasAudio
        ? [
            { label: 'Level this clip', onClick: () => void normalizeClipGain(clip.id) },
            {
              label: 'Balance volume across all clips',
              onClick: () => void balanceAllClipLoudness(),
            },
            {
              // CAPTION WHAT IS SELECTED. His words, 2026-08-06: "add an option
              // to caption selected clips when I right-click and drag over some
              // clips. Make it so when I click 'Caption this clip', it just
              // captions all of them." One item, not two: the selection already
              // says how many he means, so the label just reports it back.
              // The many-clip path pools every word and lays them down in ONE
              // pass, so eight clips still make one caption track and one undo.
              label: keepSelection
                ? `Auto-Caption ${selNow.length} clips from voiceover`
                : 'Auto-Caption from voiceover',
              onClick: () =>
                keepSelection
                  ? void autoCaptionEveryClip(undefined, new Set(selNow))
                  : void autoCaptionFromClip(clip.id),
            },
            { label: 'Punch video on beats', onClick: () => void punchOnBeats(clip.id) },
          ]
        : []

    // Jettism Motion Pack, for video-track clips.
    const nextClip = next
    const nextTouches = !!nextClip && Math.abs(clipEndS(clip) - nextClip.startS) < 1e-3
    // Punch stays top-level (its P key is the workhorse); the rest fold into a
    // Motion submenu so the menu doesn't wall up. Speed-ramp flattens INTO it
    // (one-level submenu limit) as three leaves.
    const motionItems: MenuItem[] =
      track?.kind === 'video' && !clip.title
        ? [
            // The shelf, on the path he already right-clicks. Built from the
            // same table the tiles are, so the two can never drift apart.
            {
              label: selNow.length > 1 ? `Moves · all ${selNow.length}` : 'Moves',
              separator: true,
              submenu: MOVES.map((move) => ({
                label: move.name,
                shortcut: String(move.digit),
                onClick: () => applyMoveToSelection(move.id, selNow),
              })),
            },
            {
              label: 'Punch in at playhead',
              shortcut: 'P',
              disabled: !playheadInside,
              onClick: () => punchInAtPlayhead(clip.id),
            },
            {
              label: 'Motion',
              submenu: [
                // The other two thirds of the punch verb, on the path he
                // already right-clicks for Punch in. Punch out falls back to
                // the clip's base framing and holds; Cut punch splits here and
                // simply starts the right half bigger, with no animation at all.
                {
                  label: 'Punch out at playhead',
                  shortcut: 'Shift+P',
                  disabled: !playheadInside,
                  onClick: () => punchOutAtPlayhead(clip.id),
                },
                { label: 'Cut punch at playhead', disabled: !playheadInside, onClick: () => cutPunchAtPlayhead(clip.id) },
                { label: 'Impact hit at playhead', disabled: !playheadInside, onClick: () => impactAtPlayhead(clip.id) },
                { label: 'Whip to next clip', disabled: !nextTouches, onClick: () => whipToNext(clip.id) },
                ...[2, 3, 0.5].map((f, i) => ({
                  label: `Speed ramp ×${f}`,
                  separator: i === 0,
                  onClick: () => rampWorkArea(clip.id, f),
                })),
              ],
            },
          ]
        : []

    // Transitions had NO menu at all: audio got one-click "Crossfade with
    // previous", video got nothing but a drag from the Effects browser. Both
    // edges are offered on every video clip, because a lone edge now runs the
    // real transition rather than degrading to a fade to black.
    const transitionItems: MenuItem[] =
      track?.kind === 'video' && !clip.title
        ? (['in', 'out'] as const).map((edge) => {
            const current = edge === 'in' ? clip.transitionIn : clip.transitionOut
            const neighbour = edge === 'in' ? canXfadePrev : canXfadeNext
            return {
              label: edge === 'in' ? 'Transition in' : 'Transition out',
              separator: edge === 'in',
              submenu: [
                {
                  label: 'None',
                  checked: !current,
                  onClick: () => removeClipTransition(clip.id, edge),
                },
                ...TRANSITION_KINDS.map((kind, i) => ({
                  // A lone edge plays the transition against nothing, which is a
                  // real look, so we say so rather than hiding half the list.
                  label: neighbour ? TRANSITION_LABELS[kind] : `${TRANSITION_LABELS[kind]} (from nothing)`,
                  separator: i === 0,
                  checked: current?.type === kind,
                  onClick: () => setClipTransition(clip.id, edge, kind),
                })),
              ],
            }
          })
        : []

    // One-click green-screen removal on a media clip (video/image that HAS a screen).
    // Applies the chroma-key effect, which defaults to keying green at a clean
    // strength: drop-and-done, then fine-tune in the Inspector if edges remain.
    const greenScreenItems: MenuItem[] =
      track?.kind === 'video' && !clip.title && !clip.adjustment
        ? [{ label: 'Remove green screen', onClick: () => applyEffect(clip.id, 'chromaKey') }]
        : []

    // "How it appears" - font/size quick-picks + entrance/exit/speed animation,
    // TITLE clips only (video animates via transitions + the Motion submenu).
    // All compile to keyframes (preview == export). Shared with the
    // preview-monitor menu via state/clipMenus.
    // Both target the selected TITLES - so right-clicking one of several
    // selected captions applies to all, and video clips inside a mixed
    // selection are left alone.
    const titleMenuIds = titleIdsSel.length > 1 ? titleIdsSel : [clip.id]
    const appearanceItems = [
      ...titleFontSizeItems(clip, titleMenuIds),
      ...appearanceMenuItems(clip, titleMenuIds),
    ]

    // Whole STYLE presets: font, size, weight, colour, outline, POSITION, the
    // entrance/exit animation and the effect stack, saved together and reusable.
    //
    // This used to appear ONLY when several titles were selected, so right-clicking
    // the one caption he had just styled offered no way to save it. His ask,
    // 2026-07-28: "make it so when I right-click the text, I can save a preset that
    // I can then use on the auto captions." One title is the normal case, so it is
    // the case that has to work.
    const presetTargets = titleIdsSel.length > 1 ? titleIdsSel : clip.title ? [clip.id] : []
    const bulkTitleItems: MenuItem[] =
      presetTargets.length > 0
        ? [
            {
              label: presetTargets.length > 1 ? `Style preset (all ${presetTargets.length})` : 'Style preset',
              separator: true,
              submenu: [
                ...allTextPresets().map((p) => ({
                  label: p.name,
                  onClick: () => applyTextPresetToClips(presetTargets, p),
                })),
                {
                  label: 'Save as the caption style',
                  separator: true,
                  onClick: () => {
                    // Capture the clip you right-clicked (fallback: first selected title).
                    const src = clip.title ? clip.id : presetTargets[0]
                    const p = saveAsCaptionStyle(src, `Style ${useTextPresets.getState().saved.length + 1}`)
                    if (p) show(`Saved. Every new caption uses "${p.name}"`, 'success')
                  },
                },
              ],
            },
          ]
        : []

    openContextMenu(e, [
      { label: 'Copy', shortcut: comboLabel('mod+c'), onClick: () => copySelection() },
      { label: 'Cut', shortcut: comboLabel('mod+x'), onClick: cutSelection },
      { label: 'Duplicate', shortcut: comboLabel('mod+d'), onClick: duplicateSelection },
      { label: 'Paste', shortcut: comboLabel('mod+v'), onClick: pasteAtPlayhead },
      { label: 'Copy attributes', shortcut: comboLabel('mod+alt+c'), separator: true, onClick: () => copyClipAttributes(clip.id) },
      {
        label: keepSelection ? `Paste attributes to ${selNow.length}` : 'Paste attributes',
        shortcut: comboLabel('mod+alt+v'),
        disabled: !hasClipAttributes(),
        onClick: () => pasteClipAttributes(keepSelection ? selNow : [clip.id]),
      },
      ...crossfadeItems,
      ...transitionItems,
      ...captionItems,
      ...motionItems,
      ...greenScreenItems,
      ...appearanceItems,
      ...bulkTitleItems,
      {
        label: 'Trim head to playhead',
        shortcut: 'Q',
        separator: true,
        disabled: !playheadInside,
        onClick: () => topAndTail('in'),
      },
      {
        label: 'Trim tail to playhead',
        shortcut: 'W',
        disabled: !playheadInside,
        onClick: () => topAndTail('out'),
      },
      {
        // C is the branded single-key cut; the old label advertised only the
        // secondary Ctrl+K chord and hid the key everyone should learn.
        label: keepSelection ? `Split ${selNow.length} clips at playhead` : 'Split at playhead',
        shortcut: 'C',
        disabled: !playheadInside,
        // The SAME verb the C key runs. This used to split only the clip you
        // right-clicked while the Delete item one row below said "Delete 5 clips".
        onClick: () => splitAtPlayhead(),
      },
      {
        // THE LABEL NAMES WHAT GOES. Delete is selection-scoped: either half of
        // a linked pair goes alone (see deleteScoped). It used to say plain
        // "Delete" on a video clip and then take the audio with it, which is
        // exactly the surprise he hit on 2026-08-06. If a clip has a partner,
        // the item says which half this will remove.
        label: keepSelection
          ? `Delete ${selNow.length} clips`
          : clip.linkId !== undefined
            ? track?.kind === 'audio'
              ? 'Delete audio'
              : 'Delete video'
            : 'Delete',
        shortcut: 'Del',
        separator: true,
        // The SAME verb the Del key runs, lock filter included. The inline copy
        // here skipped it, so right-click Delete removed clips Del refused to.
        onClick: () => deleteSelected(false),
      },
      {
        label: keepSelection ? `Ripple delete ${selNow.length} clips` : 'Ripple delete',
        shortcut: 'Shift+Del',
        danger: true,
        onClick: () => deleteSelected(true),
      },
      {
        label: 'Close gap before',
        separator: true,
        disabled: gapBefore(seq, clip.id) <= 1e-4,
        onClick: () => updateActiveSequence('Close gap', (sq) => closeGapBefore(sq, clip.id)),
      },
      ...(track
        ? [
            {
              label: 'Close all gaps on track',
              onClick: () => updateActiveSequence('Close gaps', (sq) => closeAllGaps(sq, track.id)),
            },
          ]
        : []),
    ])
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
    const solo = soloTrimIntent(clip.id)
    setUI({ selection: [clip.id] })
    dragFinal.current = null
    // Edge modifiers: Ctrl = ripple trim, Alt = rate stretch, Ctrl+Alt = roll.
    // Roll is checked FIRST - a Ctrl+Alt press satisfies both single checks.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const idx = track.clips.findIndex((c) => c.id === clip.id)
      const neighbor = edge === 'out' ? track.clips[idx + 1] : track.clips[idx - 1]
      if (neighbor) {
        beginDrag(e, {
          kind: 'roll',
          leftId: edge === 'out' ? clip.id : neighbor.id,
          rightId: edge === 'out' ? neighbor.id : clip.id,
        })
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
    const t = Math.max(0, (clientX - rect.left) / pxPerS)
    const at = quantizeToFrame(t, seq.fps)
    setUI({ playheadS: at })
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
    maybeEdgeScroll()
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
      const loX = Math.min(drag.x0, p.x)
      const hiX = Math.max(drag.x0, p.x)
      const loY = Math.min(drag.y0, p.y)
      const hiY = Math.max(drag.y0, p.y)
      const hits: Id[] = []
      for (const { track, top } of laneInfos) {
        if (top + track.height < loY || top > hiY) continue
        for (const c of track.clips) {
          const cx0 = c.startS * pxPerS
          const cx1 = clipEndS(c) * pxPerS
          if (cx1 >= loX && cx0 <= hiX) hits.push(c.id)
        }
      }
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
      const points = snapping
        ? snapPoints.points(seq, [drag.clipId], useStore.getState().ui.playheadS)
        : []
      let desired = desiredRaw
      if (snapping) {
        const threshold = SNAP_PX / pxPerS
        const s1 = snapTime(desiredRaw, points, threshold)
        const s2 = snapTime(desiredRaw + durS, points, threshold)
        if (s1.snapped && (!s2.snapped || Math.abs(s1.t - desiredRaw) <= Math.abs(s2.t - durS - desiredRaw))) {
          desired = s1.t
          setSnapIndicatorT(s1.t)
        } else if (s2.snapped) {
          desired = s2.t - durS
          setSnapIndicatorT(s2.t)
        } else {
          setSnapIndicatorT(null)
        }
      }
      const hovered = laneAt(y)
      const valid = !!hovered && hovered.kind === drag.trackKind && !hovered.locked
      const target = valid ? hovered! : current
      // Tint the lane you're over - green ok, red no (wrong kind / locked).
      setHoverLane(hovered && hovered.id !== current.id ? { trackId: hovered.id, valid } : null)
      const finalT = Math.max(0, desired)
      dragFinal.current = { trackId: target.id, tS: finalT }
      // Moves get the live readout too: new start timecode + signed delta.
      // Suppressed inside the click slop so a plain click never flashes it.
      if (Math.hypot(e.clientX - drag.downClientX, e.clientY - drag.downClientY) >= CLICK_SLOP_PX) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Move  ${formatTimecode(finalT, seq.fps)}  ${fmtDelta(finalT - clip.startS, seq.fps)}`,
        })
      }
      setPreviewSeq(moveSelectionWith(seq, drag.clipId, target.id, finalT, drag.others, drag.solo))
    } else if (drag.kind === 'slip') {
      const deltaS = quantizeToFrame((x - drag.startXPx) / pxPerS, seq.fps)
      dragFinal.current = { trackId: '', tS: deltaS }
      const next = (drag.solo ? slipClip : slipGroup)(seq, assets, drag.clipId, deltaS)
      setPreviewSeq(next)
      const slipped = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const slipOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (slipped && slipOrig) {
        // Delta = the APPLIED source offset (slipClip clamps at the media ends),
        // so the readout never claims more slip than actually happened.
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Slip  in ${formatTimecode(slipped.inS, seq.fps)} · out ${formatTimecode(slipped.outS, seq.fps)}  ${fmtDelta(slipped.inS - slipOrig.inS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'roll') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      // Exclude BOTH sides of the cut: the left clip's out edge IS the origin
      // cut - leaving it in the snap set magnetizes every fine roll back to a
      // no-op.
      const t = snapWithIndicator(tRaw, [drag.leftId, drag.rightId])
      dragFinal.current = { trackId: '', tS: t }
      const next = rollEditTo(seq, assets, drag.leftId, drag.rightId, t)
      setPreviewSeq(next)
      const right = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.rightId)
      const rightOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.rightId)
      if (right && rightOrig) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Roll  ${formatTimecode(right.startS, seq.fps)}  ${fmtDelta(right.startS - rightOrig.startS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'slide') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS - drag.grabOffsetS), seq.fps)
      // Neighbours' facing edges ARE the slid clip's origin (slide requires
      // adjacency) - exclude them or the origin stays a snap magnet.
      const t = snapWithIndicator(tRaw, [drag.clipId, ...drag.neighborIds])
      dragFinal.current = { trackId: '', tS: t }
      const next = slideClip(seq, assets, drag.clipId, t)
      setPreviewSeq(next)
      const slid = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const slidOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (slid && slidOrig) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Slide  ${formatTimecode(slid.startS, seq.fps)}  ${fmtDelta(slid.startS - slidOrig.startS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'stretch') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      // Snapping still applies: stretching a clip to end exactly on a marker or
      // a neighbour's edge is the whole point of the gesture half the time.
      const t = snapWithIndicator(tRaw, drag.clipId)
      dragFinal.current = { trackId: '', tS: t }
      const next = rateStretchGroup(seq, drag.clipId, drag.edge, t)
      setPreviewSeq(next)
      const stretched = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (stretched) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Speed ${Math.round(Math.abs(stretched.speed) * 100)}%  ·  ${formatTimecode(clipDurationS(stretched), seq.fps)}`,
        })
      }
    } else {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      const t = snapWithIndicator(tRaw, drag.clipId)
      dragFinal.current = { trackId: '', tS: t }
      const next = trimFnFor(drag.solo, drag.ripple)(seq, assets, drag.clipId, drag.edge, t)
      setPreviewSeq(next)
      const trimmed = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const orig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (trimmed && orig) {
        const edgeT = drag.edge === 'in' ? trimmed.startS : clipEndS(trimmed)
        const origT = drag.edge === 'in' ? orig.startS : clipEndS(orig)
        // Ripple-in keeps startS fixed; show the source-window edge instead.
        const shownT = drag.ripple && drag.edge === 'in' ? trimmed.inS : edgeT
        const delta = drag.ripple && drag.edge === 'in' ? trimmed.inS - orig.inS : edgeT - origT
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `${drag.ripple ? 'Ripple  ' : ''}${formatTimecode(shownT, seq.fps)}  ${fmtDelta(delta, seq.fps)}`,
        })
      }
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
    const isClipClick =
      drag.kind === 'move' &&
      Math.hypot(e.clientX - drag.downClientX, e.clientY - drag.downClientY) < CLICK_SLOP_PX
    if (isClipClick) {
      // Narrow a multi-selection to the clicked clip (drags keep the group).
      if (drag.kind === 'move' && drag.collapseCandidate) setUI({ selection: [drag.clipId] })
      scrubTo(drag.downClientX)
    } else if (drag.kind === 'move' && dragFinal.current) {
      const { trackId, tS } = dragFinal.current
      updateActiveSequence(drag.others.length > 0 ? 'Move clips' : 'Move clip', (sq) =>
        moveSelectionWith(sq, drag.clipId, trackId, tS, drag.others, drag.solo),
      )
    } else if (drag.kind === 'trim' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence(drag.ripple ? 'Ripple trim' : 'Trim clip', (sq) =>
        trimFnFor(drag.solo, drag.ripple)(sq, assets, drag.clipId, drag.edge, tS),
      )
    } else if (drag.kind === 'stretch' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Rate stretch', (sq) => rateStretchGroup(sq, drag.clipId, drag.edge, tS))
    } else if (drag.kind === 'slip' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Slip clip', (sq) => (drag.solo ? slipClip : slipGroup)(sq, assets, drag.clipId, tS))
    } else if (drag.kind === 'roll' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Roll edit', (sq) => rollEditTo(sq, assets, drag.leftId, drag.rightId, tS))
    } else if (drag.kind === 'slide' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Slide clip', (sq) => slideClip(sq, assets, drag.clipId, tS))
    }
    setDrag(null)
    setPreviewSeq(null)
    setSnapIndicatorT(null)
    setTrimTip(null)
    dragFinal.current = null
  }

  // --- drop from the media bin ----------------------------------------------

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    const isAsset = e.dataTransfer.types.includes(ASSET_MIME)
    const isSfx = e.dataTransfer.types.includes(SFX_MIME)
    if (!isAsset && !isSfx) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // Bin drags edge-scroll too (the loop only scrolls here - the preview line
    // is content-anchored, and dragover re-fires on the next mouse move).
    lastDragPointer.current = { clientX: e.clientX, clientY: e.clientY }
    maybeEdgeScroll()
    const { x, y } = contentPoint(e)
    const lane = laneAt(y)
    if (!lane || (isSfx && lane.kind !== 'audio')) {
      setDropPreview(null)
      return
    }
    const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
    const t = snapWithIndicator(tRaw)
    setDropPreview({ trackId: lane.id, tS: t })
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    const sfxId = e.dataTransfer.getData(SFX_MIME)
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    stopEdgeScroll()
    lastDragPointer.current = null
    setDropPreview(null)
    setSnapIndicatorT(null)
    // A dragged SFX lands on the hovered audio lane at the drop time.
    if (sfxId) {
      e.preventDefault()
      const { x, y } = contentPoint(e)
      const lane = laneAt(y)
      const target = lane?.kind === 'audio' && !lane.locked ? lane : audioTracks(seq).find((t) => !t.locked)
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      const points = snapping ? collectSnapPoints(seq, { playheadS: useStore.getState().ui.playheadS }) : []
      const t = snapping ? snapTime(tRaw, points, SNAP_PX / pxPerS).t : tRaw
      void insertSfxAtPlayhead(sfxId, { atS: t, ...(target ? { trackId: target.id } : {}) })
      return
    }
    if (!assetId) return
    e.preventDefault()
    const asset = assets[assetId]
    if (!asset) return
    const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
    const { x, y } = contentPoint(e)
    const hovered = laneAt(y)
    const target =
      hovered && hovered.kind === wantKind && !hovered.locked
        ? hovered
        : seq.tracks.find((t) => t.kind === wantKind && !t.locked)
    if (!target) {
      show(`No unlocked ${wantKind} track for ${asset.name}`, 'danger')
      return
    }
    const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
    const points = snapping
      ? collectSnapPoints(seq, { playheadS: useStore.getState().ui.playheadS })
      : []
    const t = snapping ? snapTime(tRaw, points, SNAP_PX / pxPerS).t : tRaw
    // Dropping a video with audio splits its sound to a linked audio clip on A1.
    if (asset.kind === 'video' && asset.hasAudio) {
      const audioTrack = audioTracks(seq).find((tr) => !tr.locked) ?? null
      // Overwrite: lay it where he dropped it and clear what was under it, the
      // way every real NLE does. Without this the drop hunted for the nearest
      // gap that FITS, and on a packed timeline the only one is the open end,
      // so the clip silently landed after everything instead of where he aimed.
      updateActiveSequence(`Add ${asset.name}`, (sq) =>
        addClipWithLinkedAudio(sq, target.id, audioTrack?.id ?? null, asset, t, { overwrite: true }).seq,
      )
      return
    }
    updateActiveSequence(`Add ${asset.name}`, (sq) =>
      addClipFromAsset(sq, target.id, asset, t, { overwrite: true }).seq,
    )
  }

  // --- scroll/zoom behaviors --------------------------------------------------

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomAround(e.clientX, e.deltaY < 0 ? 1.2 : 1 / 1.2)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Modifier-hover cursor language: holding Alt arms slip (clip body) and rate
  // stretch (edge), Ctrl+Alt arms slide (body) and roll (edge), and Alt flips
  // the zoom tool to zoom-out. Written straight to the container's dataset so
  // a held key never touches React state; index.css keys on
  // [data-tool][data-mods] to re-cursor the targets.
  useEffect(() => {
    const write = (ctrl: boolean, alt: boolean) => {
      const el = lanesRef.current
      if (!el) return
      const mods = ctrl && alt ? 'ctrl-alt' : alt ? 'alt' : ctrl ? 'ctrl' : ''
      if (mods) el.dataset.mods = mods
      else delete el.dataset.mods
    }
    const onKey = (e: KeyboardEvent) => write(e.ctrlKey || e.metaKey, e.altKey)
    // Alt+Tab and friends can steal the keyup: clear on window blur too.
    const clear = () => write(false, false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Keep the playhead visible while playing (page-scroll like Premiere), but
  // never fight a manual scroll: suspend auto-follow for a moment after the
  // user scrolls the lanes themselves.
  // Auto-follow rides an IMPERATIVE playhead subscription (not a React effect
  // keyed on playheadS - that re-ran per transport tick). pxPerS via ref so
  // zoom changes mid-play take effect without resubscribing.
  const pxPerSRef = useRef(pxPerS)
  pxPerSRef.current = pxPerS
  useEffect(() => {
    if (!playing) return
    return useStore.subscribe(
      (s) => s.ui.playheadS,
      (t) => {
        const el = lanesRef.current
        if (!el) return
        if (performance.now() < manualScrollUntil.current) return
        const px = t * pxPerSRef.current
        const left = el.scrollLeft
        const right = left + el.clientWidth
        // Page forward when the playhead runs off the right edge; re-centre only
        // when it is fully off-screen (e.g. after Home). Do NOT tug back when the
        // user has scrolled ahead of the playhead.
        if (px > right - 40 || px < left - el.clientWidth) {
          programmaticScroll.current = true
          el.scrollLeft = Math.max(0, px - 80)
        }
      },
    )
  }, [playing])

  const zoomFit = () => {
    const el = lanesRef.current
    if (!el || seq.durationS <= 0) return
    const next = Math.min(
      MAX_PX_PER_S,
      Math.max(MIN_PX_PER_S, (el.clientWidth - 40) / seq.durationS),
    )
    setUI({ pxPerS: next })
    el.scrollLeft = 0
    measureViewportNow()
  }

  // "\" in the central keymap.
  useEffect(() => {
    window.addEventListener('olpremiere:zoom-fit', zoomFit)
    return () => window.removeEventListener('olpremiere:zoom-fit', zoomFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq.durationS])

  const scrubTo = (clientX: number) => {
    pausePlayback()
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = Math.max(0, (clientX - rect.left) / pxPerS)
    const at = quantizeToFrame(t, seq.fps)
    setUI({ playheadS: at })
  }

  // The pointer always says what a press would do: a razor blade for the
  // blade tool, grab that closes to grabbing while a hand-pan is live, zoom
  // magnifier (flipped to zoom-out by Alt via CSS on data-mods). Children
  // inherit, so the whole lane area speaks the tool. Modifier-hover cursors
  // for slip/stretch (Alt) and slide/roll (Ctrl+Alt) key off data-mods below.
  const cursorClass =
    tool === 'razor'
      ? 'cursor-razor'
      : tool === 'hand'
        ? drag?.kind === 'hand'
          ? 'cursor-grabbing'
          : 'cursor-grab'
        : ''

  // Stable identities for the ClipView handler props - without these, every
  // Timeline render (each pointermove during a drag) would hand every ClipView
  // fresh functions and defeat its memo().
  const stableClipPointerDown = useStableCallback(handleClipPointerDown)
  const stableTrimPointerDown = useStableCallback(handleTrimPointerDown)
  const stableClipContextMenu = useStableCallback(handleClipContextMenu)

  const renderLane = (track: Track, tint: string) => {
    // Drop-target feedback during a cross-track move: green valid, red no-go.
    const hov = hoverLane?.trackId === track.id ? hoverLane : null
    const hovClass = hov
      ? hov.valid
        ? 'ring-1 ring-inset ring-accent/50 bg-accent/10'
        : 'ring-1 ring-inset ring-danger/50 bg-danger/10'
      : ''
    return (
    <div
      key={track.id}
      className={`relative border-b border-border ${tint} ${hovClass} ${track.locked ? 'opacity-60' : ''}`}
      style={{ height: track.height }}
      onPointerDown={handleLanePointerDown}
    >
      {track.clips.map((clip, i) => {
        if (clipEndS(clip) < winStartS || clip.startS > winEndS) return null
        // A transition belongs to the CUT, not to one clip, so its geometry
        // needs both neighbours. Resolved here and handed down as plain
        // numbers so ClipView's memo() keeps comparing by value.
        const marks = transitionMarkSpans(
          clip,
          track.clips[i - 1] as Clip | undefined,
          track.clips[i + 1] as Clip | undefined,
          seq.fps,
        )
        return (
          <ClipView
            key={clip.id}
            clip={clip}
            asset={assets[clip.assetId]}
            trackKind={track.kind}
            trackHeight={track.height}
            pxPerS={pxPerS}
            selected={selection.includes(clip.id)}
            locked={track.locked}
            interactive={tool === 'select' && !track.locked}
            pop={!seenClipIds.has(clip.id)}
            transitionHeadS={marks.headS}
            transitionTailS={marks.tailS}
            onClipPointerDown={stableClipPointerDown}
            onTrimPointerDown={stableTrimPointerDown}
            onClipContextMenu={stableClipContextMenu}
            onFadeCommit={setClipFade}
            onFadePreview={setTrimTip}
          />
        )
      })}
      {dropPreview?.trackId === track.id && (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] bg-accent"
          style={{ left: dropPreview.tS * pxPerS }}
        />
      )}
    </div>
    )
  }

  return (
    <section
      data-testid="timeline"
      aria-label="Timeline"
      className="flex shrink-0 flex-col bg-bg-panel"
      style={{ height }}
    >
      <TimelineToolbar onZoomFit={zoomFit} />
      <div className="flex min-h-0 flex-1">
        <div
          ref={headersRef}
          data-testid="track-headers"
          className="flex shrink-0 flex-col overflow-hidden border-r border-border"
          style={{ width: HEADERS_W }}
          // The headers column is overflow-hidden (no scrollbar of its own) and is
          // kept in sync by the lanes' onScroll. But a wheel over the headers must
          // still scroll: forward it to the lanes, which mirrors back here. Without
          // this, scrolling only works with the cursor over the lanes - "can't
          // scroll on the left" once there are more tracks than fit.
          onWheel={(e) => {
            if (lanesRef.current) lanesRef.current.scrollTop += e.deltaY
          }}
        >
          <div className="shrink-0 border-b border-border" style={{ height: RULER_H }} />
          {vTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
          <div className="h-[2px] shrink-0 bg-border-strong" />
          {aTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
          {/* Blank space below the tracks: buttons to add a video or audio track.
              Fixed height, mirrored by a spacer in the lanes so the shared scroll
              can always bring these into view (see ADD_TRACK_ROW_H). */}
          <div
            className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2"
            style={{ height: ADD_TRACK_ROW_H }}
          >
            <button
              type="button"
              data-testid="add-video-track"
              className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
              onClick={() => updateActiveSequence('Add video track', (sq) => addTrack(sq, 'video'))}
              title="Add a video track"
            >
              <Plus size={12} strokeWidth={1.75} />
              Video
            </button>
            <button
              type="button"
              data-testid="add-audio-track"
              className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
              onClick={() => updateActiveSequence('Add audio track', (sq) => addTrack(sq, 'audio'))}
              title="Add an audio track"
            >
              <Plus size={12} strokeWidth={1.75} />
              Audio
            </button>
            <TrackPresetMenuButton />
          </div>
        </div>

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
          onPointerCancel={handleLanesPointerUp}
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
            <div
              className="sticky top-0 z-20 cursor-ew-resize"
              data-testid="ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                scrubTo(e.clientX)
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX)
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

            {/* Alternating lane tints: with 3+ tracks a flat wash makes lane
                targeting during drags pure guesswork. Audio lanes carry a
                whisper of the audio-clip green so the zone reads instantly. */}
            {vTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-bg-input/30' : 'bg-bg-input/[0.12]'))}
            <div className="h-[2px] bg-border-strong" />
            {aTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-clip-audio/[0.08]' : 'bg-transparent'))}
            {/* Mirrors the headers' add-track row so both columns scroll to the
                same depth and those buttons stay reachable with many tracks. */}
            <div className="shrink-0" style={{ height: ADD_TRACK_ROW_H }} />

            {/* Snap lock line: keyed on the snapped time so landing on a NEW
                edge remounts it and re-fires the one-shot pulse. Reduced
                motion collapses the pulse; the line itself always shows. */}
            {snapIndicatorT !== null && (
              <div
                key={snapIndicatorT}
                data-testid="snap-line"
                className="pointer-events-none absolute bottom-0 z-30 w-px animate-[snap-pulse_240ms_ease-out] bg-accent"
                style={{ left: snapIndicatorT * pxPerS, top: RULER_H }}
              />
            )}

            {razorHover && tool === 'razor' && (
              <div
                data-testid="razor-line"
                className="pointer-events-none absolute bottom-0 z-30 w-px bg-text-primary/70"
                style={{ left: razorHover.t * pxPerS, top: RULER_H }}
              />
            )}

            {marquee && (
              <div
                className="pointer-events-none absolute z-30 rounded-[2px] border border-accent bg-accent/10"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}

            <RemotePlayheads pxPerS={pxPerS} />
            <PlayheadLine pxPerS={pxPerS} />
          </div>

          {!hasClips && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center"
              style={{ top: RULER_H }}
            >
              <span className="text-[12px] text-text-muted">Drag a clip here to start</span>
            </div>
          )}
        </div>
      </div>

      {trimTip && (
        <div
          className="pointer-events-none fixed z-[90] rounded-[4px] border border-border bg-bg-elevated px-2 py-1 font-numeric text-[11px] text-text-primary shadow-pop"
          style={{ left: trimTip.x, top: trimTip.y }}
        >
          {trimTip.text}
        </div>
      )}
    </section>
  )
}
