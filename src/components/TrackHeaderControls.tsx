import { Gauge, Headphones, Lock, LockOpen, Mic, Music as MusicIcon, Volume2, VolumeX } from 'lucide-react'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { type AutoLevel, type Track } from '../engine/types'
import { deleteTrack, setTrackAudioRole, setTrackAutoLevel, setTrackPan, setTrackVolumeDb } from '../state/trackEdits'
import { openContextMenu } from '../state/contextMenu'
import { updateActiveSequence } from '../state/store'
import { IconButton } from '../ui/Button'

// ---------------------------------------------------------------------------
// Track header

/**
 * Range control that commits ONE undoable value on release (pointer-up / key-up
 * / blur), previewing locally during a drag - so dragging is never an undo
 * flood. Double-click resets to `resetTo`.
 */
function Fader({
  value,
  min,
  max,
  step,
  label,
  title,
  resetTo,
  className,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step: number
  label: string
  title: string
  resetTo: number
  className?: string
  onCommit: (v: number) => void
}) {
  const [local, setLocal] = useState<number | null>(null)
  const v = local ?? value
  const commit = () => {
    if (local !== null) {
      if (local !== value) onCommit(local)
      setLocal(null)
    }
  }
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={v}
      aria-label={label}
      title={title}
      onChange={(e) => setLocal(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onDoubleClick={() => onCommit(resetTo)}
      className={`h-1 min-w-0 cursor-pointer accent-accent ${className ?? ''}`}
    />
  )
}

const AUTO_LEVELS: { key: AutoLevel; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'low', label: 'Low (gentle)' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High (strong)' },
]

const AUDIO_ROLES: { key: Track['audioRole']; label: string }[] = [
  { key: undefined, label: 'None' },
  { key: 'voice', label: 'Voiceover (drives ducking)' },
  { key: 'music', label: 'Music (ducks under voice)' },
]

export function TrackHeader({ track }: { track: Track }) {
  const toggle = (field: 'muted' | 'solo' | 'locked', label: string) =>
    updateActiveSequence(label, (seq) => ({
      ...seq,
      tracks: seq.tracks.map((t) => (t.id === track.id ? { ...t, [field]: !t[field] } : t)),
    }))
  const isAudio = track.kind === 'audio'
  const level = track.autoLevel ?? 'off'
  const openAutoLevel = (e: ReactMouseEvent<HTMLButtonElement>) =>
    openContextMenu(
      e,
      AUTO_LEVELS.map((l) => ({
        label: l.label,
        checked: level === l.key,
        onClick: () => setTrackAutoLevel(track.id, l.key),
      })),
    )
  const openAudioRole = (e: ReactMouseEvent<HTMLButtonElement>) =>
    openContextMenu(
      e,
      AUDIO_ROLES.map((r) => ({
        label: r.label,
        checked: track.audioRole === r.key,
        onClick: () => setTrackAudioRole(track.id, r.key),
      })),
    )

  // Right-click the header itself: the delete he asked for. It lives here and
  // not on a button because a header is small and a delete button next to Mute
  // is a mis-click waiting to happen.
  const openTrackMenu = (e: ReactMouseEvent<HTMLDivElement>) =>
    openContextMenu(e, [
      {
        label: track.muted ? 'Unmute track' : 'Mute track',
        onClick: () => toggle('muted', `${track.muted ? 'Unmute' : 'Mute'} ${track.name}`),
      },
      {
        label: track.locked ? 'Unlock track' : 'Lock track',
        onClick: () => toggle('locked', `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`),
      },
      {
        label: track.clips.length > 0 ? `Delete ${track.name} and ${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}` : `Delete ${track.name}`,
        danger: true,
        onClick: () => deleteTrack(track.id),
      },
    ])

  return (
    <div
      className="flex shrink-0 flex-col justify-center gap-1 border-b border-border/60 bg-bg-panel px-2"
      style={{ height: track.height }}
      onContextMenu={openTrackMenu}
      data-testid={`track-header-${track.name}`}
    >
      <div className="flex items-center gap-0.5">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.06em] text-text-secondary">
          {track.name}
        </span>
        {/* Mute and solo carry their own signal colors (danger red, ember)
            instead of the stock lavender active, so a silenced or soloed
            track reads from across the room. Inline style wins over the
            IconButton's own active classes deterministically. */}
        <IconButton
          size="compact"
          label={track.muted ? 'Unmute track' : 'Mute track'}
          active={track.muted}
          style={track.muted ? { color: 'var(--color-danger)', background: 'rgba(255, 97, 85, 0.15)' } : undefined}
          onClick={() => toggle('muted', `${track.muted ? 'Unmute' : 'Mute'} ${track.name}`)}
        >
          {track.muted ? (
            <VolumeX size={14} strokeWidth={1.5} />
          ) : (
            <Volume2 size={14} strokeWidth={1.5} />
          )}
        </IconButton>
        <IconButton
          size="compact"
          label={track.solo ? 'Unsolo track' : 'Solo track'}
          active={track.solo}
          style={track.solo ? { color: 'var(--color-ember)', background: 'var(--color-ember-quiet)' } : undefined}
          onClick={() => toggle('solo', `${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`)}
        >
          <Headphones size={14} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          size="compact"
          label={track.locked ? 'Unlock track' : 'Lock track'}
          active={track.locked}
          onClick={() => toggle('locked', `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`)}
        >
          {track.locked ? (
            <Lock size={14} strokeWidth={1.5} />
          ) : (
            <LockOpen size={14} strokeWidth={1.5} />
          )}
        </IconButton>
        {isAudio && (
          <IconButton
            size="compact"
            label={`Auto-level (loudness): ${level}`}
            active={level !== 'off'}
            onClick={openAutoLevel}
            data-testid="autolevel-btn"
          >
            <Gauge size={14} strokeWidth={1.5} />
          </IconButton>
        )}
        {isAudio && (
          <IconButton
            size="compact"
            label={`Audio role: ${track.audioRole === 'voice' ? 'voiceover (drives ducking)' : track.audioRole === 'music' ? 'music (ducks under voice)' : 'none'}`}
            active={track.audioRole !== undefined}
            onClick={openAudioRole}
            data-testid="audiorole-btn"
          >
            {track.audioRole === 'music' ? (
              <MusicIcon size={14} strokeWidth={1.5} />
            ) : (
              <Mic size={14} strokeWidth={1.5} />
            )}
          </IconButton>
        )}
      </div>

      {isAudio && (
        <div className="flex items-center gap-1.5">
          <Volume2 size={11} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
          <Fader
            className="flex-[2]"
            value={track.volumeDb}
            min={-60}
            max={12}
            step={0.5}
            label={`${track.name} volume`}
            title={`Volume ${track.volumeDb > 0 ? '+' : ''}${track.volumeDb.toFixed(1)} dB (double-click: 0)`}
            resetTo={0}
            onCommit={(db) => setTrackVolumeDb(track.id, db)}
          />
          <span className="shrink-0 text-[9px] font-medium uppercase tracking-tight text-text-muted" aria-hidden>
            Pan
          </span>
          <Fader
            className="flex-1"
            value={track.pan}
            min={-1}
            max={1}
            step={0.02}
            label={`${track.name} pan`}
            title={`Pan ${track.pan === 0 ? 'center' : track.pan < 0 ? `${Math.round(-track.pan * 100)}% L` : `${Math.round(track.pan * 100)}% R`} (double-click: center)`}
            resetTo={0}
            onCommit={(pan) => setTrackPan(track.id, pan)}
          />
        </div>
      )}
    </div>
  )
}
