import { Rewind, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { clipEmitsAudio } from '../engine/audio'
import { clipDurationS, clipEndS } from '../engine/timeline'
import { formatTimecode } from '../engine/timecode'
import { activeSequence, isTitleClip, type Clip, type MediaAsset, type Track } from '../engine/types'
import { setClipFade, setClipGainDb, setClipSpeed } from '../state/clipEdits'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { EffectControls, ScrubField, type Spec } from './EffectControls'
import { TitleControls } from './TitleControls'

const GAIN_SPEC: Spec = { min: -60, max: 12, step: 0.5, sens: 0.2 }
const FADE_SPEC: Spec = { min: 0, max: 30, step: 0.05, sens: 0.02 }
const SPEED_SPEC: Spec = { min: 10, max: 800, step: 1, sens: 1 }

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex-1 truncate text-[11px] uppercase tracking-[0.04em] text-text-muted">{label}</span>
      {children}
    </div>
  )
}

/** Speed / duration + reverse (Phase 7). */
function SpeedControls({ clip }: { clip: Clip }) {
  const reversed = clip.speed < 0
  const pct = Math.abs(clip.speed) * 100
  return (
    <section className="flex flex-col gap-2" data-testid="speed-controls">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Speed / Duration</h3>
      <div className="flex flex-col gap-1.5">
        <FieldRow label="Speed (%)">
          <ScrubField
            value={pct}
            spec={SPEED_SPEC}
            testId="field-speed"
            ariaLabel="Speed percent"
            onCommit={(v) => setClipSpeed(clip.id, (reversed ? -1 : 1) * (v / 100))}
          />
        </FieldRow>
        <FieldRow label="Reverse">
          <IconButton
            label={reversed ? 'Play forward' : 'Reverse'}
            active={reversed}
            data-testid="reverse-toggle"
            onClick={() => setClipSpeed(clip.id, -clip.speed)}
          >
            <Rewind size={14} strokeWidth={1.5} />
          </IconButton>
        </FieldRow>
      </div>
    </section>
  )
}

/** Gain + fades for a clip that contributes audio (Phase 6). */
function AudioControls({ clip }: { clip: Clip }) {
  const durMax = Math.max(0.05, clipDurationS(clip))
  return (
    <section className="flex flex-col gap-2" data-testid="audio-controls">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">Audio</h3>
      <div className="flex flex-col gap-1.5">
        <FieldRow label="Gain (dB)">
          <ScrubField
            value={clip.audioGainDb}
            spec={GAIN_SPEC}
            testId="field-audio-gain"
            ariaLabel="Audio gain (dB)"
            onCommit={(v) => setClipGainDb(clip.id, v)}
          />
        </FieldRow>
        <FieldRow label="Fade in (s)">
          <ScrubField
            value={clip.fadeInS}
            spec={{ ...FADE_SPEC, max: durMax }}
            testId="field-fade-in"
            ariaLabel="Fade in seconds"
            onCommit={(v) => setClipFade(clip.id, 'in', v)}
          />
        </FieldRow>
        <FieldRow label="Fade out (s)">
          <ScrubField
            value={clip.fadeOutS}
            spec={{ ...FADE_SPEC, max: durMax }}
            testId="field-fade-out"
            ariaLabel="Fade out seconds"
            onCommit={(v) => setClipFade(clip.id, 'out', v)}
          />
        </FieldRow>
      </div>
    </section>
  )
}

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
  showAudio,
  audioFirst,
}: {
  clip: Clip
  assetName: string
  fps: number
  playheadS: number
  showAudio: boolean
  /** Audio-track clips lead with the sound controls (above Speed/Duration). */
  audioFirst: boolean
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

      {/* A SOUND clip is about its sound: Audio leads, Speed/Duration follows.
          Video clips keep Speed first (their audio is secondary). */}
      {audioFirst && showAudio && (
        <>
          <AudioControls clip={clip} />
          <div className="h-px bg-border" />
        </>
      )}

      {!isTitle && (
        <>
          <SpeedControls clip={clip} />
          <div className="h-px bg-border" />
        </>
      )}

      {!audioFirst && showAudio && (
        <>
          <AudioControls clip={clip} />
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
  // FRAME-quantized playhead: the keyframe UI is frame-accurate anyway, and the
  // raw value ticks every animation frame during playback — subscribing to it
  // directly re-rendered the whole Inspector at display refresh rate. Selecting
  // the quantized value re-renders at most fps times per second.
  const playheadS = useStore((s) => {
    const sq = activeSequence(s.project)
    const f = sq.fps > 0 ? sq.fps : 30
    return Math.floor(s.ui.playheadS * f + 1e-6) / f
  })
  const seq = activeSequence(project)
  const selectedTrack: Track | undefined =
    selection.length === 1
      ? seq.tracks.find((t) => t.clips.some((c) => c.id === selection[0]))
      : undefined
  const selected = selectedTrack?.clips.find((c) => c.id === selection[0])
  const selectedAsset: MediaAsset | undefined = selected ? project.assets[selected.assetId] : undefined
  // Show the Audio section when the clip actually contributes sound: an
  // audio-track clip, or an unlinked video clip whose source has audio.
  const showAudio =
    !!selected &&
    !isTitleClip(selected) &&
    !!selectedTrack &&
    clipEmitsAudio(selectedTrack, selected) &&
    (selectedTrack.kind === 'audio' || !!selectedAsset?.hasAudio)

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
            assetName={selectedAsset?.name ?? 'Missing media'}
            fps={seq.fps}
            playheadS={playheadS}
            showAudio={showAudio}
            audioFirst={selectedTrack?.kind === 'audio'}
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
