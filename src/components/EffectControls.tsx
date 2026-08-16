// The Effect Controls panel body for a single selected clip (spec §3, §7).
// Each channel row = label + stopwatch toggle + a scrubbable numeric field
// (+ keyframe add/remove + prev/next steppers when animated). Every mutation
// goes through the clipEdits helpers; interpolation math is never redone here.
//
// The panel is a MOTION DESK now, and that is one structural move: there is no
// standalone Keyframes section any more. A row that is animated grows its own
// KeyframeTrack directly underneath it, and the CurveEditor under THAT when a
// segment on that property is selected, so the diamonds are always under the
// number they animate. The whole body sits inside ONE MotionRail, so the ruler,
// the playhead and every lane read the same x-axis, and an effect param row
// gets a lane on it for nothing: it already shares PropRow and KeyframeNav.
//
// Motion leads the panel (his brief, 2026-08-06: "when you click on a clip,
// then on the part on the right"), with the rail's ruler directly under it.

import {
  Bookmark,
  Clock,
  Diamond,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import {
  CHANNEL_EFFECT,
  channelKeyframes,
  isChannelAnimated,
  resolveChannel,
} from '../engine/effects/channels'
import { isParamAnimated, paramKeyframes, resolveParam } from '../engine/effects/ops'
import { INNER_ZOOM } from '../engine/innerZoom'
import { BROWSABLE_EFFECTS, getEffect, paramSens, type EffectParamDef } from '../engine/effects/registry'
import { clipEndS } from '../engine/timeline'
import {
  TRANSITION_KINDS,
  TRANSITION_LABELS,
  transitionDurationSpec,
  type TransitionKind,
} from '../engine/render/types'
import {
  BLEND_LABELS,
  BLEND_MODES,
  type AnimChannel,
  type BlendMode,
  type Clip,
  type ClipMask,
  type EffectInstance,
} from '../engine/types'
import { isEffectRamped } from '../engine/effects/ops'
import { useEffectDrop } from './effectDrop'
import {
  addEffectKeyframeAtPlayhead,
  addInnerZoomKeyframeAtPlayhead,
  addKeyframeAtPlayhead,
  applyEffect,
  deleteEffect,
  innerZoomAt,
  innerZoomKeyframes,
  innerZoomOwnsCrop,
  isInnerZoomAnimated,
  removeInnerZoomKeyframeAtPlayhead,
  setInnerZoomAtPlayhead,
  toggleInnerZoomAnimation,
  moveEffectInStack,
  reorderEffect,
  resetAllEffectParams,
  setAllEffectsEnabled,
  removeClipTransition,
  clearEffectRamp,
  rampEffect,
  removeEffectKeyframeAtPlayhead,
  removeKeyframeAtPlayhead,
  removeZoom,
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
import { EFFECT_CARD_MIME, dragHasType } from '../state/dnd'
import { allFolded, setEffectsFolded, toggleEffectFold, useEffectFold } from '../state/effectFold'
import { saveSelectionAsPreset } from '../state/library'
import { useRecentEffects } from '../state/recentEffects'
import { EASE_SECONDS, setEaseSeconds, useSettings } from '../state/settings'
import { createPendingEdit, type PendingEdit } from './pendingEdit'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { CurveEditor } from './CurveEditor'
import { KeyframeTrack } from './KeyframeTrack'
import { MotionRail, useMotionRail } from './MotionRail'
import { MoveShelf } from './MoveShelf'
import { PunchControl } from './PunchControl'
import { MOVE_CHANNELS } from '../engine/moves'
import { MAX_GAIN_DB } from '../engine/loudness'

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
//
// Exported so the keyframe lane can type a MOMENT'S value against the same
// bounds the property row scrubs against. Two tables would drift, and the pair
// that drifted would be the one he typed into and the one that clamped it.
export const SPECS: Record<AnimChannel, Spec> = {
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
  volume: { min: -60, max: MAX_GAIN_DB, step: 0.5, sens: 0.2 },
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

/** Section label: small, letterspaced, uppercase, muted (spec 2.3 hierarchy). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{children}</h3>
  )
}

/**
 * One property row on the shared inspector grid (spec 3.2): lead toggle,
 * label, control cluster, reset. Empty zones still occupy their tracks, so
 * labels, value fields and reset buttons land on the same columns in every
 * panel that renders property rows.
 */
export function PropRow({
  lead,
  label,
  labelTitle,
  labelFor,
  onLabelDoubleClick,
  onReset,
  resetLabel,
  children,
  className = '',
  ...rest
}: {
  /** Leading 24px zone: stopwatch / enable toggle. Empty keeps the indent. */
  lead?: ReactNode
  label: string
  labelTitle?: string
  /** Render the label as a <label htmlFor> so clicking it drives the control. */
  labelFor?: string
  onLabelDoubleClick?: () => void
  /** Far-right reset zone; omitted, the 24px track stays reserved but empty. */
  onReset?: () => void
  resetLabel?: string
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const labelCls = 'cursor-default truncate text-ui text-text-secondary'
  return (
    <div
      className={`grid min-h-6 grid-cols-[24px_minmax(0,1fr)_auto_24px] items-center gap-x-1 ${className}`}
      {...rest}
    >
      <span className="flex h-6 items-center">{lead}</span>
      {labelFor ? (
        <label htmlFor={labelFor} title={labelTitle ?? label} onDoubleClick={onLabelDoubleClick} className={labelCls}>
          {label}
        </label>
      ) : (
        <span title={labelTitle ?? label} onDoubleClick={onLabelDoubleClick} className={labelCls}>
          {label}
        </span>
      )}
      <div className="flex min-w-0 items-center justify-end gap-1">{children}</div>
      <span className="flex h-6 items-center justify-end">
        {onReset && (
          <IconButton label={resetLabel ?? `Reset ${label}`} size="compact" onClick={onReset}>
            <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </span>
    </div>
  )
}

/**
 * Scrubbable numeric field: click-drag horizontally to change (dx * step *
 * sensitivity), type to set. Enter/blur commits; Escape reverts; double-click
 * or focus enters text-edit. Commits only fire when the value actually moved.
 *
 * A typed value is never lost by leaving the field: clicking the next clip
 * commits it, with no Enter needed. The edit is frozen to the clip that owned
 * the field when typing STARTED (see pendingEdit), so that commit can never
 * land on the clip that was selected afterwards.
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
  // The open edit and its owner. One holder for the life of the field - the
  // props around it change under it, that is the whole point.
  const pendingRef = useRef<PendingEdit | null>(null)
  if (!pendingRef.current) pendingRef.current = createPendingEdit()
  const pending = pendingRef.current

  // Reflect external value changes (playhead move, undo) unless mid-edit.
  useEffect(() => {
    if (!editing) setText(fmt(value))
  }, [value, editing])

  // A field can go away without ever blurring (the clip deselected, a section
  // folded), and browsers fire no blur for a focused element that is removed.
  // Flush there too, or the typed value dies with the panel.
  useEffect(() => () => void pending.flush(), [pending])

  const normalize = (v: number) => clamp(roundStep(v, spec.step), spec.min, spec.max)

  const commit = (v: number) => {
    const next = normalize(v)
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
      // Drop focus so the NEXT drag scrubs too - a focused field used to be
      // stuck in edit mode, making drag-scrub one-shot per field.
      inputRef.current?.blur()
    } else {
      // A genuine click (no movement) enters text-edit - same UX as before,
      // but decided here instead of by focus (which pointerdown also fires).
      enterEdit()
    }
  }

  const enterEdit = () => {
    setEditing(true)
    // Freeze who this edit is for, before any selection change can swap the
    // props. Already open (focus, then a double-click) keeps the first owner.
    pending.begin({ onCommit, base: value, normalize })
    // Select-all so a fresh typed value replaces the old one.
    requestAnimationFrame(() => inputRef.current?.select())
  }

  const commitTyped = () => {
    setEditing(false)
    // Leaving edit re-runs the sync effect above, so invalid or unchanged text
    // is redrawn from the live value without a second setText here.
    pending.flush()
  }

  // Position-in-range fill: 0% at min, 100% at max. Finite ranges only - a
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
        // The fill bar says WHERE in the range he is and never says what the
        // range IS, so a value that will not move any further looks broken.
        // Hovering now answers it, everywhere a scrub field appears.
        title={`${ariaLabel}: ${fmt(spec.min)} to ${fmt(spec.max)} (drag to change, Shift for fine)`}
        value={text}
        readOnly={!editing}
        onChange={(e) => {
          setText(e.target.value)
          pending.type(e.target.value)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={enterEdit}
        // Keyboard/tab focus enters edit; a pointer-initiated focus does not
        // (draggingRef is already set by onPointerDown) - endDrag decides
        // between click→edit and drag→scrub instead.
        onFocus={() => {
          if (!draggingRef.current) enterEdit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitTyped()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            // Abandon: the blur below, and any later unmount, write nothing.
            pending.cancel()
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
            // The nudge committed on its own; re-baseline so the blur after it
            // does not commit the same number again as a second undo step.
            pending.settle(next)
          }
        }}
        onBlur={() => editing && commitTyped()}
        className={`h-6 w-full rounded-field bg-bg-input px-2 text-right font-numeric text-ui-sm text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated ${
          editing ? 'cursor-text' : 'cursor-ew-resize'
        }`}
      />
      {/* Slider fill - a bounded param now shows where it sits in its range. */}
      {!editing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-1.5 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-border"
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
  // The lane and its curve editor are hand controls: they draw only while the
  // shelf's 'Tune it by hand' is open. The keyframes are always there.
  const { lanesVisible } = useMotionRail()
  // Local playhead time, clamped to the clip span (mirrors playheadLocalT);
  // derived from the reactive playheadS prop so the field tracks the playhead.
  const durS = Math.max(0, clipEndS(clip) - clip.startS)
  const localT = Math.max(0, Math.min(playheadS - clip.startS, durS))
  const value = resolveChannel(clip, channel, localT)

  const kfs = channelKeyframes(clip, channel)
  const onKf = animated && kfs.some((k) => Math.abs(k.t - localT) <= 0.05)

  const gotoT = (t: number) => {
    // Move the playhead to a keyframe (absolute sequence time).
    useStore.getState().setUI({ playheadS: clip.startS + t })
  }

  // PropRow itself is untouched: the lane is a SIBLING in this wrapper, so it
  // spans the rail's full width instead of starting at the row's value column.
  return (
    <div className="flex flex-col gap-1">
      <PropRow
        data-testid={`channel-${channel}`}
        label={LABELS[channel]}
        labelTitle={`${LABELS[channel]} (double-click to reset)`}
        onLabelDoubleClick={() => resetChannel(clip.id, channel)}
        onReset={() => resetChannel(clip.id, channel)}
        resetLabel={`Reset ${LABELS[channel]}`}
        lead={
          <IconButton
            label={animated ? `Disable ${LABELS[channel]} keyframes` : `Animate ${LABELS[channel]}`}
            active={animated}
            size="compact"
            data-testid={`stopwatch-${channel}`}
            onClick={() => toggleChannelAnimation(clip.id, channel)}
          >
            <Clock size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      >
        {animated && (
          <KeyframeNav
            kfs={kfs}
            localT={localT}
            onGoto={gotoT}
            onKf={onKf}
            onToggleKf={() =>
              onKf ? removeKeyframeAtPlayhead(clip.id, channel) : addKeyframeAtPlayhead(clip.id, channel)
            }
          />
        )}
        <ScrubField
          value={value}
          spec={spec}
          testId={`field-${channel}`}
          ariaLabel={LABELS[channel]}
          onCommit={(v) => setChannel(clip.id, channel, v)}
        />
      </PropRow>
      {animated && lanesVisible && (
        <>
          <KeyframeTrack clip={clip} channel={channel} />
          {/* Draws only for the segment that is actually selected, and only on
              this property: it decides that from the rail, not from a flag here. */}
          <CurveEditor clip={clip} channel={channel} />
        </>
      )}
    </div>
  )
}

/**
 * Zoom INSIDE the picture: the footage magnifies, its rectangle does not move.
 *
 * His ask, 2026-08-16. On a 9:16 short, Scale grows the picture out over the
 * blurred bands and changes the whole framing; this holds the framing and pushes
 * into the shot, and the backdrop behind it never so much as flickers.
 *
 * It writes the four crops together (see clipEdits), so its keyframes are
 * ordinary crop keyframes: they draw lanes, they survive a cut, they export.
 */
function InnerZoomRow({ clip, playheadS }: { clip: Clip; playheadS: number }) {
  const durS = Math.max(0, clipEndS(clip) - clip.startS)
  const localT = Math.max(0, Math.min(playheadS - clip.startS, durS))
  const animated = isInnerZoomAnimated(clip)
  const owns = innerZoomOwnsCrop(clip, localT)
  const zoom = innerZoomAt(clip, localT)
  const kfs = innerZoomKeyframes(clip)
  const onKf = animated && kfs.some((k) => Math.abs(k.t - localT) <= 0.05)

  return (
    <PropRow
      data-testid="channel-innerZoom"
      label="Zoom inside"
      labelTitle={
        owns
          ? 'Zoom inside the picture: the shot gets closer, the picture stays exactly where it is and the blur behind it never changes (double-click to reset)'
          : 'The crops were set one at a time, so this cannot speak for them. Setting it here evens them up again.'
      }
      onLabelDoubleClick={() => setInnerZoomAtPlayhead(clip.id, 1)}
      onReset={() => setInnerZoomAtPlayhead(clip.id, 1)}
      resetLabel="Reset zoom inside"
      lead={
        <IconButton
          label={animated ? 'Disable zoom inside keyframes' : 'Animate zoom inside'}
          active={animated}
          size="compact"
          data-testid="stopwatch-innerZoom"
          onClick={() => toggleInnerZoomAnimation(clip.id)}
        >
          <Clock size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
      }
    >
      {animated && (
        <KeyframeNav
          kfs={kfs}
          localT={localT}
          onGoto={(t) => useStore.getState().setUI({ playheadS: clip.startS + t })}
          onKf={onKf}
          onToggleKf={() =>
            onKf ? removeInnerZoomKeyframeAtPlayhead(clip.id) : addInnerZoomKeyframeAtPlayhead(clip.id)
          }
        />
      )}
      <ScrubField
        value={zoom}
        spec={INNER_ZOOM}
        testId="field-innerZoom"
        ariaLabel="Zoom inside"
        onCommit={(v) => setInnerZoomAtPlayhead(clip.id, v)}
      />
    </PropRow>
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
        <SectionLabel>{title}</SectionLabel>
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
      <div className="flex flex-col gap-1">
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

/**
 * The channel address of an effect param, when it has one.
 *
 * A lane speaks CHANNELS, and a channel resolves to the FIRST effect of its
 * type in the stack (channels.ts). So the params that carry a legacy channel
 * address get a lane, and a SECOND copy of the same effect gets none rather
 * than a lane that quietly retimes its neighbour's keyframes. Every param keeps
 * its KeyframeNav either way.
 */
export function paramChannel(clip: Clip, effect: EffectInstance, paramKey: string): AnimChannel | null {
  const channel = (Object.keys(CHANNEL_EFFECT) as AnimChannel[]).find((ch) => {
    const addr = CHANNEL_EFFECT[ch]
    return addr !== undefined && addr.type === effect.type && addr.param === paramKey
  })
  if (!channel) return null
  return clip.effects.find((e) => e.type === effect.type)?.id === effect.id ? channel : null
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
  const lane = animated ? paramChannel(clip, effect, param.key) : null
  const { lanesVisible } = useMotionRail()
  const value = resolveParam(effect, param.key, localT)
  const kfs = paramKeyframes(effect, param.key)
  const onKf = animated && kfs.some((k) => Math.abs(k.t - localT) <= 0.05)
  const spec: Spec = { min: param.min, max: param.max, step: param.step, sens: paramSens(param) }

  const gotoT = (t: number) => useStore.getState().setUI({ playheadS: clip.startS + t })

  return (
    <div className="flex flex-col gap-1">
      <PropRow
        data-testid={`channel-${param.key}`}
        data-effect-id={effect.id}
        label={param.label}
        labelTitle={`${param.label} (double-click to reset)`}
        onLabelDoubleClick={() => setEffectParamValue(clip.id, effect.id, param.key, param.default)}
        onReset={() => setEffectParamValue(clip.id, effect.id, param.key, param.default)}
        resetLabel={`Reset ${param.label}`}
        lead={
          <IconButton
            label={animated ? `Disable ${param.label} keyframes` : `Animate ${param.label}`}
            active={animated}
            size="compact"
            data-testid={`stopwatch-${param.key}`}
            onClick={() => toggleEffectParamKeyframes(clip.id, effect.id, param.key)}
          >
            <Clock size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      >
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
      </PropRow>
      {lane && lanesVisible && (
        <>
          <KeyframeTrack clip={clip} channel={lane} />
          <CurveEditor clip={clip} channel={lane} />
        </>
      )}
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
  // Both hooks sit ABOVE the unknown-effect return. An early return over them
  // would change the hook order between one card and the next.
  const folded = useEffectFold((s) => s.folded[effect.id] === true)
  const [dragOver, setDragOver] = useState(false)

  // An effect type the registry no longer knows: show it honestly, let it be
  // removed, but never pretend to render controls for it.
  if (!def) {
    return (
      <div className="rounded-field border border-border bg-bg-elevated p-2" data-testid="effect-card">
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-ui text-text-secondary">Unknown effect: {effect.type}</span>
          <IconButton label="Remove effect" size="compact" onClick={() => deleteEffect(clip.id, effect.id)}>
            <X size={13} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      </div>
    )
  }

  // Reordering by drag. The card is the TARGET and the name is the GRIP, so a
  // drag that starts on a scrub field still scrubs. The chevrons stay: they are
  // the keyboard-reachable way to do the same thing.
  const onCardDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasType(e.dataTransfer.types, EFFECT_CARD_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }
  // dragleave fires crossing the card's own children too, which would flicker.
  const onCardDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && e.currentTarget.contains(to)) return
    setDragOver(false)
  }
  const onCardDrop = (e: DragEvent<HTMLDivElement>) => {
    const dragged = e.dataTransfer.getData(EFFECT_CARD_MIME)
    setDragOver(false)
    if (!dragged || dragged === effect.id) return
    e.preventDefault()
    e.stopPropagation()
    reorderEffect(clip.id, dragged, index)
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-field border bg-bg-elevated p-2 ${
        dragOver ? 'border-accent' : 'border-border'
      }`}
      data-testid="effect-card"
      data-effect-type={effect.type}
      data-effect-id={effect.id}
      data-folded={folded ? 'true' : undefined}
      onDragOver={onCardDragOver}
      onDragLeave={onCardDragLeave}
      onDrop={onCardDrop}
    >
      <div className="flex items-center gap-1">
        <IconButton
          label={folded ? `Open ${def.label}` : `Fold ${def.label}`}
          size="compact"
          data-testid="effect-fold"
          onClick={() => toggleEffectFold(effect.id)}
        >
          {folded ? (
            <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
          )}
        </IconButton>
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
          draggable
          data-testid="effect-grip"
          onDragStart={(e) => {
            e.dataTransfer.setData(EFFECT_CARD_MIME, effect.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => setDragOver(false)}
          title={`${def.description} (drag to reorder)`}
          className={`flex-1 cursor-grab truncate text-ui font-medium active:cursor-grabbing ${
            effect.enabled ? 'text-text-primary' : 'text-text-muted line-through'
          }`}
        >
          {def.label}
        </span>
        {/* A switched-off effect still takes his drags, and it should: the value
            he sets now is the value that arrives when he switches it back on.
            What was missing was the REASON the picture did not move. The word
            says it, and the word is also the switch back on. Blocking the rows
            instead would have cost him the curve editor on a bypassed effect,
            which is a worse trade than a moment of confusion. */}
        {!effect.enabled && (
          <button
            type="button"
            data-testid="effect-off-chip"
            title={`${def.label} is switched off, so it is not in the picture. Click to turn it back on.`}
            onClick={() => toggleEffectEnabled(clip.id, effect.id)}
            className="shrink-0 rounded-full border border-border-strong px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors duration-[120ms] hover:border-accent hover:text-accent"
          >
            Off
          </button>
        )}
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

      {!folded && (
        <div className={`flex flex-col gap-1 ${effect.enabled ? '' : 'opacity-40'}`}>
          {def.params.map((param) => (
            <EffectParamRow key={param.key} clip={clip} effect={effect} param={param} localT={localT} />
          ))}
          <EffectEaseRow clip={clip} effect={effect} />
        </div>
      )}
    </div>
  )
}

/**
 * Ease the effect in at the head of the clip, or out at its tail.
 *
 * His words, 2026-08-06: "I selected a blur, but can I somehow make it so it
 * transitions into the blur?" It was already possible and undiscoverable:
 * keyframe the radius by hand, twice, at the right two moments.
 *
 * These buttons write those keyframes for every param at once, from the
 * registry's own neutral value. They are not a separate mode: the diamonds
 * appear on the rows above and he can drag them afterwards like any others.
 */
function EffectEaseRow({ clip, effect }: { clip: Clip; effect: EffectInstance }) {
  const ramped = isEffectRamped(clip, effect.id)
  // App-level, not component state: the length he dialled in has to outlive the
  // card, which unmounts the moment he clicks the next clip. See settings.ts.
  const seconds = useSettings((s) => s.easeSeconds)
  return (
    <div className="mt-0.5 flex items-center gap-1.5 border-t border-border pt-1.5" data-testid="effect-ease">
      <span className="text-ui-sm text-text-secondary">Ease</span>
      <button
        type="button"
        data-testid="effect-ease-in"
        onClick={() => rampEffect(clip.id, effect.id, 'in', seconds)}
        className="rounded-field bg-bg-input px-2 py-0.5 text-ui-sm text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated"
      >
        In
      </button>
      <button
        type="button"
        data-testid="effect-ease-out"
        onClick={() => rampEffect(clip.id, effect.id, 'out', seconds)}
        className="rounded-field bg-bg-input px-2 py-0.5 text-ui-sm text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated"
      >
        Out
      </button>
      <ScrubField
        value={seconds}
        spec={EASE_SECONDS}
        ariaLabel="Ease length in seconds"
        testId="effect-ease-seconds"
        onCommit={setEaseSeconds}
      />
      <span className="text-ui-sm text-text-secondary">s</span>
      {ramped && (
        <IconButton
          label="Remove effect ease"
          size="compact"
          data-testid="effect-ease-clear"
          onClick={() => clearEffectRamp(clip.id, effect.id)}
        >
          <X size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
      )}
    </div>
  )
}

function EffectStack({ clip, playheadS }: { clip: Clip; playheadS: number }) {
  const durS = Math.max(0, clipEndS(clip) - clip.startS)
  const localT = Math.max(0, Math.min(playheadS - clip.startS, durS))
  // The WHOLE section takes the drop, not a thin strip: the header, the empty
  // card that makes the promise, and every card already in the stack. Anywhere
  // sensible in this block is somewhere he might let go.
  const { hot, dropProps } = useEffectDrop([clip.id])
  const folded = useEffectFold((s) => s.folded)
  const ids = clip.effects.map((e) => e.id)
  const everyFolded = allFolded(folded, ids)
  // Any one still live means the button's job is to turn the look OFF.
  const anyEnabled = clip.effects.some((e) => e.enabled)
  const recentTypes = useRecentEffects((s) => s.types)
  const recent = recentTypes
    .map((t) => BROWSABLE_EFFECTS.find((ef) => ef.type === t))
    .filter((ef): ef is (typeof BROWSABLE_EFFECTS)[number] => ef !== undefined)

  return (
    <section
      className={`flex flex-col gap-2 rounded-field ${hot ? 'ring-2 ring-inset ring-accent-hover' : ''}`}
      data-testid="effect-stack"
      data-drop-hot={hot ? 'true' : undefined}
      {...dropProps}
    >
      <div className="flex items-center gap-1.5">
        <SectionLabel>Effects</SectionLabel>
        <span className="ml-auto flex items-center gap-1">
          {clip.effects.length > 0 && (
            <>
              <IconButton
                label={everyFolded ? 'Open every effect' : 'Fold every effect'}
                size="compact"
                data-testid="fold-all-effects"
                onClick={() => setEffectsFolded(ids, !everyFolded)}
              >
                {everyFolded ? (
                  <ChevronsUpDown size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronsDownUp size={13} strokeWidth={1.75} aria-hidden />
                )}
              </IconButton>
              {/* The A/B. One click to see the footage underneath the whole
                  look, one click to put it back, and it is a single undo step
                  either way rather than one per effect. */}
              <IconButton
                label={anyEnabled ? 'Turn every effect off' : 'Turn every effect on'}
                shortcut="Shift+B"
                active={!anyEnabled}
                size="compact"
                data-testid="bypass-all-effects"
                className={anyEnabled ? '' : 'bg-accent-quiet! text-accent!'}
                onClick={() => setAllEffectsEnabled(clip.id, !anyEnabled)}
              >
                {anyEnabled ? (
                  <Eye size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <EyeOff size={13} strokeWidth={1.75} aria-hidden />
                )}
              </IconButton>
              <IconButton
                label="Reset every effect"
                size="compact"
                data-testid="reset-all-effects"
                onClick={() => resetAllEffectParams(clip.id)}
              >
                <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
              </IconButton>
            </>
          )}
          {/* Add an effect without leaving for the Effects tab. */}
          <select
            aria-label="Add effect"
            data-testid="inspector-add-effect"
            value=""
            onChange={(e) => {
              if (e.target.value) applyEffect(clip.id, e.target.value)
            }}
            className="h-6 cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-secondary"
          >
            <option value="">+ Add effect…</option>
            {/* The ones he actually reaches for, at the top. Filtered against
                the registry so a type that stopped being browsable cannot
                linger here as an option that adds nothing. */}
            {recent.length > 0 && (
              <optgroup label="Recent">
                {recent.map((ef) => (
                  <option key={`recent-${ef.type}`} value={ef.type}>
                    {ef.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="All effects">
              {BROWSABLE_EFFECTS.map((ef) => (
                // The browser panel shows each effect's description and this
                // list showed none, so the same effect was two different amounts
                // of explained depending on which door he came through.
                <option key={ef.type} value={ef.type} title={ef.description}>
                  {ef.label}
                </option>
              ))}
            </optgroup>
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
          data-drop-hot={hot ? 'true' : undefined}
          // The card is what he aims at, so the card is what answers: the same
          // dashed-accent-on-quiet-fill the media import overlay uses to say
          // "let go here".
          className={`flex flex-col items-center gap-1.5 rounded-field border border-dashed px-2 py-4 text-center transition-colors duration-[120ms] ${
            hot ? 'border-accent bg-accent-quiet' : 'border-border-strong'
          }`}
        >
          <Sparkles size={18} strokeWidth={1.5} className={hot ? 'text-accent' : 'text-text-muted'} aria-hidden />
          <div className="text-ui-sm text-text-secondary">No effects applied</div>
          <div className="text-dense text-text-muted">Drag one from the Effects panel, or double-click it</div>
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
    <PropRow label={edge === 'in' ? 'In' : 'Out'}>
      <select
        data-testid={testId}
        aria-label={`${edge === 'in' ? 'In' : 'Out'} transition`}
        value={kind}
        onChange={(e) => onKind(e.target.value)}
        className="h-6 w-[104px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
      >
        <option value={NONE}>None</option>
        {TRANSITION_KINDS.map((k) => (
          <option key={k} value={k}>
            {TRANSITION_LABELS[k]}
          </option>
        ))}
      </select>
      {kind === NONE ? (
        <span aria-hidden className="w-[68px] shrink-0" />
      ) : (
        <ScrubField
          value={durationS}
          // whiteFlash scrubs inside its tight 100-500 ms envelope with a finer
          // step; other kinds keep the classic 0.1-10 s range.
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
    </PropRow>
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
    <section className="flex flex-col gap-2">
      <SectionLabel>Mask</SectionLabel>
      <div className="flex flex-col gap-1">
        <PropRow label="Shape">
          <select
            data-testid="mask-kind"
            aria-label="Mask shape"
            value={mask?.kind ?? 'none'}
            onChange={(e) => onKind(e.target.value)}
            className="h-6 w-[132px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
          >
            <option value="none">None</option>
            <option value="rect">Rectangle</option>
            <option value="ellipse">Ellipse</option>
          </select>
        </PropRow>
        {mask && (
          <PropRow
            label="Invert"
            labelFor="mask-invert-toggle"
            lead={
              <input
                type="checkbox"
                id="mask-invert-toggle"
                data-testid="mask-invert"
                aria-label="Invert mask"
                checked={mask.invert}
                onChange={(e) => setClipMask(clip.id, { ...mask, invert: e.target.checked })}
                className="ml-1 accent-accent"
              />
            }
          />
        )}
        {mask &&
          MASK_FIELDS.map((f) => (
            <PropRow
              key={f.key}
              label={f.label}
              onReset={() => setClipMask(clip.id, { ...mask, [f.key]: DEFAULT_MASK[f.key] })}
              resetLabel={`Reset mask ${f.label}`}
            >
              <ScrubField
                value={mask[f.key]}
                spec={{ min: 0, max: f.max, step: 0.01, sens: 0.003 }}
                testId={`mask-${f.key}`}
                ariaLabel={`Mask ${f.label}`}
                onCommit={(v) => setClipMask(clip.id, { ...mask, [f.key]: v })}
              />
            </PropRow>
          ))}
      </div>
    </section>
  )
}

export function EffectControls({
  clip,
  playheadS,
  fps,
  afterStack,
}: {
  clip: Clip
  fps?: number
  playheadS: number
  /** Rendered between the effects stack and Transitions - the Inspector slots
   *  Speed here (title clips pass nothing: they have no speed). */
  afterStack?: ReactNode
}) {
  // Ranked by reach-for frequency (David, 2026-07-19): effects stack, Speed
  // (slot), Transitions, Zoom/Punch, Transform, then Opacity/Blend/Crop/Mask.
  // MOTION IS HOISTED ABOVE THE STACK as of the keyframes pass, which reverses
  // that ranking: his 2026-08-06 brief opens the panel on the motion desk, and
  // the ranking was set when this block was a depth picker with one button.
  // Everything else keeps its 2026-07-19 order. One edit moves it back.
  //
  // Adjustment layers render ONLY effects/mask/opacity (resolve.ts builds the
  // op from just those) - transform, crop, blend and punch would be inert
  // document edits, so they are hidden with a hint instead.
  const isAdjustment = clip.adjustment === true
  // The rail needs a real frame rate to snap to. The Inspector always passes the
  // sequence's; the fallback matches the one it uses for its own playhead quantize.
  const railFps = fps && fps > 0 ? fps : 30
  // The lanes, the ruler and the curve editor are hand controls now: still
  // wired, still tested, one click away under the shelf, and no longer the first
  // thing he sees when he clicks a clip.
  const handTuneOpen = useStore((s) => s.ui.handTuneOpen)
  return (
    <div className="flex flex-col gap-5">
      {isAdjustment && (
        <p className="rounded-field bg-bg-input px-2 py-1.5 text-ui-sm leading-snug text-text-muted">
          Adjustment layer: its effects, mask and opacity grade everything below it.
        </p>
      )}
      {/* THE FRONT DOOR. Ten finished moves with plain names, one slider, and
          the hand controls folded away underneath. */}
      {!isAdjustment && <MoveShelf clips={[clip]} />}
      {!isAdjustment && handTuneOpen && (
        <PunchControl
          clipId={clip.id}
          headerAction={
            // A move is nothing but keyframes - give it the same escape hatch an
            // effect card's X offers. Gated on ALL THREE move channels, not scale
            // alone: a punch writes position too, so gating on scale meant the
            // button vanished while the clip was still left sitting off centre.
            MOVE_CHANNELS.some((ch) => isChannelAnimated(clip, ch)) ? (
              <button
                type="button"
                data-testid="punch-remove"
                title="Clears the move's keyframes - the clip keeps the size and position it has standing still"
                className="flex h-5 items-center gap-1 rounded-field bg-bg-input px-1.5 text-dense text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
                onClick={() => removeZoom(clip.id)}
              >
                <X size={11} strokeWidth={1.75} aria-hidden />
                Clear motion
              </button>
            ) : undefined
          }
        />
      )}
      {/* ONE rail for the whole body: the effect stack, Transform, Opacity and
          Crop all hang off the same ruler, so a lane under an effect param and a
          lane under Zoom can never disagree about where a moment is. The ruler
          lands directly under the Motion block, which is the order his brief
          describes: the chips and the move buttons, then the clip's own time. */}
      <MotionRail clip={clip} fps={railFps} lanes={handTuneOpen}>
        <div className="flex flex-col gap-5">
          <EffectStack clip={clip} playheadS={playheadS} />
          {afterStack && (
            <>
              <div className="h-px bg-border" />
              {afterStack}
            </>
          )}
          <div className="h-px bg-border" />
          <section className="flex flex-col gap-2">
            <SectionLabel>Transitions</SectionLabel>
            <div className="flex flex-col gap-1">
              <TransitionRow clip={clip} edge="in" testId="transition-in" />
              <TransitionRow clip={clip} edge="out" testId="transition-out" />
            </div>
          </section>
          <div className="h-px bg-border" />
          {!isAdjustment && (
            <>
              <Section
                title="Transform"
                channels={['posX', 'posY', 'scale', 'rotation', 'anchorX', 'anchorY']}
                clip={clip}
                playheadS={playheadS}
              />
              {/* Directly under Scale, because that is where he looks for a zoom
                  and because the difference between the two is the point. */}
              <InnerZoomRow clip={clip} playheadS={playheadS} />
              <div className="h-px bg-border" />
            </>
          )}
          <Section title="Opacity" channels={['opacity']} clip={clip} playheadS={playheadS} />
          {!isAdjustment && (
            <>
              <PropRow label="Blend">
                <select
                  data-testid="blend-mode"
                  aria-label="Blend mode"
                  value={clip.blendMode ?? 'normal'}
                  onChange={(e) => setClipBlendMode(clip.id, e.target.value as BlendMode)}
                  className="h-6 w-[132px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary"
                >
                  {BLEND_MODES.map((m) => (
                    <option key={m} value={m}>
                      {BLEND_LABELS[m]}
                    </option>
                  ))}
                </select>
              </PropRow>
              <div className="h-px bg-border" />
              <Section title="Crop" channels={['cropT', 'cropR', 'cropB', 'cropL']} clip={clip} playheadS={playheadS} />
            </>
          )}
          <div className="h-px bg-border" />
          <MaskSection clip={clip} />
        </div>
      </MotionRail>
    </div>
  )
}
