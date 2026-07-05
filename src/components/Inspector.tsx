import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { clipDurationS, clipEndS } from '../engine/timeline'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, type Clip } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-text-secondary">{label}</span>
      <span className="tabular-nums text-text-primary">{value}</span>
    </div>
  )
}

/** Range that previews live but lands ONE undo entry on release. */
function CommitSlider({
  label,
  min,
  max,
  step,
  value,
  format,
  onCommit,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      <span className="flex items-center justify-between">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums text-text-primary">{format(draft)}</span>
      </span>
      <input
        type="range"
        className="h-1 w-full accent-accent"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          if (draft !== value) onCommit(draft)
        }}
        onKeyUp={(e) => {
          if ((e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') && draft !== value)
            onCommit(draft)
        }}
      />
    </label>
  )
}

function ClipPanel({ clip, assetName, fps }: { clip: Clip; assetName: string; fps: number }) {
  const patchClip = (label: string, patch: Partial<Clip>) =>
    updateActiveSequence(label, (seq) => ({
      ...seq,
      tracks: seq.tracks.map((t) =>
        t.clips.some((c) => c.id === clip.id)
          ? { ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) }
          : t,
      ),
    }))

  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <div
          className="truncate text-[13px] font-medium text-text-primary"
          title={assetName}
          data-testid="inspector-clip-name"
        >
          {assetName}
        </div>
        <div className="mt-0.5 text-[11px] text-text-muted">Clip</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="Start" value={formatTimecode(clip.startS, fps)} />
        <Row label="End" value={formatTimecode(clipEndS(clip), fps)} />
        <Row label="Duration" value={formatTimecode(clipDurationS(clip), fps)} />
        <Row label="Source in" value={formatTimecode(clip.inS, fps)} />
        <Row label="Source out" value={formatTimecode(clip.outS, fps)} />
      </div>

      <div className="h-px bg-border" />

      <CommitSlider
        label="Opacity"
        min={0}
        max={1}
        step={0.01}
        value={clip.opacity}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => patchClip('Set clip opacity', { opacity: v })}
      />
      <CommitSlider
        label="Audio gain"
        min={-24}
        max={12}
        step={0.5}
        value={clip.audioGainDb}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
        onCommit={(v) => patchClip('Set clip gain', { audioGainDb: v })}
      />
      <p className="text-[11px] leading-4 text-text-muted">
        Transform, keyframes and effects arrive in Phase 4.
      </p>
    </div>
  )
}

export function Inspector({ width }: { width: number }) {
  const project = useStore((s) => s.project)
  const selection = useStore((s) => s.ui.selection)
  const seq = activeSequence(project)
  const selected =
    selection.length === 1
      ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === selection[0])
      : undefined

  return (
    <aside
      data-testid="panel-right"
      className="flex min-h-0 shrink-0 flex-col bg-bg-panel"
      style={{ width }}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
          Effect Controls
        </span>
      </div>
      {selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ClipPanel
            clip={selected}
            assetName={project.assets[selected.assetId]?.name ?? 'Missing media'}
            fps={seq.fps}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <SlidersHorizontal size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[12px] text-text-muted">
            {selection.length > 1 ? `${selection.length} clips selected` : 'Select a clip to edit its properties'}
          </div>
        </div>
      )}
    </aside>
  )
}
