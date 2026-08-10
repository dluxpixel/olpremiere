import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { clipEndS } from '../engine/timeline'
import { computeQuad, pointInQuad, subQuad } from '../engine/render/mat'
import { resolveFrame } from '../engine/render/resolve'
import { titleInkBoxUV } from '../engine/render/titleRaster'
import type { RenderLayer, ResolvedTransform } from '../engine/render/types'
import { activeSequence, type Clip } from '../engine/types'
import { MOMENT_EPS, clipKeyframeTimes } from '../engine/keyframes'
import { setLivePreviewTransform } from '../engine/preview'
import { previewClipMenu } from '../state/clipMenus'
import { punchInAtPoint } from '../state/motionActions'
import { channelKeyframes, resolveChannel } from '../engine/effects/channels'
import {
  isClipArmed,
  setClipTransform,
  setClipTransformAtPlayhead,
  toggleMotionAtPlayhead,
} from '../state/clipEdits'
import { setClipsPosition } from '../state/bulkEdits'
import { openContextMenu } from '../state/contextMenu'
import { pausePlayback } from '../state/playbackControl'
import { quantizeToFrame } from '../engine/timecode'
import { useStore, type ZoomAnchor } from '../state/store'

interface Tf {
  x: number
  y: number
  scale: number
  rotationDeg: number
}
type Drag =
  | { mode: 'move'; startX: number; startY: number; startTf: Tf }
  // axis: edge handles scale along the edge's outward normal (travel along the
  // edge is ignored); corners omit it and use radial distance from center.
  | { mode: 'scale'; startTf: Tf; cx: number; cy: number; startDist: number; axis?: { x: number; y: number } }
  | { mode: 'rotate'; startTf: Tf; cx: number; cy: number; startAngle: number }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const ACCENT = 'var(--color-accent)'
/** Barely-there lavender wash for the gizmo body, derived from the token. */
const ACCENT_WASH = 'color-mix(in srgb, var(--color-accent) 6%, transparent)'
/** Dark ink border keeps the light lavender handles legible on any footage. */
const HANDLE_INK = 'var(--color-accent-fg)'
/** Pointer travel before a monitor click becomes a scrub jog. */
const SCRUB_SLOP_PX = 4

/**
 * What the diamond badge in the gizmo's corner is showing, and therefore what
 * one click on it does:
 *
 * - `off`: hollow, the clip is not animated. A click arms it by keyframing the
 *   framing it has now.
 * - `between`: hollow, animated with the playhead between moments. A click adds
 *   a hold here.
 * - `on`: filled, the playhead is ON a moment. A click takes that moment out.
 * - `owned`: an appearance preset owns this clip's keyframes, so the badge is
 *   dead and says why.
 */
export type MotionBadgeState = 'off' | 'between' | 'on' | 'owned'

/** Plain reasons, one per state; the tooltip and the accessible name both read it. */
export const BADGE_TITLE: Readonly<Record<MotionBadgeState, string>> = {
  off: 'Animate this clip: keyframe the framing here',
  between: 'Keyframe the framing here',
  on: 'Remove the keyframe here',
  owned: 'This clip uses an entrance animation, which owns its keyframes.',
}

/**
 * A MOMENT is read with clipKeyframeTimes and one frame of tolerance, which is
 * exactly the read toggleMotionAtPlayhead makes, so the badge can never promise
 * something the click then does not do.
 *
 * An appearance animation is REFUSED rather than merged: clip.appearance is
 * recompiled on any transform edit (releaseAppearanceOnRetime in appearance.ts),
 * so a curve shaped by hand on such a clip would silently vanish at the next
 * recompile. Losing his work quietly is worse than a disabled badge.
 */
export function motionBadgeState(clip: Clip, localT: number, fps: number): MotionBadgeState {
  if (clip.appearance) return 'owned'
  const tol = 1 / (fps || 30)
  if (clipKeyframeTimes(clip).some((t) => Math.abs(t - localT) <= tol)) return 'on'
  return isClipArmed(clip) ? 'between' : 'off'
}

/**
 * The moment an armed drag animates FROM: the last one strictly before the
 * playhead, or the head of the clip when it carries none. The same read
 * withChannelsAtTime makes when it pins the outgoing keyframe, so the ghost quad
 * shows the framing the commit will really leave from and not an invented one.
 */
export function previousMomentT(clip: Clip, localT: number): number {
  return clipKeyframeTimes(clip).filter((t) => t < localT - MOMENT_EPS).pop() ?? 0
}

/** The move in his own numbers while he is still dragging it: 'Zoom 100 to 118%'. */
export function zoomReadout(fromScale: number, toScale: number): string {
  return `Zoom ${Math.round(fromScale * 100)} to ${Math.round(toScale * 100)}%`
}

/** Dots drawn along a motion path, however long the move is. */
export const MAX_PATH_SAMPLES = 120

/**
 * Where the framing travels, as centre-offset points in SEQUENCE pixels, sampled
 * between the first and last position keyframe.
 *
 * Frame resolution, capped, so a five-minute move costs no more than a five-frame
 * one. NEVER sampled while the transport runs: every sample is a pair of
 * resolveChannel calls, and paying for 240 of them per frame of playback is
 * precisely the per-frame work this overlay is built to keep out of playback.
 * The outer component already unmounts during playback; passing the flag keeps
 * that guarantee true at this call site rather than two components away.
 */
export function motionPathDots(clip: Clip, fps: number, playing: boolean): { x: number; y: number }[] {
  if (playing) return []
  const ts = [...channelKeyframes(clip, 'posX'), ...channelKeyframes(clip, 'posY')].map((k) => k.t)
  if (ts.length === 0) return []
  const from = Math.min(...ts)
  const to = Math.max(...ts)
  if (to - from <= MOMENT_EPS) return []
  const n = Math.max(2, Math.min(MAX_PATH_SAMPLES, Math.round((to - from) * (fps || 30)) + 1))
  const dots: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1)
    dots.push({ x: resolveChannel(clip, 'posX', t), y: resolveChannel(clip, 'posY', t) })
  }
  return dots
}

/**
 * A right-clicked point in the picture as the persisted zoom anchor. Normalized,
 * so the point he set on his face survives a change of sequence format instead
 * of sliding off it.
 */
export function normalizedAnchor(sx: number, sy: number, seqW: number, seqH: number): ZoomAnchor {
  return { x: clamp(sx / (seqW || 1), 0, 1), y: clamp(sy / (seqH || 1), 0, 1) }
}

/**
 * Direct-manipulation transform layer over the program monitor.
 * - Click a clip in the preview to SELECT it (click the black bars to deselect).
 * - The selected clip gets a box with corner + edge handles: drag the body to
 *   move, any handle to scale (uniform, about the clip center; the engine has
 *   one scale channel, so aspect is always constrained). Shift snaps the scale
 *   to 5% steps.
 * Live via a preview override; commits ONE undo step on release. Only active
 * while paused with content; the gizmo shows for any clip under the playhead.
 * - The diamond badge in its corner ARMS the clip and steps its moments, and the
 *   border says which of the two a drag will do: solid moves the whole clip,
 *   dashed animates it.
 *
 * The paused-only inner component holds the playheadS subscription, so during
 * PLAYBACK the transport's per-frame ticks re-render nothing here at all.
 */
export function MonitorTransformOverlay({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const playing = useStore((s) => s.ui.playing)
  // A move replaying itself after a tile click drives the playhead exactly the
  // way the transport does, so the gizmo stands down for it too. Without this
  // the overlay re-renders on every frame of the sweep.
  const previewing = useStore((s) => s.ui.previewingMove)
  if (playing || previewing) return null
  return <OverlayInner canvas={canvas} />
}

function OverlayInner({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const selection = useStore((s) => s.ui.selection)
  const project = useStore((s) => s.project)
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const seq = activeSequence(project)

  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  useEffect(() => {
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    // Recompute the overlay box when the canvas or its panel RESIZES, not on a
    // per-frame rAF poll (rect reads every frame force needless layout work).
    const measure = (): void => {
      const cr = canvas.getBoundingClientRect()
      const pr = parent.getBoundingClientRect()
      const next = { left: cr.left - pr.left, top: cr.top - pr.top, w: cr.width, h: cr.height }
      setBox((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.w === next.w && prev.h === next.h
          ? prev
          : next,
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(canvas)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [canvas])

  const rootRef = useRef<HTMLDivElement>(null)
  const tfRef = useRef<Tf | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [dragTf, setDragTf] = useState<Tf | null>(null)
  // Which axes are currently snapped to frame center (drives the guide lines).
  const [centerSnap, setCenterSnap] = useState<{ x: boolean; y: boolean }>({ x: false, y: false })
  useEffect(() => () => cleanupRef.current?.(), [])

  // Playing is handled by the outer gate; here we are always paused.
  const active = !!box && box.w > 0 && seq.durationS > 0
  if (!active || !box) return null

  const k = box.w / seq.width // seq px → overlay px (uniform; aspect matches)
  const localPt = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect()
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) }
  }

  // Visible layers at the playhead, for click-to-select hit-testing.
  const frame = resolveFrame(seq, playheadS)
  const visibleLayers: RenderLayer[] = frame.ops.flatMap((op) =>
    op.type === 'layer' ? [op.layer] : op.type === 'transition' ? [op.from, op.to] : [],
  )
  const quadFor = (layer: RenderLayer): [number, number][] => {
    const isTitle = layer.title !== undefined
    const a = project.assets[layer.assetId]
    const tw = isTitle ? seq.width : (a?.width ?? seq.width)
    const th = isTitle ? seq.height : (a?.height ?? seq.height)
    const corners = computeQuad({
      frameW: seq.width,
      frameH: seq.height,
      texW: tw,
      texH: th,
      transform: layer.transform,
    }).corners
    // A title rasterizes into a FULL-FRAME texture, so its quad is the whole
    // picture. Hit-test its INK instead: otherwise clicking anywhere in the
    // monitor selects the topmost caption, and the footage under it can never
    // be clicked at all.
    if (!isTitle) return corners
    const ink = titleInkBoxUV(layer.title!, seq.width, seq.height)
    return ink ? subQuad(corners, ink) : []
  }

  const doSelect = (clientX: number, clientY: number) => {
    const p = localPt(clientX, clientY)
    const sx = p.x / k
    const sy = p.y / k
    for (let i = visibleLayers.length - 1; i >= 0; i--) {
      if (pointInQuad(sx, sy, quadFor(visibleLayers[i]))) {
        setUI({ selection: [visibleLayers[i].clipId] })
        return
      }
    }
    setUI({ selection: [] })
  }

  // Drag anywhere on the picture to jog (full canvas width == whole sequence,
  // like scrubbing a video player); a click without travel selects instead.
  // Writes only playheadS; every consumer is imperative, so the perf rule holds.
  const selectAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return // right-click is handled by the context menu below
    const startX = e.clientX
    const startPlayhead = useStore.getState().ui.playheadS
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let moved = false
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < SCRUB_SLOP_PX) return
      if (!moved) {
        moved = true
        pausePlayback()
      }
      const t = startPlayhead + (dx / box.w) * seq.durationS
      setUI({ playheadS: quantizeToFrame(Math.max(0, Math.min(seq.durationS, t)), seq.fps) })
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      if (!moved) doSelect(ev.clientX, ev.clientY)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  // Right-click a clip IN the preview → its font/size/appearance menu, so you can
  // restyle and animate a title right where you see it.
  const contextAt = (e: ReactMouseEvent) => {
    const p = localPt(e.clientX, e.clientY)
    const sx = p.x / k
    const sy = p.y / k
    for (let i = visibleLayers.length - 1; i >= 0; i--) {
      const layer = visibleLayers[i]
      if (pointInQuad(sx, sy, quadFor(layer))) {
        // Right-clicking a clip that is ALREADY selected keeps the selection (the
        // timeline's own rule), so restyling 12 word-captions from the monitor hits
        // all 12 instead of silently collapsing to the one under the cursor.
        const keepSelection = selection.includes(layer.clipId)
        const ids = keepSelection ? [...selection] : [layer.clipId]
        if (!keepSelection) setUI({ selection: ids })
        const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === layer.clipId)
        if (clip)
          openContextMenu(e, [
            // The zoom centers on the exact point that was right-clicked.
            { label: 'Punch in here', onClick: () => punchInAtPoint(clip.id, { x: sx, y: sy }) },
            // 'Set zoom point here' was cut on 2026-08-10. It wrote a PERSISTED
            // GLOBAL aim, so one click quietly changed every punch everywhere,
            // for good, from a menu item that read as a local action. The aim
            // belongs to the move: the shelf's moves each carry their own, and
            // 'Punch in here' above still aims one punch at one point.
            ...previewClipMenu(clip, ids).map((item, idx) => (idx === 0 ? { ...item, separator: true } : item)),
          ])
        return
      }
    }
  }

  // --- The selected clip's gizmo (box + handles) ---------------------------
  const clip =
    selection.length === 1 ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selection[0]) : undefined
  const track = clip ? seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id)) : undefined
  // Appearance animations OWN scale/pos keyframes but are base-relative and
  // recompiled on a transform edit, so the gizmo uses their BASE transform.
  // MANUAL keyframes no longer hide the gizmo: it tracks the RESOLVED
  // transform at the playhead, and a drag commits keyframes there (Premiere
  // behavior) via setClipTransformAtPlayhead.
  const appearanceOwned = !!clip?.appearance
  // ARMED off the clip's own keyframes (isClipArmed), which is the same read the
  // commit path and the multi-selection align make, so the gizmo can never
  // disagree with what the drag actually writes.
  const manualAnimated = !appearanceOwned && !!clip && isClipArmed(clip)
  // Whether a drag animates is the clip's own fact, so there is no global mode to
  // read. Kept as a call, not a hook: this component early-returns above, so a
  // hook here runs conditionally and React tears the whole tree down.
  const keyframeOnDrag = (): boolean => manualAnimated
  const onScreen = !!clip && playheadS >= clip.startS && playheadS < clipEndS(clip)
  // Adjustment layers have no transform in the render path (only effects/mask/
  // opacity reach applyAdjustment), so a gizmo would commit undo steps that can
  // never change a pixel.
  const gizmoOn = !!clip && !clip.adjustment && track?.kind === 'video' && onScreen

  let gizmo: React.ReactNode = null
  if (gizmoOn && clip) {
    const clipId = clip.id
    const gizmoLocalT = playheadS - clip.startS
    const tf: Tf =
      dragTf ??
      (manualAnimated
        ? {
            x: resolveChannel(clip, 'posX', gizmoLocalT),
            y: resolveChannel(clip, 'posY', gizmoLocalT),
            scale: resolveChannel(clip, 'scale', gizmoLocalT),
            rotationDeg: resolveChannel(clip, 'rotation', gizmoLocalT),
          }
        : {
            x: clip.transform.x,
            y: clip.transform.y,
            scale: clip.transform.scale,
            rotationDeg: clip.transform.rotationDeg,
          })
    const isTitle = clip.title !== undefined
    const asset = project.assets[clip.assetId]
    const texW = isTitle ? seq.width : (asset?.width ?? seq.width)
    const texH = isTitle ? seq.height : (asset?.height ?? seq.height)
    const rt: ResolvedTransform = {
      x: tf.x,
      y: tf.y,
      scale: tf.scale,
      rotationDeg: tf.rotationDeg,
      anchorX: clip.transform.anchorX,
      anchorY: clip.transform.anchorY,
      cropT: clip.transform.crop.t,
      cropR: clip.transform.crop.r,
      cropB: clip.transform.crop.b,
      cropL: clip.transform.crop.l,
    }
    const { corners } = computeQuad({ frameW: seq.width, frameH: seq.height, texW, texH, transform: rt })
    const xs = corners.map(([x]) => x * k)
    const ys = corners.map(([, y]) => y * k)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    // Keep handles inside the visible frame so they stay grabbable when the clip
    // fills or exceeds it (the drag math uses the pointer, not the handle spot).
    const HM = 9
    const hx = (v: number) => clamp(v, HM, box.w - HM)
    const hy = (v: number) => clamp(v, HM, box.h - HM)
    const handlePts: [number, number][] = [
      [hx(minX), hy(minY)],
      [hx(maxX), hy(minY)],
      [hx(maxX), hy(maxY)],
      [hx(minX), hy(maxY)],
    ]
    const cursors = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize']
    // Edge-midpoint scale handles (top/right/bottom/left). Each edge only
    // shows when it has clearance between its two 24px corner targets, so a
    // small clip never becomes overlapping-target soup.
    const edgeRoomX = maxX - minX >= 40
    const edgeRoomY = maxY - minY >= 40
    const edgePts: {
      x: number
      y: number
      cursor: string
      axis: { x: number; y: number }
      show: boolean
      horiz: boolean
    }[] = [
      { x: hx((minX + maxX) / 2), y: hy(minY), cursor: 'ns-resize', axis: { x: 0, y: -1 }, show: edgeRoomX, horiz: true },
      { x: hx(maxX), y: hy((minY + maxY) / 2), cursor: 'ew-resize', axis: { x: 1, y: 0 }, show: edgeRoomY, horiz: false },
      { x: hx((minX + maxX) / 2), y: hy(maxY), cursor: 'ns-resize', axis: { x: 0, y: 1 }, show: edgeRoomX, horiz: true },
      { x: hx(minX), y: hy((minY + maxY) / 2), cursor: 'ew-resize', axis: { x: -1, y: 0 }, show: edgeRoomY, horiz: false },
    ]

    const apply = (next: Tf) => {
      tfRef.current = next
      setDragTf(next)
      setLivePreviewTransform({ clipId, ...next })
    }
    const startDrag = (drag: Drag) => {
      const onMoveWin = (ev: globalThis.PointerEvent) => {
        const p = localPt(ev.clientX, ev.clientY)
        if (drag.mode === 'move') {
          let x = drag.startTf.x + (p.x - drag.startX) / k
          let y = drag.startTf.y + (p.y - drag.startY) / k
          // Shift constrains to the dominant axis (Premiere muscle memory).
          if (ev.shiftKey) {
            if (Math.abs(p.x - drag.startX) >= Math.abs(p.y - drag.startY)) y = drag.startTf.y
            else x = drag.startTf.x
          }
          // Snap to frame center: x/y are offsets from center, so |v| < 8
          // screen px means "you clearly meant centered".
          const snapSeqPx = 8 / k
          const sx = Math.abs(x) < snapSeqPx
          const sy = Math.abs(y) < snapSeqPx
          if (sx) x = 0
          if (sy) y = 0
          setCenterSnap({ x: sx, y: sy })
          apply({ ...drag.startTf, x, y })
        } else if (drag.mode === 'scale') {
          // Engine scale is uniform, so aspect stays constrained by
          // construction on every handle. Shift snaps to 5% steps, the scale
          // twin of Shift-rotate's 15 degree detents.
          const dist = drag.axis
            ? Math.max(1, (p.x - drag.cx) * drag.axis.x + (p.y - drag.cy) * drag.axis.y)
            : Math.hypot(p.x - drag.cx, p.y - drag.cy)
          let scale = clamp((drag.startTf.scale * dist) / drag.startDist, 0.05, 5)
          if (ev.shiftKey) scale = clamp(Math.round(scale * 20) / 20, 0.05, 5)
          apply({ ...drag.startTf, scale })
        } else {
          // Rotate about the clip center; Shift snaps to 15° increments.
          const ang = (Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180) / Math.PI
          let deg = drag.startTf.rotationDeg + (ang - drag.startAngle)
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15
          apply({ ...drag.startTf, rotationDeg: deg })
        }
      }
      const onUpWin = () => {
        cleanupRef.current?.()
        const final = tfRef.current
        setLivePreviewTransform(null)
        setDragTf(null)
        setCenterSnap({ x: false, y: false })
        tfRef.current = null
        if (!final) return
        if (keyframeOnDrag()) {
          // ARMED clip: write ONLY the channels the drag changed, as keyframes
          // at the playhead.
          const changes: Partial<Tf> = {}
          if (Math.abs(final.x - drag.startTf.x) > 1e-9) changes.x = final.x
          if (Math.abs(final.y - drag.startTf.y) > 1e-9) changes.y = final.y
          if (Math.abs(final.scale - drag.startTf.scale) > 1e-9) changes.scale = final.scale
          if (Math.abs(final.rotationDeg - drag.startTf.rotationDeg) > 1e-9)
            changes.rotationDeg = final.rotationDeg
          setClipTransformAtPlayhead(clipId, changes)
        } else {
          setClipTransform(clipId, final)
        }
      }
      cleanupRef.current = () => {
        window.removeEventListener('pointermove', onMoveWin)
        window.removeEventListener('pointerup', onUpWin)
        cleanupRef.current = null
      }
      window.addEventListener('pointermove', onMoveWin)
      window.addEventListener('pointerup', onUpWin)
    }
    const beginMove = (e: ReactPointerEvent) => {
      if (e.button !== 0) return // let right-click open the context menu instead
      e.preventDefault()
      e.stopPropagation()
      const p = localPt(e.clientX, e.clientY)
      startDrag({ mode: 'move', startX: p.x, startY: p.y, startTf: tf })
    }
    const beginScale = (e: ReactPointerEvent, axis?: { x: number; y: number }) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const p = localPt(e.clientX, e.clientY)
      const cx = (seq.width / 2 + tf.x) * k
      const cy = (seq.height / 2 + tf.y) * k
      const startDist = axis
        ? Math.max(1, (p.x - cx) * axis.x + (p.y - cy) * axis.y)
        : Math.max(1, Math.hypot(p.x - cx, p.y - cy))
      startDrag({ mode: 'scale', startTf: tf, cx, cy, startDist, axis })
    }
    const beginRotate = (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const p = localPt(e.clientX, e.clientY)
      const cx = (seq.width / 2 + tf.x) * k
      const cy = (seq.height / 2 + tf.y) * k
      const startAngle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI
      startDrag({ mode: 'rotate', startTf: tf, cx, cy, startAngle })
    }
    const cxPx = (maxX + minX) / 2

    const badge = motionBadgeState(clip, gizmoLocalT, seq.fps)
    // Just INSIDE the top-left corner: clear of that corner's 24px scale target
    // and of the rotate zone that sits outside it, and clamped like every other
    // handle so it stays grabbable when the clip overflows the frame.
    const badgeX = hx(hx(minX) + 18)
    const badgeY = hy(hy(minY) + 18)

    // The framing he is LEAVING, drawn faint behind the live one while an armed
    // drag runs. A punch is a move FROM somewhere, and the from-frame is the
    // half of it he cannot otherwise see. Resolved at the moment the commit will
    // pin the outgoing keyframe on, so the ghost is the truth and not a guess.
    let ghostCorners: [number, number][] | null = null
    let ghostScale = tf.scale
    if (dragTf && manualAnimated) {
      const fromT = previousMomentT(clip, gizmoLocalT)
      ghostScale = resolveChannel(clip, 'scale', fromT)
      ghostCorners = computeQuad({
        frameW: seq.width,
        frameH: seq.height,
        texW,
        texH,
        transform: {
          ...rt,
          x: resolveChannel(clip, 'posX', fromT),
          y: resolveChannel(clip, 'posY', fromT),
          scale: ghostScale,
          rotationDeg: resolveChannel(clip, 'rotation', fromT),
        },
      }).corners
    }
    // getState, not a subscription: the overlay is unmounted during playback
    // anyway, and re-reading playing reactively here would put this component
    // back on the per-frame path the outer gate exists to keep it off.
    const pathDots = motionPathDots(clip, seq.fps, useStore.getState().ui.playing)

    gizmo = (
      <>
        <div
          data-testid="gizmo-body"
          className="pointer-events-auto absolute cursor-move"
          style={{
            left: minX,
            top: minY,
            width: maxX - minX,
            height: maxY - minY,
            // SOLID means a drag moves the whole clip; DASHED means a drag
            // animates. The border is the answer to the only question he has
            // with his hand already on the picture, so it is on the picture.
            border: `1.5px ${manualAnimated ? 'dashed' : 'solid'} ${ACCENT}`,
            background: ACCENT_WASH,
          }}
          onPointerDown={beginMove}
          onContextMenu={contextAt}
        />
        {/* The ghost framing and the motion path: drawn ABOVE the body wash so
            they stay legible, below every handle so nothing is ever occluded. */}
        {(ghostCorners || pathDots.length > 0) && (
          <svg
            data-testid="gizmo-motion-path"
            className="pointer-events-none absolute left-0 top-0"
            width={box.w}
            height={box.h}
          >
            {ghostCorners && (
              <polygon
                points={ghostCorners.map(([x, y]) => `${x * k},${y * k}`).join(' ')}
                fill="none"
                stroke={ACCENT}
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.4}
              />
            )}
            {pathDots.map((p, i) => (
              <circle
                key={i}
                cx={(seq.width / 2 + p.x) * k}
                cy={(seq.height / 2 + p.y) * k}
                r={1.5}
                fill={ACCENT}
                opacity={0.55}
              />
            ))}
          </svg>
        )}
        {/* Edges render BEFORE corners so a corner wins any hit-target overlap. */}
        {edgePts.map((ep, i) =>
          ep.show ? (
            <div
              key={i}
              data-testid={`gizmo-edge-${i}`}
              className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: ep.x, top: ep.y, cursor: ep.cursor }}
              onPointerDown={(e) => beginScale(e, ep.axis)}
            >
              <div
                className={`rounded-full border ${ep.horiz ? 'h-[6px] w-4' : 'h-4 w-[6px]'}`}
                style={{ background: ACCENT, borderColor: HANDLE_INK }}
              />
            </div>
          ) : null,
        )}
        {/* Corner ROTATE zones: grab just OUTSIDE a corner to rotate (Figma /
            PowerPoint muscle memory). Rendered BEFORE the scale handles so the
            corner square wins the exact corner and this catches the area beyond it. */}
        {handlePts.map(([x, y], i) => {
          const gcx = (minX + maxX) / 2
          const gcy = (minY + maxY) / 2
          const dx = x - gcx
          const dy = y - gcy
          const len = Math.hypot(dx, dy) || 1
          return (
            <div
              key={`rot-${i}`}
              data-testid={`gizmo-corner-rotate-${i}`}
              className="pointer-events-auto absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing"
              style={{ left: x + (dx / len) * 16, top: y + (dy / len) * 16 }}
              onPointerDown={beginRotate}
            />
          )
        })}
        {handlePts.map(([x, y], i) => (
          // 24px invisible hit target wrapping a 12px visual handle.
          <div
            key={i}
            data-testid={`gizmo-handle-${i}`}
            className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            style={{ left: x, top: y, cursor: cursors[i] }}
            onPointerDown={beginScale}
          >
            <div
              className="h-3 w-3 rounded-[2px] border-2"
              style={{ background: ACCENT, borderColor: HANDLE_INK }}
            />
          </div>
        ))}
        {/* Rotate lollipop: 22px above top-center, on a stalk. */}
        <div
          className="pointer-events-none absolute w-px bg-accent/70"
          style={{ left: cxPx, top: hy(minY) - 22, height: 22 }}
        />
        <div
          data-testid="gizmo-rotate"
          className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center active:cursor-grabbing"
          style={{ left: cxPx, top: hy(minY) - 22 }}
          onPointerDown={beginRotate}
        >
          <div
            className="h-3 w-3 rounded-full border-2"
            style={{ background: ACCENT, borderColor: HANDLE_INK }}
          />
        </div>
        {/* The motion badge: one target, on the picture, for the whole keyframe
            loop. It replaces the transport-bar auto-keyframe toggle outright,
            because a persisted global mode meant the same drag did two different
            things on two different nights. */}
        <button
          type="button"
          data-testid="gizmo-motion-badge"
          data-state={badge}
          disabled={badge === 'owned'}
          title={BADGE_TITLE[badge]}
          aria-label={BADGE_TITLE[badge]}
          className="pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
          style={{ left: badgeX, top: badgeY }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleMotionAtPlayhead(clipId)}
        >
          <div
            className="h-[9px] w-[9px] rotate-45 border-2"
            style={{
              background: badge === 'on' ? ACCENT : 'transparent',
              borderColor: badge === 'on' ? HANDLE_INK : ACCENT,
            }}
          />
        </button>
        {/* Live readout while dragging: same chip language as the timeline's
            trim tooltip (elevated surface, mono digits), clamped into view. On an
            armed drag it also names the move he is making, start to finish. */}
        {dragTf && (
          <div
            data-testid="gizmo-readout"
            className="pointer-events-none absolute rounded-[4px] border border-border bg-bg-elevated px-2 py-0.5 font-numeric text-dense text-text-primary shadow-pop"
            style={{ left: Math.max(2, minX), top: Math.max(2, minY - 26) }}
          >
            X {Math.round(tf.x)} · Y {Math.round(tf.y)} · {Math.round(tf.scale * 100)}% · {Math.round(tf.rotationDeg)}°
            {ghostCorners ? ` · ${zoomReadout(ghostScale, tf.scale)}` : ''}
          </div>
        )}
      </>
    )
  }

  // --- Multi-select: drag anywhere on the picture to align every selected clip
  // to the SAME spot (great for stacking a run of captions). We move only the
  // topmost VISIBLE selected clip live, then commit that position to all of them.
  let multiGizmo: React.ReactNode = null
  if (selection.length > 1) {
    const sel = new Set(selection)
    const under = visibleLayers.filter((l) => sel.has(l.clipId))
    const primary = under[under.length - 1]
    const pClip = primary ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === primary.clipId) : undefined
    if (primary && pClip) {
      const xs = quadFor(primary).map(([x]) => x * k)
      const ys = quadFor(primary).map(([, y]) => y * k)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const startTf = { x: pClip.transform.x, y: pClip.transform.y, scale: pClip.transform.scale, rotationDeg: pClip.transform.rotationDeg }

      const beginMulti = (e: ReactPointerEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const start = localPt(e.clientX, e.clientY)
        // Null until an actual drag moves the box: a plain click must NOT align
        // every clip onto the primary (mirrors the single-clip gizmo's guard).
        let last: { x: number; y: number; scale: number; rotationDeg: number } | null = null
        const onMove = (ev: globalThis.PointerEvent) => {
          const p = localPt(ev.clientX, ev.clientY)
          let x = startTf.x + (p.x - start.x) / k
          let y = startTf.y + (p.y - start.y) / k
          if (ev.shiftKey) {
            if (Math.abs(p.x - start.x) >= Math.abs(p.y - start.y)) y = startTf.y
            else x = startTf.x
          }
          last = { ...startTf, x, y }
          setDragTf(last)
          setLivePreviewTransform({ clipId: primary.clipId, ...last })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setLivePreviewTransform(null)
          setDragTf(null)
          if (last) setClipsPosition(selection, last.x, last.y)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      multiGizmo = (
        <div
          data-testid="multi-move-box"
          className="pointer-events-auto absolute cursor-move"
          style={{
            left: minX,
            top: minY,
            width: maxX - minX,
            height: maxY - minY,
            border: `1.5px dashed ${ACCENT}`,
            background: ACCENT_WASH,
          }}
          onPointerDown={beginMulti}
          title={`Drag to align all ${selection.length} selected clips to the same spot`}
        />
      )
    }
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute"
      data-testid="transform-gizmo"
      style={{ left: box.left, top: box.top, width: box.w, height: box.h }}
    >
      {/* Full-canvas click-to-select layer, beneath the gizmo. */}
      <div
        data-testid="preview-select"
        className="pointer-events-auto absolute inset-0"
        onPointerDown={selectAt}
        onContextMenu={contextAt}
      />
      {/* Center-snap guides: shown only while a move-drag holds the snap. */}
      {centerSnap.x && (
        <div className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: box.w / 2 }} />
      )}
      {centerSnap.y && (
        <div className="pointer-events-none absolute inset-x-0 h-px bg-accent/80" style={{ top: box.h / 2 }} />
      )}
      {gizmo}
      {multiGizmo}
    </div>
  )
}
