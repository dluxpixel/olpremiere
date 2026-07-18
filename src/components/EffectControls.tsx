// The Effect Controls panel body for a single selected clip (spec §3, §7).
// Each channel row = label + stopwatch toggle + a scrubbable numeric field
// (+ keyframe add/remove + prev/next steppers when animated). Every mutation
// goes through the clipEdits helpers; interpolation math is never redone here.

import {
  Bookmark,
  Clock,
  Diamond,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { channelKeyframes, isChannelAnimated, resolveChannel } from '../engine/effects/channels'
import { isParamAnimated, paramKeyframes, resolveParam } from '../engine/effects/ops'
import { EFFECTS, getEffect, paramSens, type EffectParamDef } from '../engine/effects/registry'
import { clipEndS } from '../engine/timeline'
import {
  TRANSITION_KINDS,
  TRANSITION_LABELS,
  transitionDurationSpec,
  type TransitionKind,
} from '../engine/render/types'
import {
  ANIM_CHANNELS,
  BLEND_LABELS,
  BLEND_MODES,
  type AnimChannel,
  type BlendMode,
  type Clip,
  type ClipMask,
  type EffectInstance,
} from '../engine/types'
import {
  addEffectKeyframeAtPlayhead,
  addKeyframeAtPlayhead,
  applyEffect,
  deleteEffect,
  moveEffectInStack,
  removeClipTransition,
  removeEffectKeyframeAtPlayhead,
  removeKeyframeAtPlayhead,
  resetChannel,
  resetChannels,
  resetEffectParams,
  setChannel,
  setClipBlendMode,
  setClipMask,
  setClipTransition,
  setEffectParamValue,
  toggleChannelAnimation,
  toggleEffectEnabled,
  toggleEffectParamKeyframes,
} from '../state/clipEdits'
import { saveSelectionAsPreset } from '../state/library'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { KeyframeLane } from './KeyframeLane'
import { PunchControl } from './PunchControl'

// Per-channel range/step + drag sensitivity. sens = value units per pixel of
// horizontal drag (independent of step, which only governs typed rounding).
export interface Spec {
  min: number
  max: number
  step: number
  sens: number
}

// Only the FIXED channels live here now: transform, crop, opacity. Colour and
// blur are applied effects, and their ranges come from the effect registry.
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
  volume: { min: -60, max: 12, step: 0.5, sens: 0.2 },
  brightness: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  contrast: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  saturation: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  exposure: { min: -4, max: 4, step: 0.01, sens: 0.02 },
  blur: { min: 0, max: 64, step: 0.5, sens: 0.25 },
  lift: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  gamma: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  gain: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  temperature: { min: -1, max: 1, step: 0.01, sens: 0.005 },
  tint: { min: -1, max: 1, step: 0.01, sens: 0.005 },
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
  volume: 'Volume',
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
export function ScrubField({
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
    // Shift = fine scrub (⅕ sensitivity) for landing precise values, like Premiere/AE.
    const sens = e.shiftKey ? spec.sens * 0.2 : spec.sens
    const raw = d.startVal + dx * sens
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
      // Drop focus so the NEXT drag scrubs too — a focused field used to be
      // stuck in edit mode, making drag-scrub one-shot per field.
      inputRef.current?.blur()
    } else {
      // A genuine click (no movement) enters text-edit — same UX as before,
      // but decided here instead of by focus (which pointerdown also fires).
      enterEdit()
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

  // Position-in-range fill: 0% at min, 100% at max. Finite ranges only — a
  // sensitivity-only field (e.g. ±4000 offsets) still fills, which reads fine.
  const span = spec.max - spec.min
  const frac = span > 0 ? clamp((value - spec.min) / span, 0, 1) : 0

  return (
    <div className="relative w-[68px]">
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
        // Keyboard/tab focus enters edit; a pointer-initiated focus does not
        // (draggingRef is already set by onPointerDown) — endDrag decides
        // between click→edit and drag→scrub instead.
        onFocus={() => {
          if (!draggingRef.current) enterEdit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitTyped()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            setEditing(false)
            setText(fmt(value))
            inputRef.current?.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Arrow = nudge by one step (×10 with Shift), like every pro NLE field.
            e.preventDefault()
            const base = Number(text)
            const from = Number.isFinite(base) ? base : value
            const dir = e.key === 'ArrowUp' ? 1 : -1
            const next = clamp(roundStep(from + dir * spec.step * (e.shiftKey ? 10 : 1), spec.step), spec.min, spec.max)
            setText(fmt(next))
            if (Math.abs(next - value) > 1e-9) onCommit(next)
          }
        }}
        onBlur={() => editing && commitTyped()}
        className={`h-6 w-full rounded-[4px] bg-bg-input px-2 text-right text-[12px] tabular-nums text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated ${
          editing ? 'cursor-text' : 'cursor-ew-resize'
        }`}
      />
      {/* Slider fill — a bounded param now shows where it sits in its range. */}
      {!editing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-1 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-white/10"
        >
          <div className="h-full rounded-full bg-accent/60" style={{ width: `${frac * 100}%` }} />
        </div>
      )}
    </div>
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

  const kfs = channelKeyframes(clip, channel)
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

      <span
        className="flex-1 cursor-default truncate text-[11px] uppercase tracking-[0.04em] text-text-muted"
        title={`${LABELS[channel]} — double-click to reset`}
        onDoubleClick={() => resetChannel(clip.id, channel)}
      >
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
      <div className="flex items-center">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          {title}
        </h3>
        <span className="ml-auto">
          <IconButton
            label={`Reset ${title}`}
            size="compact"
            data-testid={`reset-section-${title.toLowerCase()}`}
            onClick={() => resetChannels(clip.id, channels)}
          >
            <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {channels.map((ch) => (
          <ChannelRow key={ch} clip={clip} channel={ch} playheadS={playheadS} />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The applied effect stack. Rows address an effect INSTANCE by id, so a clip can
// carry the same effect twice and each copy keeps its own params and keyframes.

/** Keyframe steppers shared by channel rows and effect-param rows. */
function KeyframeNav({
  kfs,
  localT,
  onGoto,
  onToggleKf,
  onKf,
}: {
  kfs: readonly { t: number }[]
  localT: number
  onGoto: (t: number) => void
  onToggleKf: () => void
  onKf: boolean
}) {
  const prevT = [...kfs].reverse().find((k) => k.t < localT - 1e-6)?.t
  const nextT = kfs.find((k) => k.t > localT + 1e-6)?.t
  return (
    <>
      <IconButton label="Previous keyframe" size="compact" disabled={prevT === undefined} onClick={() => prevT !== undefined && onGoto(prevT)}>
        <ChevronLeft size={13} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label={onKf ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'} active={onKf} size="compact" onClick={onToggleKf}>
        <Diamond size={12} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton label="Next keyframe" size="compact" disabled={nextT === undefined} onClick={() => nextT !== undefined && onGoto(nextT)}>
        <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </>
  )
}

function EffectParamRow({
  clip,
  effect,
  param,
  localT,
}: {
  clip: Clip
  effect: EffectInstance
  param: EffectParamDef
  localT: number
}) {
  const animated = isParamAnimated(effect, param.key)
  const value = resolveParam(effect, param.key, localT)
  const kfs = paramKeyframes(effect, param.key)
  const onKf = animated && kfs.some((k) => Math.abs(k.t - localT) <= 0.05)
  const spec: Spec = { min: param.min, max: param.max, step: param.step, sens: paramSens(param) }

  const gotoT = (t: number) => useStore.getState().setUI({ playheadS: clip.startS + t })

  return (
    <div className="flex items-center gap-1.5" data-testid={`channel-${param.key}`} data-effect-id={effect.id}>
      <IconButton
        label={animated ? `Disable ${param.label} keyframes` : `Animate ${param.label}`}
        active={animated}
        size="compact"
        data-testid={`stopwatch-${param.key}`}
        onClick={() => toggleEffectParamKeyframes(clip.id, effect.id, param.key)}
      >
        <Clock size={13} strokeWidth={1.75} aria-hidden />
      </IconButton>

      <span className="flex-1 truncate text-[11px] uppercase tracking-[0.04em] text-text-muted">{param.label}</span>

      {animated && (
        <KeyframeNav
          kfs={kfs}
          localT={localT}
          onGoto={gotoT}
          onKf={onKf}
          onToggleKf={() =>
            onKf
              ? removeEffectKeyframeAtPlayhead(clip.id, effect.id, param.key)
              : addEffectKeyframeAtPlayhead(clip.id, effect.id, param.key)
          }
        />
      )}

      <ScrubField
        value={value}
        spec={spec}
        testId={`field-${param.key}`}
        ariaLabel={param.label}
        onCommit={(v) => setEffectParamValue(clip.id, effect.id, param.key, v)}
      />
    </div>
  )
}

function EffectCard({ clip, effect, index, count, localT }: {
  clip: Clip
  effect: EffectInstance
  index: number
  count: number
  localT: number
}) {
  const def = getEffect(effect.type)
  // An effect type the registry no longer knows: show it honestly, let it be
  // removed, but never pretend to render controls for it.
  if (!def) {
    return (
      <div className="rounded-[6px] border border-border bg-bg-elevated p-2" data-testid="effect-card">
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-[12px] text-text-secondary">Unknown effect: {effect.type}</span>
          <IconButton label="Remove effect" size="compact" onClick={() => deleteEffect(clip.id, effect.id)}>
            <X size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[6px] border border-border bg-bg-elevated p-2"
      data-testid="effect-card"
      data-effect-type={effect.type}
      data-effect-id={effect.id}
    >
      <div className="flex items-center gap-1">
        <IconButton
          label={effect.enabled ? `Disable ${def.label}` : `Enable ${def.label}`}
          active={effect.enabled}
          size="compact"
          data-testid="effect-toggle"
          onClick={() => toggleEffectEnabled(clip.id, effect.id)}
        >
          {effect.enabled ? <Eye size={13} strokeWidth={1.75} aria-hidden /> : <EyeOff size={13} strokeWidth={1.75} aria-hidden />}
        </IconButton>
        <span
          title={def.description}
          className={`flex-1 truncate text-[12px] font-medium ${effect.enabled ? 'text-text-primary' : 'text-text-muted line-through'}`}
        >
          {def.label}
        </span>
        <IconButton label={`Move ${def.label} earlier`} size="compact" disabled={index === 0} data-testid="effect-up" onClick={() => moveEffectInStack(clip.id, effect.id, -1)}>
          <ChevronUp size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={`Move ${def.label} later`} size="compact" disabled={index === count - 1} data-testid="effect-down" onClick={() => moveEffectInStack(clip.id, effect.id, 1)}>
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={`Reset ${def.label}`} size="compact" data-testid="effect-reset" onClick={() => resetEffectParams(clip.id, effect.id)}>
          <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={`Remove ${def.label}`} size="compact" data-testid="effect-remove" onClick={() => deleteEffect(clip.id, effect.id)}>
          <X size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <div className={`flex flex-col gap-1.5 ${effect.enabled ? '' : 'opacity-40'}`}>
        {def.params.map((param) => (
          <EffectParamRow key={param.key} clip={clip} effect={effect} param={param} localT={localT} />
        ))}
      </div>
    </div>
  )
}

function EffectStack({ clip, playheadS }: { clip: Clip; playheadS: number }) {
  const durS = Math.max(0, clipEndS(clip) - clip.startS)
  const localT = Math.max(0, Math.min(playheadS - clip.startS, durS))

  return (
    <section className="flex flex-col gap-2" data-testid="effect-stack">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Effects</h3>
        <span className="ml-auto flex items-center gap-1">
          {/* Add an effect without leaving for the Effects tab. */}
          <select
            aria-label="Add effect"
            data-testid="inspector-add-effect"
            value=""
            onChange={(e) => {
              if (e.target.value) applyEffect(clip.id, e.target.value)
            }}
            className="h-6 cursor-default rounded-[4px] bg-bg-input px-1.5 text-[11px] text-text-secondary"
          >
            <option value="">+ Add effect…</option>
            {EFFECTS.map((ef) => (
              <option key={ef.type} value={ef.type}>
                {ef.label}
              </option>
            ))}
          </select>
          {clip.effects.length > 0 && (
            <IconButton
              label="Save effects as preset"
              size="compact"
              data-testid="save-preset"
              onClick={() => void saveSelectionAsPreset()}
            >
              <Bookmark size={13} strokeWidth={1.75} aria-hidden />
            </IconButton>
          )}
        </span>
      </div>
      {clip.effects.length === 0 ? (
        <div
          data-testid="effect-stack-empty"
          className="flex flex-col items-center gap-1.5 rounded-[6px] border border-dashed border-border-strong px-2 py-4 text-center"
        >
          <Sparkles size={18} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[11px] text-text-secondary">No effects applied</div>
          <div className="text-[10px] text-text-muted">Drag one from the Effects panel, or double-click it</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {clip.effects.map((effect, i) => (
            <EffectCard key={effect.id} clip={clip} effect={effect} index={i} count={clip.effects.length} localT={localT} />
          ))}
        </div>
      )}
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
            {TRANSITION_LABELS[k]}
          </option>
        ))}
      </select>
      {kind === NONE ? (
        <span className="w-[68px] shrink-0 text-right text-[11px] text-text-muted">—</span>
      ) : (
        <ScrubField
          value={durationS}
          // whiteFlash scrubs inside its tight 100–500 ms envelope with a finer
          // step; other kinds keep the classic 0.1–10 s range.
          spec={{
            min: transitionDurationSpec(kind as TransitionKind).min,
            max: transitionDurationSpec(kind as TransitionKind).max,
            step: kind === 'whiteFlash' ? 0.05 : 0.1,
            sens: 0.03,
          }}
          testId={`${testId}-duration`}
          ariaLabel={`${edge === 'in' ? 'In' : 'Out'} transition duration (seconds)`}
          onCommit={(d) => setClipTransition(clip.id, edge, kind as TransitionKind, d)}
        />
      )}
    </div>
  )
}

const DEFAULT_MASK: Omit<ClipMask, 'kind'> = { cx: 0.5, cy: 0.5, rx: 0.35, ry: 0.35, feather: 0.05, invert: false }

const MASK_FIELDS: { key: 'cx' | 'cy' | 'rx' | 'ry' | 'feather'; label: string; max: number }[] = [
  { key: 'cx', label: 'Center X', max: 1 },
  { key: 'cy', label: 'Center Y', max: 1 },
  { key: 'rx', label: 'Width', max: 1 },
  { key: 'ry', label: 'Height', max: 1 },
  { key: 'feather', label: 'Feather', max: 0.5 },
]

function MaskSection({ clip }: { clip: Clip }) {
  const mask = clip.mask
  const onKind = (v: string) => {
    if (v === 'none') setClipMask(clip.id, undefined)
    else setClipMask(clip.id, { ...(mask ?? DEFAULT_MASK), kind: v as ClipMask['kind'] })
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Mask</h3>
      <div className="flex items-center gap-1.5">
        <select
          data-testid="mask-kind"
          aria-label="Mask shape"
          value={mask?.kind ?? 'none'}
          onChange={(e) => onKind(e.target.value)}
          className="h-6 flex-1 cursor-default rounded-[4px] bg-bg-input px-1.5 text-[11px] text-text-primary"
        >
          <option value="none">None</option>
          <option value="rect">Rectangle</option>
          <option value="ellipse">Ellipse</option>
        </select>
        {mask && (
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
            <input
              type="checkbox"
              data-testid="mask-invert"
              checked={mask.invert}
              onChange={(e) => setClipMask(clip.id, { ...mask, invert: e.target.checked })}
            />
            Invert
          </label>
        )}
      </div>
      {mask &&
        MASK_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[11px] text-text-muted">{f.label}</span>
            <ScrubField
              value={mask[f.key]}
              spec={{ min: 0, max: f.max, step: 0.01, sens: 0.003 }}
              testId={`mask-${f.key}`}
              ariaLabel={`Mask ${f.label}`}
              onCommit={(v) => setClipMask(clip.id, { ...mask, [f.key]: v })}
            />
          </div>
        ))}
    </section>
  )
}

export function EffectControls({
  clip,
  playheadS,
  fps,
}: {
  clip: Clip
  fps?: number
  playheadS: number
}) {
  // "Put the keyframe completely up": the Zoom/Punch control + (when animated)
  // the Keyframes editor lead the panel instead of hiding at the very bottom.
  const hasAnimation = ANIM_CHANNELS.some((ch) => isChannelAnimated(clip, ch))
  // Adjustment layers render ONLY effects/mask/opacity (resolve.ts builds the
  // op from just those) — transform, crop, blend and punch would be inert
  // document edits, so they are hidden with a hint instead.
  const isAdjustment = clip.adjustment === true
  return (
    <div className="flex flex-col gap-5">
      {isAdjustment && (
        <p className="rounded-[4px] bg-bg-input px-2 py-1.5 text-[11px] leading-snug text-text-muted">
          Adjustment layer — its effects, mask and opacity grade everything below it.
        </p>
      )}
      {!isAdjustment && <PunchControl clipId={clip.id} />}
      {hasAnimation && (
        <>
          <section className="flex flex-col gap-2" data-testid="keyframes-section">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
              Keyframes
            </h3>
            <KeyframeLane clip={clip} playheadS={playheadS} width={240} fps={fps} />
          </section>
          <div className="h-px bg-border" />
        </>
      )}
      {!isAdjustment && (
        <>
          <Section
            title="Transform"
            channels={['posX', 'posY', 'scale', 'rotation', 'anchorX', 'anchorY']}
            clip={clip}
            playheadS={playheadS}
          />
          <div className="h-px bg-border" />
          <Section title="Crop" channels={['cropT', 'cropR', 'cropB', 'cropL']} clip={clip} playheadS={playheadS} />
          <div className="h-px bg-border" />
        </>
      )}
      <Section title="Opacity" channels={['opacity']} clip={clip} playheadS={playheadS} />
      {!isAdjustment && (
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[11px] text-text-muted">Blend</span>
          <select
            data-testid="blend-mode"
            aria-label="Blend mode"
            value={clip.blendMode ?? 'normal'}
            onChange={(e) => setClipBlendMode(clip.id, e.target.value as BlendMode)}
            className="h-6 flex-1 cursor-default rounded-[4px] bg-bg-input px-1.5 text-[11px] text-text-primary"
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {BLEND_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="h-px bg-border" />
      <MaskSection clip={clip} />
      <div className="h-px bg-border" />
      <EffectStack clip={clip} playheadS={playheadS} />

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
    </div>
  )
}
