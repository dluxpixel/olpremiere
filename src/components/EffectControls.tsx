// The Effect Controls panel body for a single selected clip (spec §3, §7).
// Each channel row = label + stopwatch toggle + a scrubbable numeric field
// (+ keyframe add/remove + prev/next steppers when animated). Every mutation
// goes through the clipEdits helpers; interpolation math is never redone here.

import { Clock, Diamond, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isChannelAnimated, resolveChannel } from '../engine/keyframes'
import { clipEndS } from '../engine/timeline'
import { TRANSITION_KINDS, type TransitionKind } from '../engine/render/types'
import { type AnimChannel, type Clip } from '../engine/types'
import {
  addKeyframeAtPlayhead,
  removeClipTransition,
  removeKeyframeAtPlayhead,
  setChannel,
  setClipTransition,
  toggleChannelAnimation,
} from '../state/clipEdits'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { KeyframeLane } from './KeyframeLane'

// Per-channel range/step + drag sensitivity. sens = value units per pixel of
// horizontal drag (independent of step, which only governs typed rounding).
interface Spec {
  min: number
  max: number
  step: number
  sens: number
}

const SPECS: Record<AnimChannel, Spec> = {
  posX: { min: -2000, max: 2000, step: 1, sens: 1 },
  posY: { min: -2000, max: 2000, step: 1, sens: 1 },
  scale: { min: 0, max: 5, step: 0.01, sens: 0.01 },
  rotation: { min: -180, max: 180, step: 1, sens: 0.5 },
  anchorX: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  anchorY: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  cropT: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  cropR: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  cropB: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  cropL: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  opacity: { min: 0, max: 1, step: 0.01, sens: 0.005 },
  brightness: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  contrast: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  saturation: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  exposure: { min: -4, max: 4, step: 0.01, sens: 0.02 },
  blur: { min: 0, max: 64, step: 0.5, sens: 0.25 },
}

const LABELS: Record<AnimChannel, string> = {
  posX: 'X',
  posY: 'Y',
  scale: 'Scale',
  rotation: 'Rotation',
  anchorX: 'Anchor X',
  anchorY: 'Anchor Y',
  cropT: 'Top',
  cropR: 'Right',
  cropB: 'Bottom',
  cropL: 'Left',
  opacity: 'Opacity',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  exposure: 'Exposure',
  blur: 'Blur',
}

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)
const roundStep = (v: number, step: number): number => Math.round(v / step) * step

/** Compact number: up to 2 dp, no trailing-zero noise. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const r = Math.round(v * 100) / 100
  return String(r)
}

/**
 * Scrubbable numeric field: click-drag horizontally to change (dx * step *
 * sensitivity), type to set. Enter/blur commits; Escape reverts; double-click
 * or focus enters text-edit. Commits only fire when the value actually moved.
 */
function ScrubField({
  value,
  spec,
  testId,
  ariaLabel,
  onCommit,
}: {
  value: number
  spec: Spec
  testId: string
  ariaLabel: string
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(fmt(value))
  const [editing, setEditing] = useState(false)
  const draggingRef = useRef<{ startX: number; startVal: number; moved: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reflect external value changes (playhead move, undo) unless mid-edit.
  useEffect(() => {
    if (!editing) setText(fmt(value))
  }, [value, editing])

  const commit = (v: number) => {
    const next = clamp(roundStep(v, spec.step), spec.min, spec.max)
    if (Math.abs(next - value) > 1e-9) onCommit(next)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (editing) return
    draggingRef.current = { startX: e.clientX, startVal: value, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = draggingRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (Math.abs(dx) > 2) d.moved = true
    if (!d.moved) return
    const raw = d.startVal + dx * spec.sens
    const next = clamp(roundStep(raw, spec.step), spec.min, spec.max)
    setText(fmt(next))
  }

  const endDrag = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = draggingRef.current
    draggingRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.moved) {
      commit(Number(text))
      // Prevent the click that follows a drag from entering text-edit.
      e.preventDefault()
    }
  }

  const enterEdit = () => {
    setEditing(true)
    // Select-all so a fresh typed value replaces the old one.
    requestAnimationFrame(() => inputRef.current?.select())
  }

  const commitTyped = () => {
    setEditing(false)
    const n = Number(text)
    if (Number.isFinite(n)) commit(n)
    else setText(fmt(value))
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      data-testid={testId}
      aria-label={ariaLabel}
      value={text}
      readOnly={!editing}
      onChange={(e) => setText(e.target.value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={enterEdit}
      onFocus={enterEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commitTyped()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          setEditing(false)
          setText(fmt(value))
          inputRef.current?.blur()
        }
      }}
      onBlur={() => editing && commitTyped()}
      className={`h-6 w-[68px] rounded-[4px] bg-bg-input px-2 text-right text-[12px] tabular-nums text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated ${
        editing ? 'cursor-text' : 'cursor-ew-resize'
      }`}
    />
  )
}

function ChannelRow({
  clip,
  channel,
  playheadS,
}: {
  clip: Clip
  channel: AnimChannel
  playheadS: number
}) {
  const spec = SPECS[channel]
  const animated = isChannelAnimated(clip, channel)
  // Local playhead time, clamped to the clip span (mirrors playheadLocalT);
  // derived from the reactive playheadS prop so the field tracks the playhead.
  const durS = Math.max(0, clipEndS(clip) - clip.startS)
  const localT = Math.max(0, Math.min(playheadS - clip.startS, durS))
  const value = resolveChannel(clip, channel, localT)

  const kfs = clip.keyframes?.[channel] ?? []
  const onKf = animated && kfs.some((k) => Math.abs(k.t - localT) <= 0.05)
  const prevT = animated ? [...kfs].reverse().find((k) => k.t < localT - 1e-6)?.t : undefined
  const nextT = animated ? kfs.find((k) => k.t > localT + 1e-6)?.t : undefined

  const gotoT = (t: number) => {
    // Move the playhead to a keyframe (absolute sequence time).
    useStore.getState().setUI({ playheadS: clip.startS + t })
  }

  return (
    <div className="flex items-center gap-1.5" data-testid={`channel-${channel}`}>
      <IconButton
        label={animated ? `Disable ${LABELS[channel]} keyframes` : `Animate ${LABELS[channel]}`}
        active={animated}
        size="compact"
        data-testid={`stopwatch-${channel}`}
        onClick={() => toggleChannelAnimation(clip.id, channel)}
      >
        <Clock size={13} strokeWidth={1.75} aria-hidden />
      </IconButton>

      <span className="flex-1 truncate text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {LABELS[channel]}
      </span>

      {animated && (
        <>
          <IconButton
            label="Previous keyframe"
            size="compact"
            disabled={prevT === undefined}
            onClick={() => prevT !== undefined && gotoT(prevT)}
          >
            <ChevronLeft size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label={onKf ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
            active={onKf}
            size="compact"
            onClick={() =>
              onKf ? removeKeyframeAtPlayhead(clip.id, channel) : addKeyframeAtPlayhead(clip.id, channel)
            }
          >
            <Diamond size={12} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label="Next keyframe"
            size="compact"
            disabled={nextT === undefined}
            onClick={() => nextT !== undefined && gotoT(nextT)}
          >
            <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </>
      )}

      <ScrubField
        value={value}
        spec={spec}
        testId={`field-${channel}`}
        ariaLabel={LABELS[channel]}
        onCommit={(v) => setChannel(clip.id, channel, v)}
      />
    </div>
  )
}

function Section({ title, channels, clip, playheadS }: {
  title: string
  channels: AnimChannel[]
  clip: Clip
  playheadS: number
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">
        {channels.map((ch) => (
          <ChannelRow key={ch} clip={clip} channel={ch} playheadS={playheadS} />
        ))}
      </div>
    </section>
  )
}

const NONE = 'none'

function TransitionRow({
  clip,
  edge,
  testId,
}: {
  clip: Clip
  edge: 'in' | 'out'
  testId: string
}) {
  const t = edge === 'in' ? clip.transitionIn : clip.transitionOut
  const kind = (t?.type as TransitionKind | undefined) ?? NONE
  const durationS = t?.durationS ?? 1

  const onKind = (v: string) => {
    if (v === NONE) removeClipTransition(clip.id, edge)
    else setClipTransition(clip.id, edge, v as TransitionKind, durationS)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-8 shrink-0 text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {edge === 'in' ? 'In' : 'Out'}
      </span>
      <select
        data-testid={testId}
        aria-label={`${edge === 'in' ? 'In' : 'Out'} transition`}
        value={kind}
        onChange={(e) => onKind(e.target.value)}
        className="h-6 flex-1 cursor-default rounded-[4px] bg-bg-input px-1.5 text-[11px] text-text-primary"
      >
        <option value={NONE}>None</option>
        {TRANSITION_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <input
        type="number"
        aria-label={`${edge === 'in' ? 'In' : 'Out'} transition duration (seconds)`}
        title="Duration (s)"
        min={0.1}
        max={10}
        step={0.1}
        value={durationS}
        disabled={kind === NONE}
        onChange={(e) => {
          const d = Number(e.target.value)
          if (Number.isFinite(d) && d > 0) setClipTransition(clip.id, edge, kind as TransitionKind, d)
        }}
        className="h-6 w-14 rounded-[4px] bg-bg-input px-1.5 text-right text-[11px] tabular-nums text-text-primary disabled:opacity-40"
      />
    </div>
  )
}

export function EffectControls({
  clip,
  playheadS,
}: {
  clip: Clip
  fps?: number
  playheadS: number
}) {
  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Transform"
        channels={['posX', 'posY', 'scale', 'rotation', 'anchorX', 'anchorY']}
        clip={clip}
        playheadS={playheadS}
      />
      <div className="h-px bg-border" />
      <Section title="Crop" channels={['cropT', 'cropR', 'cropB', 'cropL']} clip={clip} playheadS={playheadS} />
      <div className="h-px bg-border" />
      <Section title="Opacity" channels={['opacity']} clip={clip} playheadS={playheadS} />
      <div className="h-px bg-border" />
      <Section
        title="Filters"
        channels={['brightness', 'contrast', 'saturation', 'exposure', 'blur']}
        clip={clip}
        playheadS={playheadS}
      />

      <div className="h-px bg-border" />
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          Transitions
        </h3>
        <div className="flex flex-col gap-1.5">
          <TransitionRow clip={clip} edge="in" testId="transition-in" />
          <TransitionRow clip={clip} edge="out" testId="transition-out" />
        </div>
      </section>

      <div className="h-px bg-border" />
      <section className="flex flex-col gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          Keyframes
        </h3>
        <KeyframeLane clip={clip} playheadS={playheadS} width={240} />
      </section>
    </div>
  )
}
