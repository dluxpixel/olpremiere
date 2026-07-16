import { Rewind, SlidersHorizontal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { clipEmitsAudio } from '../engine/audio'
import { clipDurationS, clipEndS, moveGroup } from '../engine/timeline'
import { formatTimecode, parseTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence, isTitleClip, type Clip, type MediaAsset, type Track } from '../engine/types'
import { setClipFade, setClipGainDb, setClipSpeed } from '../state/clipEdits'
import { updateActiveSequence, useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { EffectControls, ScrubField, type Spec } from './EffectControls'
import { MultiInspector, type SelectedClip } from './MultiInspector'
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

/** Commit-on-release volume slider (a live commit per tick would flood undo). */
function VolumeSlider({ clip }: { clip: Clip }) {
  const [draft, setDraft] = useState<number | null>(null)
  const value = draft ?? clip.audioGainDb
  const commit = () => {
    if (draft !== null && draft !== clip.audioGainDb) setClipGainDb(clip.id, draft)
    setDraft(null)
  }
  return (
    <input
      type="range"
      aria-label="Clip volume (dB)"
      data-testid="clip-volume-slider"
      className="h-1 w-full cursor-pointer accent-accent"
      min={GAIN_SPEC.min}
      max={GAIN_SPEC.max}
      step={GAIN_SPEC.step}
      value={value}
      title={`${value > 0 ? '+' : ''}${value.toFixed(1)} dB (double-click: 0)`}
      onChange={(e) => setDraft(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onDoubleClick={() => setClipGainDb(clip.id, 0)}
    />
  )
}

/**
 * Gain + fades for a clip that contributes audio (Phase 6). `linked` marks the
 * common mp4 case: the VIDEO clip is selected but its sound lives on the
 * linked audio clip — these controls edit that partner.
 */
function AudioControls({ clip, linked }: { clip: Clip; linked?: boolean }) {
  const durMax = Math.max(0.05, clipDurationS(clip))
  return (
    <section className="flex flex-col gap-2" data-testid="audio-controls">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
        Audio{linked ? ' · linked clip' : ''}
      </h3>
      <div className="flex flex-col gap-1.5">
        <FieldRow label="Volume">
          <div className="flex w-full items-center gap-2">
            <VolumeSlider clip={clip} />
            <ScrubField
              value={clip.audioGainDb}
              spec={GAIN_SPEC}
              testId="field-audio-gain"
              ariaLabel="Audio gain (dB)"
              onCommit={(v) => setClipGainDb(clip.id, v)}
            />
          </div>
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

/**
 * An editable timecode row: click to type an exact time, Enter/blur commits
 * (parsed + frame-quantized), Escape reverts. The commit goes through
 * moveGroup, so linked A/V travels together and overlaps resolve to the
 * nearest free slot — typing an occupied time lands beside it, not on it.
 */
function EditableTimecodeRow({
  label,
  seconds,
  fps,
  testId,
  onCommit,
}: {
  label: string
  seconds: number
  fps: number
  testId: string
  onCommit: (s: number) => void
}) {
  const [text, setText] = useState<string | null>(null) // null = display mode
  const commit = () => {
    if (text === null) return
    const parsed = parseTimecode(text, fps)
    if (parsed !== null && parsed >= 0) onCommit(quantizeToFrame(parsed, fps))
    setText(null)
  }
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-text-secondary">{label}</span>
      {text === null ? (
        <button
          type="button"
          data-testid={testId}
          className="cursor-text rounded-[3px] px-1 tabular-nums text-text-primary hover:bg-bg-elevated"
          onClick={() => setText(formatTimecode(seconds, fps))}
        >
          {formatTimecode(seconds, fps)}
        </button>
      ) : (
        <input
          autoFocus
          data-testid={`${testId}-input`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setText(null)
          }}
          onBlur={commit}
          onFocus={(e) => e.currentTarget.select()}
          className="w-[92px] rounded-[3px] bg-bg-input px-1 text-right text-[12px] tabular-nums text-text-primary"
        />
      )}
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
  linkedAudio,
  trackId,
}: {
  clip: Clip
  assetName: string
  fps: number
  playheadS: number
  showAudio: boolean
  /** Audio-track clips lead with the sound controls (above Speed/Duration). */
  audioFirst: boolean
  /** The linked audio partner of a video clip — its volume shows HERE. */
  linkedAudio?: Clip
  /** The clip's own track — the Start field moves it in place. */
  trackId?: string
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

      {/* Read-only clip metadata is folded away by default so the editing
          controls (and Keyframes) sit up top. Click "Details" to expand. */}
      <details className="group">
        <summary className="flex cursor-default list-none items-center justify-between text-[11px] text-text-muted [&::-webkit-details-marker]:hidden">
          <span className="uppercase tracking-[0.06em]">Details</span>
          <span className="tabular-nums text-text-secondary">{formatTimecode(clipDurationS(clip), fps)}</span>
        </summary>
        <div className="mt-2 flex flex-col gap-1.5">
          {trackId ? (
            <EditableTimecodeRow
              label="Start"
              seconds={clip.startS}
              fps={fps}
              testId="clip-start-timecode"
              onCommit={(s) => updateActiveSequence('Move clip', (sq) => moveGroup(sq, clip.id, trackId, s))}
            />
          ) : (
            <Row label="Start" value={formatTimecode(clip.startS, fps)} />
          )}
          <Row label="End" value={formatTimecode(clipEndS(clip), fps)} />
          <Row label="Duration" value={formatTimecode(clipDurationS(clip), fps)} />
          {!isTitle && <Row label="Source in" value={formatTimecode(clip.inS, fps)} />}
          {!isTitle && <Row label="Source out" value={formatTimecode(clip.outS, fps)} />}
        </div>
      </details>

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

      {/* Clicking the mp4's VIDEO clip must still offer volume — the sound
          lives on the linked audio clip, so edit that partner right here. */}
      {!showAudio && linkedAudio && (
        <>
          <AudioControls clip={linkedAudio} linked />
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
  // raw value ticks every animation frame. Even quantized, that re-rendered the
  // whole Effect Controls + KeyframeLane fps×/s DURING PLAYBACK — a big chunk of
  // playback lag. So while PLAYING we return a constant sentinel: the panel stops
  // re-rendering entirely and its live value readouts freeze (you watch the
  // monitor, not the inspector, while it plays). They resume the instant you pause.
  const playheadS = useStore((s) => {
    if (s.ui.playing) return -1
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

  // Multi-select: enrich every still-existing selected clip with its track +
  // whether it emits sound (mirrors the single-clip `showAudio` rule), so the
  // bulk panel can decide which sections to show.
  const multi: SelectedClip[] =
    selection.length > 1
      ? seq.tracks.flatMap((track) =>
          track.clips
            .filter((c) => selection.includes(c.id))
            .map((clip) => ({
              clip,
              track,
              emitsAudio:
                !isTitleClip(clip) &&
                clipEmitsAudio(track, clip) &&
                (track.kind === 'audio' || !!project.assets[clip.assetId]?.hasAudio),
            })),
        )
      : []
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
            trackId={selectedTrack?.id}
            audioFirst={selectedTrack?.kind === 'audio'}
            linkedAudio={
              selected.linkId !== undefined && selectedTrack?.kind === 'video'
                ? seq.tracks
                    .filter((t) => t.kind === 'audio')
                    .flatMap((t) => t.clips)
                    .find((c) => c.linkId === selected.linkId)
                : undefined
            }
          />
        </div>
      ) : multi.length > 1 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MultiInspector selected={multi} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <SlidersHorizontal size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <div className="text-[12px] text-text-muted">Select a clip to edit its properties</div>
        </div>
      )}
    </aside>
  )
}
