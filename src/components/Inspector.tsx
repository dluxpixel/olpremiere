import { AudioWaveform, Clock, Rewind, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { clipEmitsAudio } from '../engine/audio'
import { isChannelAnimated, resolveChannel } from '../engine/effects/channels'
import { clipDurationS, clipEndS, moveGroup } from '../engine/timeline'
import { formatTimecode, parseTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence, isTitleClip, type Clip, type MediaAsset, type Track } from '../engine/types'
import {
  setChannel,
  setClipDenoise,
  setClipFade,
  setClipGainDb,
  setClipSpeed,
  toggleChannelAnimation,
} from '../state/clipEdits'
import { updateActiveSequence, useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { EffectControls, PropRow, ScrubField, SectionLabel, type Spec } from './EffectControls'
import { MultiInspector, type SelectedClip } from './MultiInspector'
import { TitleControls } from './TitleControls'

const GAIN_SPEC: Spec = { min: -60, max: 12, step: 0.5, sens: 0.2 }
const FADE_SPEC: Spec = { min: 0, max: 30, step: 0.05, sens: 0.02 }
const DENOISE_SPEC: Spec = { min: 5, max: 100, step: 5, sens: 0.5 }
const SPEED_SPEC: Spec = { min: 10, max: 800, step: 1, sens: 1 }

/** Speed + reverse (Phase 7). Slotted into EffectControls via afterStack. */
function SpeedControls({ clip }: { clip: Clip }) {
  const reversed = clip.speed < 0
  const pct = Math.abs(clip.speed) * 100
  return (
    <section className="flex flex-col gap-2" data-testid="speed-controls">
      <SectionLabel>Speed</SectionLabel>
      <div className="flex flex-col gap-1">
        <PropRow
          label="Speed (%)"
          onReset={() => setClipSpeed(clip.id, reversed ? -1 : 1)}
          resetLabel="Reset speed to 100%"
        >
          <ScrubField
            value={pct}
            spec={SPEED_SPEC}
            testId="field-speed"
            ariaLabel="Speed percent"
            onCommit={(v) => setClipSpeed(clip.id, (reversed ? -1 : 1) * (v / 100))}
          />
        </PropRow>
        <PropRow label="Reverse">
          <IconButton
            label={reversed ? 'Play forward' : 'Reverse'}
            active={reversed}
            size="compact"
            data-testid="reverse-toggle"
            onClick={() => setClipSpeed(clip.id, -clip.speed)}
          >
            <Rewind size={14} strokeWidth={1.5} />
          </IconButton>
        </PropRow>
      </div>
    </section>
  )
}

/** Commit-on-release volume slider (a live commit per tick would flood undo).
 *  Value + commit come from the parent so the slider stays in agreement with
 *  the dB field beside it when volume is keyframe-animated. */
function VolumeSlider({ shown, onCommit }: { shown: number; onCommit: (db: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null)
  const value = draft ?? shown
  const commit = () => {
    if (draft !== null && draft !== shown) onCommit(draft)
    setDraft(null)
  }
  return (
    <input
      type="range"
      aria-label="Clip volume (dB)"
      data-testid="clip-volume-slider"
      className="h-1 w-20 cursor-pointer accent-accent"
      min={GAIN_SPEC.min}
      max={GAIN_SPEC.max}
      step={GAIN_SPEC.step}
      value={value}
      title={`${value > 0 ? '+' : ''}${value.toFixed(1)} dB (double-click: 0)`}
      onChange={(e) => setDraft(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onDoubleClick={() => onCommit(0)}
    />
  )
}

/**
 * Gain + fades for a clip that contributes audio (Phase 6). `linked` marks the
 * common mp4 case: the VIDEO clip is selected but its sound lives on the
 * linked audio clip - these controls edit that partner.
 */
function AudioControls({ clip, linked, playheadS }: { clip: Clip; linked?: boolean; playheadS?: number }) {
  const durMax = Math.max(0.05, clipDurationS(clip))
  // Keyframed volume: the stopwatch toggles animation; while animated the
  // field shows the RESOLVED dB at the playhead and commits write a keyframe
  // there (setChannel). The lane itself appears in Effect Controls' Keyframes
  // section automatically once the channel is animated.
  const volAnimated = isChannelAnimated(clip, 'volume')
  const volLocalT = playheadS !== undefined && playheadS >= 0 ? Math.max(0, playheadS - clip.startS) : 0
  const shownGain = volAnimated ? resolveChannel(clip, 'volume', volLocalT) : clip.audioGainDb
  return (
    <section className="flex flex-col gap-2" data-testid="audio-controls">
      <SectionLabel>Audio{linked ? ' · linked clip' : ''}</SectionLabel>
      <div className="flex flex-col gap-1">
        <PropRow
          label="Volume"
          onReset={() => (volAnimated ? setChannel(clip.id, 'volume', 0) : setClipGainDb(clip.id, 0))}
          resetLabel="Reset volume to 0 dB"
          lead={
            <IconButton
              label={volAnimated ? 'Stop animating volume' : 'Animate volume (keyframes)'}
              size="compact"
              data-testid="volume-stopwatch"
              onClick={() => toggleChannelAnimation(clip.id, 'volume')}
              className={volAnimated ? 'text-accent' : undefined}
            >
              <Clock size={13} strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          <VolumeSlider
            shown={shownGain}
            onCommit={(v) => (volAnimated ? setChannel(clip.id, 'volume', v) : setClipGainDb(clip.id, v))}
          />
          <ScrubField
            value={shownGain}
            spec={GAIN_SPEC}
            testId="field-audio-gain"
            ariaLabel="Audio gain (dB)"
            onCommit={(v) => (volAnimated ? setChannel(clip.id, 'volume', v) : setClipGainDb(clip.id, v))}
          />
        </PropRow>
        <PropRow label="Fade in (s)" onReset={() => setClipFade(clip.id, 'in', 0)} resetLabel="Reset fade in">
          <ScrubField
            value={clip.fadeInS}
            spec={{ ...FADE_SPEC, max: durMax }}
            testId="field-fade-in"
            ariaLabel="Fade in seconds"
            onCommit={(v) => setClipFade(clip.id, 'in', v)}
          />
        </PropRow>
        <PropRow label="Fade out (s)" onReset={() => setClipFade(clip.id, 'out', 0)} resetLabel="Reset fade out">
          <ScrubField
            value={clip.fadeOutS}
            spec={{ ...FADE_SPEC, max: durMax }}
            testId="field-fade-out"
            ariaLabel="Fade out seconds"
            onCommit={(v) => setClipFade(clip.id, 'out', v)}
          />
        </PropRow>
        {/* Non-destructive RNNoise (OBS's suppressor). The take stays raw -
            toggle to A/B by ear, drag the % toward natural if 100 sounds
            processed. 100% = the straight RNNoise output. */}
        <PropRow
          label="Reduce noise"
          lead={
            <IconButton
              label={clip.denoise !== undefined ? 'Turn noise reduction off' : 'Reduce background noise (RNNoise)'}
              size="compact"
              data-testid="denoise-toggle"
              onClick={() => setClipDenoise(clip.id, clip.denoise !== undefined ? undefined : 1)}
              className={clip.denoise !== undefined ? 'text-accent' : undefined}
            >
              <AudioWaveform size={13} strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          {clip.denoise !== undefined && (
            <ScrubField
              value={Math.round(clip.denoise * 100)}
              spec={DENOISE_SPEC}
              testId="field-denoise"
              ariaLabel="Noise reduction strength (%)"
              onCommit={(v) => setClipDenoise(clip.id, v / 100)}
            />
          )}
        </PropRow>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <PropRow label={label}>
      <span className="font-numeric text-ui-sm text-text-primary">{value}</span>
    </PropRow>
  )
}

/**
 * An editable timecode row: click to type an exact time, Enter/blur commits
 * (parsed + frame-quantized), Escape reverts. The commit goes through
 * moveGroup, so linked A/V travels together and overlaps resolve to the
 * nearest free slot - typing an occupied time lands beside it, not on it.
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
    <PropRow label={label}>
      {text === null ? (
        <button
          type="button"
          data-testid={testId}
          className="cursor-text rounded-field px-1 font-numeric text-ui-sm text-text-primary hover:bg-bg-elevated"
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
          className="w-[92px] rounded-field bg-bg-input px-1 text-right font-numeric text-ui-sm text-text-primary"
        />
      )}
    </PropRow>
  )
}

function ClipPanel({
  clip,
  fps,
  playheadS,
  showAudio,
  audioFirst,
  linkedAudio,
  trackId,
}: {
  clip: Clip
  fps: number
  playheadS: number
  showAudio: boolean
  /** Audio-track clips lead with the sound controls (above Speed/Duration). */
  audioFirst: boolean
  /** The linked audio partner of a video clip - its volume shows HERE. */
  linkedAudio?: Clip
  /** The clip's own track - the Start field moves it in place. */
  trackId?: string
}) {
  const isTitle = isTitleClip(clip)

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* Most-important-first (David, 2026-07-18): the EDITING controls lead -
          a title's text, a sound clip's audio, everything else's effects.
          Speed rides INSIDE EffectControls right after the stack (titles pass
          no slot: they have no speed); Audio follows; the read-only Details
          metadata sits LAST (it answers questions, it doesn't edit anything). */}
      {isTitle && (
        <>
          <TitleControls clip={clip} />
          <div className="h-px bg-border" />
        </>
      )}

      {/* A SOUND clip is about its sound: Audio leads even the effects. */}
      {audioFirst && showAudio && (
        <>
          <AudioControls clip={clip} playheadS={playheadS} />
          <div className="h-px bg-border" />
        </>
      )}

      <EffectControls
        clip={clip}
        fps={fps}
        playheadS={playheadS}
        afterStack={isTitle ? undefined : <SpeedControls clip={clip} />}
      />

      <div className="h-px bg-border" />

      {!audioFirst && showAudio && (
        <>
          <AudioControls clip={clip} playheadS={playheadS} />
          <div className="h-px bg-border" />
        </>
      )}

      {/* Clicking the mp4's VIDEO clip must still offer volume - the sound
          lives on the linked audio clip, so edit that partner right here. */}
      {!showAudio && linkedAudio && (
        <>
          <AudioControls clip={linkedAudio} linked playheadS={playheadS} />
          <div className="h-px bg-border" />
        </>
      )}

      {/* Read-only clip metadata, folded and last. Click "Details" to expand. */}
      <details className="group">
        <summary className="flex cursor-default list-none items-center justify-between text-text-muted [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Details</span>
          <span className="font-numeric text-dense text-text-secondary">{formatTimecode(clipDurationS(clip), fps)}</span>
        </summary>
        <div className="mt-2 flex flex-col gap-1">
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
    </div>
  )
}

export function Inspector({ width }: { width: number }) {
  const project = useStore((s) => s.project)
  const selection = useStore((s) => s.ui.selection)
  // FRAME-quantized playhead: the keyframe UI is frame-accurate anyway, and the
  // raw value ticks every animation frame. Even quantized, that re-rendered the
  // whole Effect Controls + KeyframeLane fps×/s DURING PLAYBACK - a big chunk of
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
        {/* The header says WHAT is being edited, not the name of one of its own
            sections - "Effect Controls" as a panel title while showing clip
            details/speed/audio was a standing source of confusion. */}
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
          {selected
            ? `Clip · ${isTitleClip(selected) ? (selected.title?.text || 'Title') : (selectedAsset?.name ?? 'Missing media')}`
            : multi.length > 1
              ? `${multi.length} clips`
              : 'Inspector'}
        </span>
      </div>
      {selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ClipPanel
            clip={selected}
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
          <div className="text-ui text-text-muted">Select a clip to edit its properties</div>
        </div>
      )}
    </aside>
  )
}
