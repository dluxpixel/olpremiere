import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { clipEndS } from '../engine/timeline'
import { computeQuad, pointInQuad } from '../engine/render/mat'
import { resolveFrame } from '../engine/render/resolve'
import type { RenderLayer, ResolvedTransform } from '../engine/render/types'
import { activeSequence } from '../engine/types'
import { setLivePreviewTransform } from '../engine/preview'
import { previewClipMenu } from '../state/clipMenus'
import { setClipTransform } from '../state/clipEdits'
import { openContextMenu } from '../state/contextMenu'
import { useStore } from '../state/store'

interface Tf {
  x: number
  y: number
  scale: number
}
type Drag =
  | { mode: 'move'; startX: number; startY: number; startTf: Tf }
  | { mode: 'scale'; startTf: Tf; cx: number; cy: number; startDist: number }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const ACCENT = 'var(--color-accent)'

/**
 * Direct-manipulation transform layer over the program monitor.
 * - Click a clip in the preview to SELECT it (click the black bars to deselect).
 * - The selected clip gets a box with 4 corner handles: drag the body to move,
 *   a corner to scale (uniform, about the clip center).
 * Live via a preview override; commits ONE undo step on release. Only active
 * while paused with content; the gizmo shows for a static (non-animated) clip
 * that is under the playhead.
 *
 * The paused-only inner component holds the playheadS subscription, so during
 * PLAYBACK the transport's per-frame ticks re-render nothing here at all.
 */
export function MonitorTransformOverlay({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const playing = useStore((s) => s.ui.playing)
  if (playing) return null
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
    // Recompute the overlay box when the canvas or its panel RESIZES — not on a
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
    op.type === 'layer' ? [op.layer] : [op.from, op.to],
  )
  const quadFor = (layer: RenderLayer): [number, number][] => {
    const isTitle = layer.title !== undefined
    const a = project.assets[layer.assetId]
    const tw = isTitle ? seq.width : (a?.width ?? seq.width)
    const th = isTitle ? seq.height : (a?.height ?? seq.height)
    return computeQuad({ frameW: seq.width, frameH: seq.height, texW: tw, texH: th, transform: layer.transform })
      .corners
  }

  const selectAt = (e: ReactPointerEvent) => {
    if (e.button !== 0) return // right-click is handled by the context menu below
    const p = localPt(e.clientX, e.clientY)
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

  // Right-click a clip IN the preview → its font/size/appearance menu, so you can
  // restyle and animate a title right where you see it.
  const contextAt = (e: ReactMouseEvent) => {
    const p = localPt(e.clientX, e.clientY)
    const sx = p.x / k
    const sy = p.y / k
    for (let i = visibleLayers.length - 1; i >= 0; i--) {
      const layer = visibleLayers[i]
      if (pointInQuad(sx, sy, quadFor(layer))) {
        setUI({ selection: [layer.clipId] })
        const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === layer.clipId)
        if (clip) openContextMenu(e, previewClipMenu(clip))
        return
      }
    }
  }

  // --- The selected clip's gizmo (box + handles) ---------------------------
  const clip =
    selection.length === 1 ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selection[0]) : undefined
  const track = clip ? seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id)) : undefined
  // Appearance animations OWN scale/pos keyframes but are base-relative and
  // recompiled on a transform edit, so the gizmo stays usable for them. Only
  // MANUAL keyframes (no appearance spec) hide it, since dragging would fight them.
  const appearanceOwned = !!clip?.appearance
  const manualAnimated =
    !appearanceOwned &&
    !!(clip?.keyframes?.posX?.length || clip?.keyframes?.posY?.length || clip?.keyframes?.scale?.length)
  const onScreen = !!clip && playheadS >= clip.startS && playheadS < clipEndS(clip)
  const gizmoOn = !!clip && track?.kind === 'video' && !manualAnimated && onScreen

  let gizmo: React.ReactNode = null
  if (gizmoOn && clip) {
    const clipId = clip.id
    const tf: Tf = dragTf ?? { x: clip.transform.x, y: clip.transform.y, scale: clip.transform.scale }
    const isTitle = clip.title !== undefined
    const asset = project.assets[clip.assetId]
    const texW = isTitle ? seq.width : (asset?.width ?? seq.width)
    const texH = isTitle ? seq.height : (asset?.height ?? seq.height)
    const rt: ResolvedTransform = {
      x: tf.x,
      y: tf.y,
      scale: tf.scale,
      rotationDeg: clip.transform.rotationDeg,
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

    const apply = (next: Tf) => {
      tfRef.current = next
      setDragTf(next)
      setLivePreviewTransform({ clipId, ...next })
    }
    const startDrag = (drag: Drag) => {
      const onMoveWin = (ev: globalThis.PointerEvent) => {
        const p = localPt(ev.clientX, ev.clientY)
        if (drag.mode === 'move') {
          apply({
            x: drag.startTf.x + (p.x - drag.startX) / k,
            y: drag.startTf.y + (p.y - drag.startY) / k,
            scale: drag.startTf.scale,
          })
        } else {
          const dist = Math.hypot(p.x - drag.cx, p.y - drag.cy)
          apply({ ...drag.startTf, scale: clamp((drag.startTf.scale * dist) / drag.startDist, 0.05, 5) })
        }
      }
      const onUpWin = () => {
        cleanupRef.current?.()
        const final = tfRef.current
        setLivePreviewTransform(null)
        setDragTf(null)
        tfRef.current = null
        if (final) setClipTransform(clipId, final)
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
    const beginScale = (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const p = localPt(e.clientX, e.clientY)
      const cx = (seq.width / 2 + tf.x) * k
      const cy = (seq.height / 2 + tf.y) * k
      startDrag({ mode: 'scale', startTf: tf, cx, cy, startDist: Math.max(1, Math.hypot(p.x - cx, p.y - cy)) })
    }

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
            border: `1.5px solid ${ACCENT}`,
            background: 'rgba(111,107,255,0.05)',
          }}
          onPointerDown={beginMove}
          onContextMenu={contextAt}
        />
        {handlePts.map(([x, y], i) => (
          <div
            key={i}
            data-testid={`gizmo-handle-${i}`}
            className="pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 border-white"
            style={{ left: x, top: y, cursor: cursors[i], background: ACCENT }}
            onPointerDown={beginScale}
          />
        ))}
      </>
    )
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
      {gizmo}
    </div>
  )
}
