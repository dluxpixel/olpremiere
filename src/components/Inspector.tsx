import { SlidersHorizontal } from 'lucide-react'
import { clipDurationS, clipEndS } from '../engine/timeline'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, isTitleClip, type Clip } from '../engine/types'
import { useStore } from '../state/store'
import { EffectControls } from './EffectControls'
import { TitleControls } from './TitleControls'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-text-secondary">{label}</span>
      <span className="tabular-nums text-text-primary">{value}</span>
    </div>
  )
}

function ClipPanel({
  clip,
  assetName,
  fps,
  playheadS,
}: {
  clip: Clip
  assetName: string
  fps: number
  playheadS: number
}) {
  const isTitle = isTitleClip(clip)
  const name = isTitle ? clip.title!.text || 'Title' : assetName

  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <div
          className="truncate text-[13px] font-medium text-text-primary"
          title={name}
          data-testid="inspector-clip-name"
        >
          {name}
        </div>
        <div className="mt-0.5 text-[11px] text-text-muted">{isTitle ? 'Title' : 'Clip'}</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="Start" value={formatTimecode(clip.startS, fps)} />
        <Row label="End" value={formatTimecode(clipEndS(clip), fps)} />
        <Row label="Duration" value={formatTimecode(clipDurationS(clip), fps)} />
        {!isTitle && <Row label="Source in" value={formatTimecode(clip.inS, fps)} />}
        {!isTitle && <Row label="Source out" value={formatTimecode(clip.outS, fps)} />}
      </div>

      <div className="h-px bg-border" />

      {isTitle && (
        <>
          <TitleControls clip={clip} />
          <div className="h-px bg-border" />
        </>
      )}

      <EffectControls clip={clip} fps={fps} playheadS={playheadS} />
    </div>
  )
}

export function Inspector({ width }: { width: number }) {
  const project = useStore((s) => s.project)
  const selection = useStore((s) => s.ui.selection)
  const playheadS = useStore((s) => s.ui.playheadS)
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
            playheadS={playheadS}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <SlidersHorizontal size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[12px] text-text-muted">
            {selection.length > 1
              ? `${selection.length} clips selected`
              : 'Select a clip to edit its properties'}
          </div>
        </div>
      )}
    </aside>
  )
}
