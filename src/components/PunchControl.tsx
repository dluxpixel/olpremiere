// The hand controls: the three punch verbs and the four depths, behind "Tune it
// by hand" under the shelf.
//
// This block used to be the front door of the motion desk and it was the wrong
// door: five controls that are all PARAMETERS (depth, rise, curve, zoom point,
// saved chips) sitting above three buttons that each need the playhead parked
// first. The shelf answers all of it in one click, so what is left here is the
// beat-accurate work the keyboard is genuinely better at, and nothing else.
//
// Cut on 2026-08-10, engine untouched in every case:
//
// - the Curve chips. Six names, two of them trade jargon, changing what every
//   future drag writes GLOBALLY. The move table owns the curve per beat now, and
//   the same six chips still live inside the curve editor where they shape the
//   one segment he clicked.
// - the Rise field. The rise stays at 5 frames and the table reads it.
// - the Zoom point row and its reset. A persisted global aim means the same
//   click means two different things on two different nights, which is the exact
//   argument that killed the global auto-keyframe flag. The aim belongs to the
//   move, and the move carries its own.
// - the Depth field and the Saved chips. The shelf IS the preset library and it
//   is derived rather than recorded, which cannot go stale. One number, one
//   control: the How big slider.
// - the headroom readout, folded into that slider as its amber colour and its
//   tooltip. It warns exactly as well with a tenth of the furniture.

import { Scissors, ZoomIn, ZoomOut } from 'lucide-react'
import { type ReactNode } from 'react'
import { cutPunchAtPlayhead, punchInAtPlayhead, punchOutAtPlayhead } from '../state/motionActions'
import { useStore } from '../state/store'

const BUILTINS: { label: string; v: number }[] = [
  { label: 'Subtle', v: 1.1 },
  { label: 'Medium', v: 1.2 },
  { label: 'Deep', v: 1.4 },
  { label: 'Extreme', v: 1.7 },
]

const near = (a: number, b: number): boolean => Math.abs(a - b) < 5e-3
const pct = (v: number): string => `${Math.round(v * 100)}%`

export function PunchControl({
  clipId,
  headerAction,
}: {
  clipId: string
  /** Trailing slot on the header row: EffectControls folds 'Clear motion' in
   *  here rather than leaving a loose button under the block. */
  headerAction?: ReactNode
}) {
  const depth = useStore((s) => s.ui.punchDepth)
  const setUI = useStore((s) => s.setUI)

  const chip = (active: boolean) =>
    `flex h-6 items-center gap-1 rounded-field px-2 text-dense transition-colors duration-[120ms] ${
      active ? 'bg-accent-quiet text-accent' : 'bg-bg-input text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
    }`
  const moveBtn =
    'flex h-6 items-center gap-1 rounded-field bg-bg-input px-2.5 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:bg-bg-elevated hover:text-text-primary'

  return (
    <section className="flex flex-col gap-2 rounded-field bg-bg-elevated/50 p-2" data-testid="punch-control">
      <div className="flex items-center gap-1.5">
        <ZoomIn size={13} strokeWidth={1.75} className="text-text-muted" aria-hidden />
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">At the playhead</h4>
        <span className="ml-auto font-numeric text-dense text-accent" data-testid="punch-depth-readout">
          {pct(depth)}
        </span>
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

      <div className="flex flex-wrap items-center gap-1">
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
          title="Split at the playhead and start the second half bigger. No animation at all, which is what most YouTube punch-ins actually are (also: press Alt+P)"
          className={moveBtn}
          onClick={() => cutPunchAtPlayhead(clipId)}
        >
          <Scissors size={12} strokeWidth={2} aria-hidden />
          Cut punch
        </button>
      </div>
    </section>
  )
}
