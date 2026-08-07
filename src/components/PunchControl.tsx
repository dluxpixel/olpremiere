// The Motion header block: how deep a punch goes, how fast it arrives, on what
// curve, where it converges, and the three one-click moves themselves.
//
// It grew out of the punch-depth picker and keeps that file's name and its
// data-testid, because the depth chips, the custom depth field and the saved
// chips under 'olpremiere:zoomPresets' are all still here and still do exactly
// what they did. A saved chip carries the whole move now (depth, rise, curve),
// and the bare numbers already in his browser are read forward rather than
// dropped - see punchPresets.ts.
//
// The HEADROOM readout is the part that is new in kind rather than in degree.
// Nothing in the app stopped him punching a 1080p source to 170 percent, and
// the softness only turned up on export, by which point the edit was done. So
// the ceiling (source width over sequence width) sits beside the depth and goes
// amber past it. It WARNS. It never blocks: an upscaled punch is a real choice.

import { Crosshair, Plus, Scissors, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { MOTION_CURVES, type MotionCurveName } from '../engine/motion'
import { findClip } from '../engine/timeline'
import { activeSequence } from '../engine/types'
import { cutPunchAtPlayhead, punchInAtPlayhead, punchOutAtPlayhead } from '../state/motionActions'
import { DEFAULT_ZOOM_ANCHOR, useStore } from '../state/store'
import { CURVE_LABEL, formatCurve } from './CurveEditor'
import { PropRow, ScrubField, type Spec } from './EffectControls'
import {
  DEPTH_MAX,
  DEPTH_MIN,
  LEGACY_CURVE,
  LEGACY_RISE_FRAMES,
  MAX_ZOOM_PRESETS,
  RISE_MAX,
  RISE_MIN,
  headroomCeiling,
  loadPresets,
  overHeadroom,
  samePreset,
  savePresets,
  type ZoomPreset,
} from './punchPresets'

const BUILTINS: { label: string; v: number }[] = [
  { label: 'Subtle', v: 1.1 },
  { label: 'Medium', v: 1.2 },
  { label: 'Deep', v: 1.4 },
  { label: 'Extreme', v: 1.7 },
]

const DEPTH_SPEC: Spec = { min: DEPTH_MIN, max: DEPTH_MAX, step: 0.01, sens: 0.01 }
// Whole frames, and the rise is quantized to them on write anyway: 5 frames is
// 200ms at 24fps, 6 at 30, 12 at 60.
const RISE_SPEC: Spec = { min: RISE_MIN, max: RISE_MAX, step: 1, sens: 0.2 }

const CURVE_NAMES = Object.keys(MOTION_CURVES) as MotionCurveName[]

const near = (a: number, b: number): boolean => Math.abs(a - b) < 5e-3
const pct = (v: number): string => `${Math.round(v * 100)}%`

export function PunchControl({
  clipId,
  headerAction,
}: {
  clipId: string
  /** Trailing slot on the Motion header row: EffectControls folds 'Clear
   *  motion' in here rather than leaving a loose button under the block. */
  headerAction?: ReactNode
}) {
  const depth = useStore((s) => s.ui.punchDepth)
  const riseFrames = useStore((s) => s.ui.punchRiseFrames)
  const moveCurve = useStore((s) => s.ui.moveCurve)
  const anchor = useStore((s) => s.ui.zoomAnchor)
  const setUI = useStore((s) => s.setUI)
  // Both headroom selectors hand back a scalar, never a fresh object, so the
  // block re-renders when the format or the media behind this clip changes and
  // on nothing else.
  const seqWidth = useStore((s) => activeSequence(s.project).width)
  const assetWidth = useStore((s) => {
    const found = findClip(activeSequence(s.project), clipId)
    return found ? s.project.assets[found.clip.assetId]?.width : undefined
  })
  const [saved, setSaved] = useState<ZoomPreset[]>(loadPresets)

  const ceiling = headroomCeiling(assetWidth, seqWidth)
  const over = overHeadroom(depth, ceiling)
  const current: ZoomPreset = { scale: depth, riseFrames, curve: moveCurve }

  const chip = (active: boolean) =>
    `flex h-6 items-center gap-1 rounded-field px-2 text-dense transition-colors duration-[120ms] ${
      active ? 'bg-accent-quiet text-accent' : 'bg-bg-input text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
    }`
  const moveBtn =
    'flex h-6 items-center gap-1 rounded-field bg-bg-input px-2.5 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary'

  const saveCurrent = () => {
    // A chip is a whole MOVE now, so a depth that is already a builtin is only
    // redundant while the rise and the curve are the defaults too.
    const isDefaultMove = riseFrames === LEGACY_RISE_FRAMES && moveCurve === LEGACY_CURVE
    if (saved.some((p) => samePreset(p, current))) return
    if (isDefaultMove && BUILTINS.some((b) => near(b.v, depth))) return
    const next = [...saved, current].slice(-MAX_ZOOM_PRESETS)
    setSaved(next)
    savePresets(next)
  }
  const removeSaved = (at: number) => {
    const next = saved.filter((_, i) => i !== at)
    setSaved(next)
    savePresets(next)
  }
  // Not named usePreset: a `use` prefix reads as a React hook to the linter.
  const applyPreset = (p: ZoomPreset) =>
    setUI({ punchDepth: p.scale, punchRiseFrames: p.riseFrames, moveCurve: p.curve })

  return (
    <section className="flex flex-col gap-2 rounded-field bg-bg-elevated/50 p-2" data-testid="punch-control">
      <div className="flex items-center gap-1.5">
        <ZoomIn size={13} strokeWidth={1.75} className="text-text-muted" aria-hidden />
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Motion</h4>
        <span
          className={`ml-auto font-numeric text-dense ${over ? 'text-warning' : 'text-accent'}`}
          data-testid="punch-depth-readout"
        >
          {pct(depth)}
        </span>
        {ceiling !== null && (
          <span
            data-testid="punch-headroom"
            title={`${assetWidth}px source in a ${seqWidth}px sequence, so past ${pct(
              ceiling,
            )} the picture is being upscaled and starts to soften. A warning, not a limit.`}
            className={`font-numeric text-dense ${over ? 'text-warning' : 'text-text-muted'}`}
          >
            up to {pct(ceiling)}
          </span>
        )}
        {headerAction}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {BUILTINS.map((b) => (
          <button
            key={b.label}
            type="button"
            data-testid={`punch-preset-${b.label.toLowerCase()}`}
            title={`${b.label} zoom, ${pct(b.v)}`}
            className={chip(near(depth, b.v))}
            onClick={() => setUI({ punchDepth: b.v })}
          >
            {b.label}
            <span className="font-numeric opacity-70">{pct(b.v)}</span>
          </button>
        ))}
      </div>

      <PropRow label="Depth" labelTitle="Custom zoom depth: the scale a punch arrives at">
        <ScrubField
          value={depth}
          spec={DEPTH_SPEC}
          testId="punch-depth-field"
          ariaLabel="Zoom depth (target scale)"
          onCommit={(v) => setUI({ punchDepth: v })}
        />
        <button
          type="button"
          data-testid="punch-save"
          title="Save this move (depth, rise and curve) as a chip"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-field bg-bg-input text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary"
          onClick={saveCurrent}
        >
          <Plus size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </PropRow>

      <PropRow label="Rise" labelTitle="How long a punch takes to arrive, in whole frames">
        <ScrubField
          value={riseFrames}
          spec={RISE_SPEC}
          testId="punch-rise-field"
          ariaLabel="Punch rise, in frames"
          onCommit={(v) => setUI({ punchRiseFrames: Math.round(v) })}
        />
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-dense text-text-muted" aria-hidden>
          f
        </span>
      </PropRow>

      {/* The one curve table, by name. The moves and these chips read the same
          six numbers, so a chip can never claim a shape the punch does not use. */}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Move curve">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Curve</span>
        {CURVE_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`punch-curve-${name}`}
            title={`${CURVE_LABEL[name]} (${formatCurve(MOTION_CURVES[name])}) - every drag, field commit and preset is written with it`}
            className={chip(moveCurve === name)}
            onClick={() => setUI({ moveCurve: name })}
          >
            {CURVE_LABEL[name]}
          </button>
        ))}
      </div>

      <PropRow
        label="Zoom point"
        labelTitle="Where every punch converges, as a share of the frame. Set it on the monitor: right-click, Set zoom point here."
        lead={<Crosshair size={13} strokeWidth={1.75} className="text-text-muted" aria-hidden />}
        onReset={() => setUI({ zoomAnchor: DEFAULT_ZOOM_ANCHOR })}
        resetLabel="Reset the zoom point to the eye line"
      >
        <span className="font-numeric text-dense text-text-secondary" data-testid="zoom-anchor-readout">
          {pct(anchor.x)}, {pct(anchor.y)}
        </span>
      </PropRow>

      <div className="flex flex-wrap items-center gap-1">
        {/* Keeps the testid the Apply button had: this is the same verb, said
            plainly now that it has two siblings. */}
        <button
          type="button"
          data-testid="punch-apply"
          title="Zoom to the depth above at the playhead and STAY there (also: press P)"
          className="flex h-6 items-center gap-1 rounded-field bg-accent px-2.5 text-ui-sm font-medium text-accent-fg transition-colors duration-[120ms] hover:bg-accent-hover"
          onClick={() => punchInAtPlayhead(clipId, depth)}
        >
          <ZoomIn size={12} strokeWidth={2} aria-hidden />
          Punch in
        </button>
        <button
          type="button"
          data-testid="punch-out"
          title="Fall back to this clip's own framing at the playhead and hold there (also: press Shift+P)"
          className={moveBtn}
          onClick={() => punchOutAtPlayhead(clipId)}
        >
          <ZoomOut size={12} strokeWidth={2} aria-hidden />
          Punch out
        </button>
        <button
          type="button"
          data-testid="cut-punch"
          title="Split at the playhead and start the second half bigger. No animation at all, which is what most YouTube punch-ins actually are."
          className={moveBtn}
          onClick={() => cutPunchAtPlayhead(clipId)}
        >
          <Scissors size={12} strokeWidth={2} aria-hidden />
          Cut punch
        </button>
      </div>

      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Saved</span>
          {saved.map((p, i) => (
            <span key={`${p.scale}-${p.riseFrames}-${p.curve}`} className={chip(samePreset(p, current))}>
              <button
                type="button"
                className="font-numeric"
                title={`Use ${pct(p.scale)} over ${p.riseFrames}f on ${CURVE_LABEL[p.curve]}`}
                onClick={() => applyPreset(p)}
              >
                {pct(p.scale)}
              </button>
              <button type="button" aria-label={`Remove the ${pct(p.scale)} preset`} title="Remove" onClick={() => removeSaved(i)}>
                <X size={11} strokeWidth={2} className="opacity-60 hover:opacity-100" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
