// The curve editor, and it opens on a SEGMENT, never on a keyframe.
//
// That is the whole design. Premiere's oldest naming problem is whether "Ease
// Out" belongs to the keyframe a move leaves or the one it lands on; here the
// thing he clicked IS the thing he is shaping, so the question never gets asked.
// The header says so out loud in his own numbers: "Zoom 100 to 120 over 5f".
//
// The y axis is drawn from -0.25 to 1.25 rather than 0 to 1, so a curve that
// travels past its target and settles back is VISIBLE instead of clipped flat
// against the top line. Overshoot is the point of a snap, not an error.
//
// A segment carrying no curve draws its named ease as a dashed ghost with the
// handles seeded there, which is what makes an old project open looking exactly
// as it always did and upgrade the moment he touches a handle.
//
// The five named eases live here too, under the six curve chips, with one line
// of prose saying what the active shape does. They came out of the lane WITH the
// easing itself: "what is Lin" has to be answerable where easing is chosen, and
// 'hold' can only live here, because it is a step and no bezier is a step.

import { RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { channelKeyframes } from '../engine/effects/channels'
import { bezierEase, ease, MOMENT_EPS } from '../engine/keyframes'
import { MOTION_CURVES, type MotionCurveName } from '../engine/motion'
import type { AnimChannel, Clip, Curve, Keyframe } from '../engine/types'
import { setSegmentCurve, setSegmentEase } from '../state/clipEdits'
import { IconButton } from '../ui/Button'
import { friendly as friendlyChannelName } from './keyframeMarks'
import { useMotionRail } from './MotionRail'

// --- geometry ---------------------------------------------------------------

/** The unit square: x 0..1 across W px, y 0..1 up H px. */
const W = 220
const H = 140
/** Drawn y range. The extra quarter at each end is where overshoot lives. */
const Y_MIN = -0.25
const Y_MAX = 1.25
/** Full graph height once the -0.25..1.25 band is drawn at H px per unit. */
const GRAPH_H = H * (Y_MAX - Y_MIN)
/** Breathing room so a handle sitting exactly on x=0 or x=1 is not half cut off. */
const PAD = 8
/** Handles snap to this, so a typed curve and a dragged one land on the same grid. */
const SNAP = 0.01
/** The velocity strip is read-only and sampled at exactly this many points. */
const VELOCITY_SAMPLES = 64

const gx = (x: number): number => x * W
const gy = (y: number): number => (Y_MAX - y) * H

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const snap = (v: number): number => Math.round(v / SNAP) * SNAP

// --- naming -----------------------------------------------------------------

// "scale" reads as Zoom, which is the word he uses and the one in the header he
// asked for.
//
// ⛔ This file used to type the whole 22 entry list out again, under a comment
// saying "same list the lanes label their rows with". They were the same, letter
// for letter, on 2026-08-12. That is luck: renaming a channel in one of them
// puts one name on the keyframe lane and a different name in the curve editor
// header, on the same clip, and only one of the two copies had a test. It reads
// the lanes' own list now.
const friendly = friendlyChannelName

/** Channels a person reads as a percentage: 1.2 is "120", not "1.2". */
const PERCENT: Partial<Record<AnimChannel, true>> = {
  scale: true,
  opacity: true,
  cropT: true,
  cropR: true,
  cropB: true,
  cropL: true,
}

/** The value as it appears in the header, in the units he thinks in. */
export function formatChannelValue(channel: AnimChannel, v: number): string {
  if (!Number.isFinite(v)) return '0'
  return String(PERCENT[channel] ? Math.round(v * 100) : Math.round(v * 100) / 100)
}

/** "Zoom 100 to 120 over 5f": the real numbers of the segment he clicked. */
export function segmentHeader(channel: AnimChannel, from: number, to: number, frames: number): string {
  return `${friendly(channel)} ${formatChannelValue(channel, from)} to ${formatChannelValue(channel, to)} over ${frames}f`
}

/** The chip captions. Exported so the Motion header's curve row says the same
 *  words about the same numbers, rather than growing a second list. */
export const CURVE_LABEL: Record<MotionCurveName, string> = {
  snapIn: 'Snap',
  settle: 'Settle',
  smooth: 'Smooth',
  windUp: 'Wind up',
  overshoot: 'Overshoot',
  easyEase: 'Easy ease',
}

// --- the explainer ----------------------------------------------------------
//
// Easing moved here from the lane, and the plain-language answer moved WITH it.
// A row of six words and four bezier numbers is not an explanation: "Snap" and
// "Lin" both need someone to say what the frame actually does, in his words,
// where he is looking. That is what these three tables and the one line of
// prose under the chips are for.

/** The five named eases, in the order the lane used to list them. */
export const EASE_ORDER: readonly Keyframe['ease'][] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']

/** The short caption on an ease button. Unchanged from the lane. */
export const EASE_LABEL: Record<Keyframe['ease'], string> = {
  linear: 'Lin',
  hold: 'Hold',
  easeIn: 'In',
  easeOut: 'Out',
  easeInOut: 'InOut',
}

/** What each named shape DOES. "Lin" on a 30px button answers nothing. */
export const EASE_HELP: Record<Keyframe['ease'], string> = {
  linear: 'Linear: constant speed the whole way (even, mechanical).',
  hold: 'Hold: freeze on this value, then snap to the next (no motion between).',
  easeIn: 'Ease In: starts slow, then speeds up (winds up).',
  easeOut: 'Ease Out: starts fast, then settles. Best for punch-ins landing.',
  easeInOut: 'Ease In-Out: slow at both ends, fast in the middle (most natural).',
}

/** The same answer for the six curve chips, which name a shape and otherwise
 *  explain nothing. Keyed off MOTION_CURVES so a new curve cannot ship mute. */
export const CURVE_HELP: Record<MotionCurveName, string> = {
  snapIn: 'Snap: leaves fast and lands soft. The punch.',
  settle: 'Settle: the same fast leave with a gentler landing. The reveal.',
  smooth: 'Smooth: eases out of the start and into the end, quickest in the middle. The slow push.',
  windUp: 'Wind up: starts slow, then accelerates all the way out. The whip out.',
  overshoot: 'Overshoot: travels past the target and comes back. Bouncy on purpose.',
  easyEase: 'Easy ease: soft at both ends, the safe default (33 percent both sides).',
}

/** A hand-dragged shape has no name, so it gets the one honest sentence. */
export const CUSTOM_HELP = 'Custom: a shape you dragged. Reset it to hand this move back to its named ease.'

/** The shape sketched beside each name, the way the lane drew it. */
const EASE_GLYPH: Record<Keyframe['ease'], string> = {
  linear: 'M1 9 L11 1',
  hold: 'M1 9 L6 9 L6 1 L11 1',
  easeIn: 'M1 9 C6 9 9 6 11 1',
  easeOut: 'M1 9 C3 4 6 1 11 1',
  easeInOut: 'M1 9 C5 9 7 1 11 1',
}

// --- curves -----------------------------------------------------------------

/**
 * Where the handles START on a segment that has no curve of its own: the
 * conventional cubic-bezier standing in for each named ease.
 *
 * These are seeds for the HANDLES only. The dashed ghost is drawn from the real
 * `ease()` the renderer runs, so what he sees before he touches anything is
 * exactly what the segment does today.
 */
export const EASE_SEED: Record<Keyframe['ease'], Curve> = {
  linear: [0, 0, 1, 1],
  // A step cannot be a bezier. Handles pinned right hold the value flat and
  // arrive at the very end, which is the closest a draggable curve gets.
  hold: [1, 0, 1, 0],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
}

/** Parse '0.16, 1, 0.3, 1' or 'cubic-bezier(0.16, 1, 0.3, 1)' off easings.net. */
export function parseCurveText(raw: string): Curve | null {
  const parts = raw
    .replace(/cubic-bezier/gi, ' ')
    .replace(/[()[\]]/g, ' ')
    .split(/[\s,;]+/)
    .filter(Boolean)
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

/** The text field's rendering of a curve: what easings.net would print. */
export function formatCurve(c: Curve): string {
  return c.map((n) => String(Math.round(n * 1000) / 1000)).join(', ')
}

const curveEq = (a: Curve | undefined, b: Curve | undefined): boolean =>
  !!a && !!b && a.every((n, i) => Math.abs(n - b[i]) < 5e-4)

/** Which of the six a curve IS, if any. A hand-dragged shape answers null. */
export function curveName(c: Curve | undefined): MotionCurveName | null {
  if (!c) return null
  for (const n of Object.keys(MOTION_CURVES) as MotionCurveName[]) {
    if (curveEq(c, MOTION_CURVES[n])) return n
  }
  return null
}

/**
 * The one line of prose under the chips: what the segment in front of him does.
 * It follows the same precedence the renderer does, curve over named ease, so it
 * can never describe a shape nothing is running.
 */
export function easeExplainer(curve: Curve | undefined, ease: Keyframe['ease']): string {
  if (!curve) return EASE_HELP[ease] ?? EASE_HELP.linear
  const name = curveName(curve)
  return name ? CURVE_HELP[name] : CUSTOM_HELP
}

/** The shape sketch beside a name: 12x10, currentColor, no text of its own. */
function EaseGlyph({ ease }: { ease: Keyframe['ease'] }) {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden className="shrink-0">
      <path
        d={EASE_GLYPH[ease]}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Per-sample speed of an eased segment, normalized so the tallest bar is 1.
 * Read-only: it is the thing that tells him a move front-loads without him
 * having to scrub it, and it is derived from the curve, never edited.
 */
export function velocitySamples(evalAt: (p: number) => number, n = VELOCITY_SAMPLES): number[] {
  const raw: number[] = []
  let max = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(evalAt((i + 1) / n) - evalAt(i / n))
    raw.push(d)
    if (d > max) max = d
  }
  return max > 0 ? raw.map((d) => d / max) : raw
}

// --- component --------------------------------------------------------------

interface DragState {
  /** 0 = the outgoing handle (x1,y1), 1 = the incoming one (x2,y2). */
  which: 0 | 1
  next: Curve
}

export function CurveEditor({ clip, channel }: { clip: Clip; channel: AnimChannel }) {
  // fps and the selection both come off the rail, not the store: the rail is
  // already the one axis every lane reads, and a second store subscription here
  // would re-render the editor on every playhead tick for nothing.
  const { selection, fps } = useMotionRail()
  // The drag's truth lives in a ref so a pointermove never reads a stale
  // closure; `draft` mirrors just enough for the render. Same shape the lanes
  // already drag their diamonds with.
  const dragRef = useRef<DragState | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [draft, setDraft] = useState<Curve | null>(null)
  // null = the field follows the curve; a string = he is typing into it.
  const [text, setText] = useState<string | null>(null)

  // Never a keyframe, only a segment, and only one on THIS property.
  if (!selection || selection.kind !== 'segment' || selection.channel !== channel) return null

  const kfs = channelKeyframes(clip, channel)
  const idx = kfs.findIndex((k) => Math.abs(k.t - selection.t) <= MOMENT_EPS)
  const a = idx >= 0 ? kfs[idx] : undefined
  const b = idx >= 0 ? kfs[idx + 1] : undefined
  // The last keyframe leaves no segment: there is nothing after it to shape.
  if (!a || !b) return null

  const segT = a.t
  const stored = a.curve
  const live = draft ?? stored
  // Handles sit on the live curve, or seeded on the named ease when there is none.
  const handles = live ?? EASE_SEED[a.ease] ?? EASE_SEED.linear
  // The dashed ghost is the named ease AS THE RENDERER RUNS IT, so it stays
  // honest for 'hold', which is a step no bezier can express.
  const namedAt = (p: number): number => (a.ease === 'hold' ? (p >= 1 ? 1 : 0) : ease(a.ease, p))
  const evalAt = (p: number): number => (live ? bezierEase(live, p) : namedAt(p))
  const frames = Math.max(0, Math.round((b.t - a.t) * (fps || 30)))

  const commit = (curve: Curve | undefined): void => setSegmentCurve(clip.id, channel, segT, curve)
  /** Back to a NAMED shape: the ease and the curve it overrides, in one step. */
  const pickEase = (next: Keyframe['ease']): void => setSegmentEase(clip.id, channel, segT, next)

  /** Client px to curve coords. x stays in 0..1 (time must stay monotonic). */
  const toCurve = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = svgRef.current
    const r = el?.getBoundingClientRect()
    const sx = r && r.width > 0 ? (W + PAD * 2) / r.width : 1
    const sy = r && r.height > 0 ? (GRAPH_H + PAD * 2) / r.height : 1
    const ux = ((clientX - (r?.left ?? 0)) * sx - PAD) / W
    const uy = Y_MAX - ((clientY - (r?.top ?? 0)) * sy - PAD) / H
    return { x: snap(clamp(ux, 0, 1)), y: snap(clamp(uy, Y_MIN, Y_MAX)) }
  }

  // Window-level listeners installed on pointerdown, as the lanes do: a 5px
  // circle is far too small to rely on the pointer staying inside it. The write
  // lands on pointerUP, once, so a whole drag is ONE undo step rather than one
  // per frame of movement.
  const onHandleDown = (e: React.PointerEvent<SVGCircleElement>, which: 0 | 1) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { which, next: handles }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const p = toCurve(ev.clientX, ev.clientY)
      const c = d.next
      d.next = d.which === 0 ? [p.x, p.y, c[2], c[3]] : [c[0], c[1], p.x, p.y]
      setDraft(d.next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDraft(null)
      if (d && !curveEq(d.next, stored)) commit(d.next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const fieldText = text ?? formatCurve(handles)
  const parsed = parseCurveText(fieldText)
  const badText = text !== null && parsed === null
  const commitText = () => {
    if (parsed && !curveEq(parsed, stored)) commit(parsed)
    setText(null)
  }

  /**
   * Every segment on this property gets the shape he just made. One call per
   * segment through the same single-segment action, so a locked track refuses it
   * the same way and nothing needs a second write path. The last keyframe is
   * skipped: it leaves no segment.
   */
  const applyToAll = () => {
    if (!live) return
    for (let i = 0; i < kfs.length - 1; i++) setSegmentCurve(clip.id, channel, kfs[i].t, live)
  }

  const chip = (active: boolean) =>
    `flex h-6 items-center rounded-field px-2 text-dense transition-colors duration-[120ms] ${
      active
        ? 'bg-accent-quiet text-accent'
        : 'bg-bg-input text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
    }`

  const ghostPts = stored
    ? ''
    : Array.from({ length: VELOCITY_SAMPLES + 1 }, (_, i) => {
        const p = i / VELOCITY_SAMPLES
        return `${gx(p).toFixed(2)},${gy(namedAt(p)).toFixed(2)}`
      }).join(' ')
  const vel = velocitySamples(evalAt)
  const barW = W / VELOCITY_SAMPLES

  return (
    <div
      className="mt-1 flex flex-col gap-2 rounded-overlay bg-bg-elevated/60 p-2"
      data-testid="curve-editor"
      data-channel={channel}
    >
      <div className="flex items-center gap-1.5">
        {/* Deliberately NOT the uppercase section-label treatment: this line is
            the segment's real numbers, and "5F" reads worse than "5f". */}
        <h4
          className="flex-1 truncate text-ui-sm font-medium text-text-primary"
          data-testid="curve-editor-header"
        >
          {segmentHeader(channel, a.value, b.value, frames)}
        </h4>
        <IconButton
          label="Clear curve (back to the named ease)"
          size="compact"
          data-testid="curve-clear"
          disabled={!stored}
          onClick={() => commit(undefined)}
        >
          <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <svg
        ref={svgRef}
        width={W + PAD * 2}
        height={GRAPH_H + PAD * 2}
        viewBox={`0 0 ${W + PAD * 2} ${GRAPH_H + PAD * 2}`}
        className="max-w-full touch-none select-none"
        role="group"
        aria-label="Segment easing curve"
      >
        <g transform={`translate(${PAD},${PAD})`}>
          <rect x={0} y={0} width={W} height={GRAPH_H} rx={3} fill="var(--color-bg-input)" />
          {/* Quarter grid inside the unit square. */}
          {[0.25, 0.5, 0.75].map((q) => (
            <line key={`h${q}`} x1={0} x2={W} y1={gy(q)} y2={gy(q)} stroke="var(--color-border)" strokeWidth={1} />
          ))}
          {[0.25, 0.5, 0.75].map((q) => (
            <line key={`v${q}`} x1={gx(q)} x2={gx(q)} y1={gy(1)} y2={gy(0)} stroke="var(--color-border)" strokeWidth={1} />
          ))}
          {/* The unit square itself: the two lines a curve is allowed to pass. */}
          <line x1={0} x2={W} y1={gy(1)} y2={gy(1)} stroke="var(--color-border-strong)" strokeWidth={1} />
          <line x1={0} x2={W} y1={gy(0)} y2={gy(0)} stroke="var(--color-border-strong)" strokeWidth={1} />

          {/* The named ease this segment runs today, until he touches a handle. */}
          {ghostPts && (
            <polyline
              points={ghostPts}
              fill="none"
              stroke="var(--color-text-muted)"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              data-testid="curve-ghost"
            />
          )}

          {live && (
            <path
              d={`M 0 ${gy(0)} C ${gx(live[0])} ${gy(live[1])}, ${gx(live[2])} ${gy(live[3])}, ${W} ${gy(1)}`}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeLinecap="round"
              data-testid="curve-path"
            />
          )}

          {/* Handle arms, then the handles themselves on top. */}
          <line x1={0} y1={gy(0)} x2={gx(handles[0])} y2={gy(handles[1])} stroke="var(--color-accent)" strokeWidth={1} opacity={0.5} />
          <line x1={W} y1={gy(1)} x2={gx(handles[2])} y2={gy(handles[3])} stroke="var(--color-accent)" strokeWidth={1} opacity={0.5} />
          {/* Both endpoints are pinned: a segment starts where it starts. */}
          <circle cx={0} cy={gy(0)} r={3} fill="var(--color-text-secondary)" />
          <circle cx={W} cy={gy(1)} r={3} fill="var(--color-text-secondary)" />
          <circle
            cx={gx(handles[0])}
            cy={gy(handles[1])}
            r={5}
            fill="var(--color-accent)"
            stroke="var(--color-bg-app)"
            strokeWidth={1.5}
            className="cursor-grab"
            data-testid="curve-handle-1"
            aria-label={`Start handle, x ${handles[0]}, y ${handles[1]}`}
            onPointerDown={(e) => onHandleDown(e, 0)}
          />
          <circle
            cx={gx(handles[2])}
            cy={gy(handles[3])}
            r={5}
            fill="var(--color-accent)"
            stroke="var(--color-bg-app)"
            strokeWidth={1.5}
            className="cursor-grab"
            data-testid="curve-handle-2"
            aria-label={`End handle, x ${handles[2]}, y ${handles[3]}`}
            onPointerDown={(e) => onHandleDown(e, 1)}
          />
        </g>
      </svg>

      {/* Speed of the move, sampled at 64 points. Tall then flat = front-loaded. */}
      <svg
        width={W + PAD * 2}
        height={26}
        viewBox={`0 0 ${W + PAD * 2} 26`}
        className="max-w-full"
        role="img"
        aria-label="Velocity of this segment (read-only)"
        data-testid="curve-velocity"
      >
        <g transform={`translate(${PAD},0)`}>
          <rect x={0} y={0} width={W} height={26} rx={3} fill="var(--color-bg-input)" />
          {vel.map((v, i) => (
            <rect
              key={i}
              x={i * barW + 0.35}
              y={26 - Math.max(1, v * 24)}
              width={Math.max(0.8, barW - 0.7)}
              height={Math.max(1, v * 24)}
              fill="var(--color-accent)"
              opacity={0.75}
            />
          ))}
        </g>
      </svg>

      {/* The one curve table, by name. Never a second copy of the numbers. */}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Motion curve presets">
        {(Object.keys(MOTION_CURVES) as MotionCurveName[]).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`curve-chip-${name}`}
            aria-pressed={curveEq(live, MOTION_CURVES[name])}
            aria-label={CURVE_HELP[name]}
            title={`${CURVE_HELP[name]} (${formatCurve(MOTION_CURVES[name])})`}
            className={chip(curveEq(live, MOTION_CURVES[name]))}
            onClick={() => commit(MOTION_CURVES[name])}
          >
            {CURVE_LABEL[name]}
          </button>
        ))}
      </div>

      {/* The five named shapes, which is where they landed when they left the
          lane. A curve wins over the name at render time, so picking one here
          clears the hand-shaped curve with it, in the same undo step. Hold is
          the one that MUST live here: it is a step, and no bezier is a step. */}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Named easing">
        {EASE_ORDER.map((name) => {
          const on = !live && a.ease === name
          return (
            <button
              key={name}
              type="button"
              data-testid={`ease-${name}`}
              aria-pressed={on}
              aria-label={EASE_HELP[name]}
              title={EASE_HELP[name]}
              className={`${chip(on)} gap-1`}
              onClick={() => pickEase(name)}
            >
              <EaseGlyph ease={name} />
              {EASE_LABEL[name]}
            </button>
          )
        })}
      </div>

      {/* What the shape he is looking at actually does, said in words. Six chip
          captions and four bezier numbers answer "which one is on", never
          "what is Lin". */}
      <p className="text-[10px] leading-snug text-text-muted" data-testid="ease-explainer">
        {easeExplainer(live, a.ease)}
      </p>

      <div className="flex items-center gap-1.5">
        <label htmlFor={`curve-text-${channel}`} className="shrink-0 text-[10px] uppercase tracking-[0.04em] text-text-muted">
          Bezier
        </label>
        <input
          id={`curve-text-${channel}`}
          type="text"
          spellCheck={false}
          data-testid="curve-text"
          aria-label="Cubic bezier, four numbers in CSS order"
          aria-invalid={badText || undefined}
          title="Paste four numbers from easings.net, e.g. 0.16, 1, 0.3, 1"
          value={fieldText}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitText()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setText(null)
              e.currentTarget.blur()
            }
          }}
          onBlur={commitText}
          className={`h-6 min-w-0 flex-1 rounded-field bg-bg-input px-2 font-numeric text-ui-sm text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated ${
            badText ? 'text-danger' : ''
          }`}
        />
      </div>

      <button
        type="button"
        data-testid="curve-apply-all"
        title={`Give every segment on ${friendly(channel)} this same shape`}
        disabled={!live || kfs.length < 3}
        className="flex h-6 items-center justify-center rounded-field bg-bg-input px-2 text-dense text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40 disabled:hover:bg-bg-input disabled:hover:text-text-secondary"
        onClick={applyToAll}
      >
        Apply to every segment on this property
      </button>
    </div>
  )
}
