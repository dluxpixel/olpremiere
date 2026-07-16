// "Select how deep the zoom is" — a punch-depth picker that lives in the
// Keyframes area. Presets pick a target scale (also what the P key uses), and
// Apply drops a punch-in at the playhead on the selected clip. Custom depths can
// be saved (localStorage) and reappear as one-click chips.

import { Plus, X, ZoomIn } from 'lucide-react'
import { useState } from 'react'
import { punchInAtPlayhead } from '../state/motionActions'
import { useStore } from '../state/store'
import { ScrubField, type Spec } from './EffectControls'

const BUILTINS: { label: string; v: number }[] = [
  { label: 'Subtle', v: 1.1 },
  { label: 'Medium', v: 1.2 },
  { label: 'Deep', v: 1.4 },
  { label: 'Extreme', v: 1.7 },
]

const DEPTH_SPEC: Spec = { min: 1.01, max: 4, step: 0.01, sens: 0.01 }
const KEY = 'reel:zoomPresets'

function loadSaved(): number[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}
function persist(list: number[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode / quota — presets just won't persist */
  }
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 5e-3
const pct = (v: number): string => `${Math.round(v * 100)}%`

export function PunchControl({ clipId }: { clipId: string }) {
  const depth = useStore((s) => s.ui.punchDepth)
  const setUI = useStore((s) => s.setUI)
  const [saved, setSaved] = useState<number[]>(loadSaved)

  const chip = (active: boolean) =>
    `flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] transition-colors duration-[120ms] ${
      active ? 'bg-accent-quiet text-accent' : 'bg-bg-input text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
    }`

  const saveCurrent = () => {
    if (saved.some((v) => near(v, depth)) || BUILTINS.some((b) => near(b.v, depth))) return
    const next = [...saved, depth].slice(-6)
    setSaved(next)
    persist(next)
  }
  const removeSaved = (v: number) => {
    const next = saved.filter((s) => !near(s, v))
    setSaved(next)
    persist(next)
  }

  return (
    <section className="flex flex-col gap-2 rounded-[6px] bg-bg-elevated/50 p-2" data-testid="punch-control">
      <div className="flex items-center gap-1.5">
        <ZoomIn size={13} strokeWidth={1.75} className="text-text-muted" aria-hidden />
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Zoom / Punch depth</h4>
        <span className="ml-auto text-[11px] tabular-nums text-accent" data-testid="punch-depth-readout">
          {pct(depth)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {BUILTINS.map((b) => (
          <button
            key={b.label}
            type="button"
            data-testid={`punch-preset-${b.label.toLowerCase()}`}
            title={`${b.label} zoom — ${pct(b.v)}`}
            className={chip(near(depth, b.v))}
            onClick={() => setUI({ punchDepth: b.v })}
          >
            {b.label}
            <span className="tabular-nums opacity-70">{pct(b.v)}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.04em] text-text-muted">Custom</span>
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
          title="Save this depth as a preset"
          className="flex h-6 w-6 items-center justify-center rounded-[4px] bg-bg-input text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
          onClick={saveCurrent}
        >
          <Plus size={13} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="punch-apply"
          title="Add a zoom-punch at the playhead (also: press P)"
          className="ml-auto flex h-6 items-center gap-1 rounded-[4px] bg-accent px-2.5 text-[11px] font-medium text-white transition-opacity duration-[120ms] hover:opacity-90"
          onClick={() => punchInAtPlayhead(clipId, depth)}
        >
          <ZoomIn size={12} strokeWidth={2} aria-hidden />
          Apply
        </button>
      </div>

      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.04em] text-text-muted">Saved</span>
          {saved.map((v) => (
            <span key={v} className={chip(near(depth, v))}>
              <button type="button" title={`Use ${pct(v)}`} onClick={() => setUI({ punchDepth: v })}>
                {pct(v)}
              </button>
              <button type="button" aria-label={`Remove ${pct(v)} preset`} title="Remove" onClick={() => removeSaved(v)}>
                <X size={11} strokeWidth={2} className="opacity-60 hover:opacity-100" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
