// Compact keyframe timeline for the selected clip's animated channels. One
// horizontal lane per animated channel; each keyframe is a diamond positioned
// by t across the clip duration. DRAG a diamond (or type in the Time field) to
// retime it. On the Zoom (scale) lane, diamonds are colour-coded: AMBER = a
// zoom-IN (value rose from the previous keyframe), BLUE = a zoom-OUT. Every
// mutation goes through the clipEdits helpers. Times are LOCAL to the clip.

import { useRef, useState } from 'react'
import { clipDurationS } from '../engine/timeline'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { channelKeyframes, isChannelAnimated } from '../engine/effects/channels'
import { ANIM_CHANNELS, type AnimChannel, type Clip, type Keyframe } from '../engine/types'
import { Trash2 } from 'lucide-react'
import { moveKeyframeTime, removeKeyframeAtTime, setKeyframeEase } from '../state/clipEdits'
import { IconButton } from '../ui/Button'
import { ScrubField, type Spec } from './EffectControls'

const EASES: Keyframe['ease'][] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']
const EASE_LABEL: Record<Keyframe['ease'], string> = {
  linear: 'Lin',
  hold: 'Hold',
  easeIn: 'In',
  easeOut: 'Out',
  easeInOut: 'InOut',
}
// Plain-English: this is what "Lin" etc. actually DO, shown as a tooltip + an
// in-context explainer line under the buttons.
const EASE_HELP: Record<Keyframe['ease'], string> = {
  linear: 'Linear — constant speed the whole way (even, mechanical).',
  hold: 'Hold — freeze on this value, then snap to the next (no motion between).',
  easeIn: 'Ease In — starts slow, then speeds up (winds up).',
  easeOut: 'Ease Out — starts fast, then settles. Best for punch-ins landing.',
  easeInOut: 'Ease In-Out — slow at both ends, fast in the middle (most natural).',
}
// Tiny 12×10 curve glyphs so the motion is legible at a glance.
const EASE_GLYPH: Record<Keyframe['ease'], string> = {
  linear: 'M1 9 L11 1',
  hold: 'M1 9 L6 9 L6 1 L11 1',
  easeIn: 'M1 9 C6 9 9 6 11 1',
  easeOut: 'M1 9 C3 4 6 1 11 1',
  easeInOut: 'M1 9 C5 9 7 1 11 1',
}

// Human channel names — "scale" reads as Zoom, the thing Jettism editors touch most.
const FRIENDLY: Partial<Record<AnimChannel, string>> = {
  scale: 'Zoom',
  posX: 'Position X',
  posY: 'Position Y',
  rotation: 'Rotation',
  opacity: 'Opacity',
  anchorX: 'Anchor X',
  anchorY: 'Anchor Y',
  cropT: 'Crop Top',
  cropR: 'Crop Right',
  cropB: 'Crop Bottom',
  cropL: 'Crop Left',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  exposure: 'Exposure',
  blur: 'Blur',
  lift: 'Lift',
  gamma: 'Gamma',
  gain: 'Gain',
  temperature: 'Temperature',
  tint: 'Tint',
  volume: 'Volume (dB)',
}
const friendly = (ch: AnimChannel): string => FRIENDLY[ch] ?? ch

const ZOOM_IN = '#f5a524' // amber
const ZOOM_OUT = '#3b7dff' // blue

interface Selected {
  channel: AnimChannel
  t: number
}

interface DragState {
  channel: AnimChannel
  origT: number
  draftT: number
  trackW: number
  startX: number
  moved: boolean
}

/** What the render needs to draw the diamond mid-drag (ref holds the truth). */
interface DragView {
  channel: AnimChannel
  origT: number
  t: number
}

const DRAG_SLOP_PX = 3

function EaseGlyph({ ease }: { ease: Keyframe['ease'] }) {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden className="shrink-0">
      <path d={EASE_GLYPH[ease]} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function EaseControl({
  clipId,
  selected,
  ease,
}: {
  clipId: string
  selected: Selected
  ease: Keyframe['ease']
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-[4px] bg-bg-input p-0.5"
      role="group"
      aria-label="Keyframe easing (how it animates toward the next keyframe)"
    >
      {EASES.map((e) => (
        <button
          key={e}
          type="button"
          aria-label={EASE_HELP[e]}
          aria-pressed={e === ease}
          title={EASE_HELP[e]}
          onClick={() => setKeyframeEase(clipId, selected.channel, selected.t, e)}
          className={`flex cursor-default items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[10px] transition-colors duration-[120ms] ${
            e === ease
              ? 'bg-accent-quiet text-accent'
              : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
          }`}
        >
          <EaseGlyph ease={e} />
          {EASE_LABEL[e]}
        </button>
      ))}
    </div>
  )
}

export function KeyframeLane({
  clip,
  playheadS,
  width = 200,
  fps = 30,
}: {
  clip: Clip
  playheadS: number
  fps?: number
  width?: number
}) {
  const [selected, setSelected] = useState<Selected | null>(null)
  // The drag's authoritative data lives in a ref so pointer handlers never read
  // a stale closure (the first pointermove after pointerdown otherwise sees the
  // pre-drag state). `dragView` mirrors just enough for the render.
  const dragRef = useRef<DragState | null>(null)
  const [dragView, setDragView] = useState<DragView | null>(null)

  const animated = ANIM_CHANNELS.filter((ch) => isChannelAnimated(clip, ch))
  if (animated.length === 0) return null

  const durS = clipDurationS(clip)
  const snap = (t: number): number =>
    Math.max(0, Math.min(fps > 0 ? quantizeToFrame(t, fps) : t, durS))

  // Local playhead position within the clip; may fall outside [0, durS].
  const localT = playheadS - clip.startS
  const frac = durS > 0 ? localT / durS : 0
  const showPlayhead = frac >= 0 && frac <= 1

  // Track width leaves room for the channel label gutter.
  const labelW = 76
  const trackW = Math.max(40, width - labelW)
  const hasZoom = animated.includes('scale')

  const selEase =
    selected &&
    (channelKeyframes(clip, selected.channel).find((k) => Math.abs(k.t - selected.t) <= 1e-4)?.ease ?? null)

  // Window-level move/up listeners (installed on pointerdown, removed on up) so
  // the drag keeps tracking even when the pointer leaves the small diamond — more
  // robust than relying on pointer capture for such a tiny target.
  const onDiamondDown = (e: React.PointerEvent<HTMLButtonElement>, ch: AnimChannel, k: Keyframe) => {
    if (e.button !== 0) return
    const track = e.currentTarget.parentElement
    if (!track) return
    e.preventDefault()
    dragRef.current = {
      channel: ch,
      origT: k.t,
      draftT: k.t,
      trackW: track.getBoundingClientRect().width || trackW,
      startX: e.clientX,
      moved: false,
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      d.moved = d.moved || Math.abs(dx) > DRAG_SLOP_PX
      d.draftT = durS > 0 ? snap(d.origT + (dx / d.trackW) * durS) : 0
      if (d.moved) setDragView({ channel: d.channel, origT: d.origT, t: d.draftT })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDragView(null)
      if (!d) return
      if (d.moved && Math.abs(d.draftT - d.origT) > 1e-6) {
        moveKeyframeTime(clip.id, ch, d.origT, d.draftT)
        setSelected({ channel: ch, t: d.draftT })
      } else {
        // A click (no meaningful drag): toggle selection (functional set = fresh read).
        setSelected((prev) => (prev?.channel === ch && Math.abs(prev.t - k.t) <= 1e-4 ? null : { channel: ch, t: k.t }))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const timeSpec: Spec = { min: 0, max: Math.max(0.01, durS), step: fps > 0 ? 1 / fps : 0.01, sens: durS / 280 }

  // Colour a diamond: selected → accent; on the Zoom lane, amber if it zooms IN
  // from the previous keyframe, blue if it zooms OUT; otherwise a neutral dot.
  const diamondColor = (ch: AnimChannel, kfs: readonly Keyframe[], i: number, isSel: boolean): string => {
    if (isSel) return 'var(--color-accent)'
    if (ch === 'scale' && i > 0) {
      const d = kfs[i].value - kfs[i - 1].value
      if (d > 1e-4) return ZOOM_IN
      if (d < -1e-4) return ZOOM_OUT
    }
    return 'var(--color-text-secondary)'
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="keyframe-lane">
      {animated.map((ch) => {
        const kfs = channelKeyframes(clip, ch)
        return (
          <div key={ch} className="flex items-center gap-2" style={{ height: 20 }}>
            <span
              className="shrink-0 truncate text-[10px] font-medium uppercase tracking-[0.04em] text-text-secondary"
              style={{ width: labelW }}
              title={friendly(ch)}
            >
              {friendly(ch)}
            </span>
            <div
              className="relative h-full flex-1 rounded-[3px] bg-bg-input"
              style={{ minWidth: trackW }}
            >
              {/* mid-line rail */}
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
              {showPlayhead && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-playhead"
                  style={{ left: `${frac * 100}%` }}
                />
              )}
              {kfs.map((k, i) => {
                const dragging = dragView?.channel === ch && Math.abs(dragView.origT - k.t) <= 1e-4
                const t = dragging ? dragView!.t : k.t
                const x = durS > 0 ? (t / durS) * 100 : 0
                const isSel = selected?.channel === ch && Math.abs(selected.t - k.t) <= 1e-4
                const color = dragging ? 'var(--color-accent)' : diamondColor(ch, kfs, i, isSel)
                return (
                  <button
                    key={k.t}
                    type="button"
                    data-testid="keyframe"
                    aria-label={`${friendly(ch)} keyframe at ${t.toFixed(2)}s, value ${k.value}`}
                    title={`${friendly(ch)} = ${Math.round(k.value * 100) / 100} @ ${t.toFixed(2)}s · ${k.ease} · drag to retime`}
                    onPointerDown={(e) => onDiamondDown(e, ch, k)}
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize rounded-[2px] border border-black/30 transition-[background,box-shadow,transform] duration-[120ms] hover:scale-110"
                    style={{
                      left: `${Math.min(100, Math.max(0, x))}%`,
                      touchAction: 'none',
                      background: color,
                      boxShadow: isSel || dragging ? '0 0 0 2px var(--color-accent)' : undefined,
                    }}
                  />
                )
              })}
              {/* Live time readout while dragging a diamond on this lane. */}
              {dragView?.channel === ch && (
                <div
                  className="pointer-events-none absolute -top-4 z-10 -translate-x-1/2 whitespace-nowrap rounded-[3px] bg-bg-elevated px-1 py-px text-[9px] tabular-nums text-text-primary shadow"
                  style={{ left: `${Math.min(100, Math.max(0, (dragView.t / Math.max(durS, 1e-6)) * 100))}%` }}
                >
                  {formatTimecode(dragView.t, fps)}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Legend for the zoom colour-coding — only when a Zoom lane is shown. */}
      {hasZoom && (
        <div className="flex items-center gap-3 pl-[84px] text-[9px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: ZOOM_IN }} /> zoom in
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: ZOOM_OUT }} /> zoom out
          </span>
          <span className="text-text-muted/70">· click a diamond to edit · drag to retime</span>
        </div>
      )}

      {selected && selEase && (
        <div className="mt-0.5 flex flex-col gap-1.5 rounded-[6px] bg-bg-elevated/60 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.04em] text-text-muted">Time</span>
            <ScrubField
              value={selected.t}
              spec={timeSpec}
              testId="keyframe-time"
              ariaLabel="Keyframe time (seconds)"
              onCommit={(v) => {
                const t = snap(v)
                moveKeyframeTime(clip.id, selected.channel, selected.t, t)
                setSelected({ channel: selected.channel, t })
              }}
            />
            <EaseControl clipId={clip.id} selected={selected} ease={selEase} />
            <IconButton
              size="compact"
              label="Delete keyframe"
              data-testid="keyframe-delete"
              onClick={() => {
                removeKeyframeAtTime(clip.id, selected.channel, selected.t)
                setSelected(null)
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </div>
          {/* In-context answer to "what is Lin?" — explains the CURRENT easing. */}
          <p className="text-[10px] leading-snug text-text-muted">{EASE_HELP[selEase]}</p>
        </div>
      )}
    </div>
  )
}
