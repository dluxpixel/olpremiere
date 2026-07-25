import {
  Bookmark,
  Expand,
  Gauge,
  Hand,
  Headphones,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Mic,
  MousePointer2,
  Music as MusicIcon,
  Plus,
  Scissors,
  SlidersHorizontal,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  addClipFromAsset,
  addClipWithLinkedAudio,
  addTrack,
  clipDurationS,
  clipEndS,
  clipGroupIds,
  closeAllGaps,
  closeGapBefore,
  collectSnapPoints,
  gapBefore,
  moveGroup,
  rateStretchGroup,
  rippleTrimGroup,
  rippleTrimTo,
  rollEditTo,
  slideClip,
  slipClip,
  slipGroup,
  snapTime,
  splitGroup,
  trimClipTo,
  trimGroup,
} from '../engine/timeline'
import { clipKeyframeTimes } from '../engine/keyframes'
import { TRANSITION_KINDS, TRANSITION_LABELS, type TransitionKind } from '../engine/render/types'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { workArea } from '../engine/workArea'
import { applyEffect, moveClipKeyframe, removeClipTransition, setClipTransition } from '../state/clipEdits'
import { ASSET_MIME, EFFECT_MIME, SFX_MIME, TRANSITION_MIME, dragHasType, edgeForOffset } from '../state/dnd'
import { insertSfxAtPlayhead } from '../state/sfxActions'
import { comboLabel } from '../keymap'
import {
  activeSequence,
  audioTracks,
  videoTracks,
  type AutoLevel,
  type Clip,
  type Id,
  type MediaAsset,
  type Sequence,
  type Track,
} from '../engine/types'
import { pausePlayback } from '../state/playbackControl'
import { addAdjustmentClip, addTitleClip } from '../state/titleActions'
import { copySelection, cutSelection, duplicateSelection, pasteAtPlayhead } from '../state/clipboard'
import { copyClipAttributes, hasClipAttributes, pasteClipAttributes } from '../state/attributes'
import { normalizeClipGain } from '../state/audioActions'
import {
  allTextPresets,
  applyTextPresetToClips,
  captureTextPreset,
  useTextPresets,
} from '../state/textPresets'
import {
  crossfadeWithNeighbour,
  deleteSelected,
  setClipFade,
  splitAtPlayhead,
  topAndTail,
} from '../state/clipEdits'
import { impactAtPlayhead, punchInAtPlayhead, punchOnBeats, rampWorkArea, whipToNext } from '../state/motionActions'
import { autoCaptionFromClip } from '../state/transcribeActions'
import { setTrackAudioRole, setTrackAutoLevel, setTrackPan, setTrackVolumeDb } from '../state/trackEdits'
import {
  applyTrackPreset,
  defaultTrackPresetId,
  listTrackPresets,
  removeTrackPreset,
  saveTrackPresetFromCurrent,
  setDefaultTrackPreset,
} from '../state/trackTemplate'
import { appearanceMenuItems, titleFontSizeItems } from '../state/clipMenus'
import { openContextMenu, type MenuItem } from '../state/contextMenu'
import { useBlobUrl } from '../state/blobUrls'
import { useFilmstrip } from '../state/filmstrips'
import { ClipWaveform } from './ClipWaveform'
import { PlayheadLine, RemotePlayheads } from './PlayheadWidgets'
import { pointOnScrollbar } from './scrollbarGuard'
import {
  MAX_PX_PER_S,
  MIN_PX_PER_S,
  updateActiveSequence,
  useStore,
  zoomIn,
  zoomOut,
  type Tool,
} from '../state/store'
import { useToasts } from '../state/toasts'
import { IconButton } from '../ui/Button'

const RULER_H = 28
const HEADERS_W = 178
const SNAP_PX = 8
/** Pointer travel below this is a click (move playhead), not a clip drag. */
const CLICK_SLOP_PX = 4

/**
 * Signed gesture delta for the live drag readout: compact timecode plus total
 * frames, e.g. "+00:00:12 / +14f". ASCII sign only. The hours group is dropped
 * (deltas that long do not happen in hand edits) so the tip stays glanceable.
 */
const fmtDelta = (deltaS: number, fps: number): string => {
  const fpsInt = Math.max(1, Math.round(fps))
  const frames = Math.round(Math.abs(deltaS) * fpsInt)
  const sign = deltaS < 0 ? '-' : '+'
  const tc = formatTimecode(Math.abs(deltaS), fps)
  const shown = tc.startsWith('00:') ? tc.slice(3) : tc
  return `${sign}${shown} / ${sign}${frames}f`
}
// The add-track button row lives at the bottom of the HEADERS column. The lanes
// column carries a spacer of the SAME height so both columns scroll to the same
// depth - otherwise, with many tracks, the buttons sit below the lanes' scroll
// range and become unreachable.
const ADD_TRACK_ROW_H = 46

// ---------------------------------------------------------------------------
// Ruler

const MAJOR_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

export function tickSpecFor(pxPerS: number): { majorStepS: number; minorStepS: number } {
  const majorStepS = MAJOR_STEPS_S.find((s) => s * pxPerS >= 70) ?? 600
  return { majorStepS, minorStepS: majorStepS / 5 }
}

function rulerLabel(tS: number, fps: number, majorStepS: number): string {
  if (majorStepS < 1) return formatTimecode(tS, fps).slice(3)
  const total = Math.round(tS)
  const ss = total % 60
  const mm = Math.floor(total / 60) % 60
  const hh = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

/**
 * Ticks are built ONLY for the visible window and the component is memoized.
 * Zoomed in, majorStepS drops to 0.1s, so a 5-minute project meant ~3,600 majors
 * x 7 DOM nodes — and Ruler re-rendered with its parent, i.e. on every pointermove
 * of a clip drag or a zoom-slider drag. It sits inside the same content div as the
 * clips, which are already virtualized and memoized for exactly this reason.
 */
const Ruler = memo(function Ruler({
  contentWidth,
  lengthS,
  winStartS,
  winEndS,
}: {
  contentWidth: number
  lengthS: number
  winStartS: number
  winEndS: number
}) {
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const { majorStepS, minorStepS } = tickSpecFor(pxPerS)

  // Snap the window to the tick grid so labels never shift as you scroll.
  const from = Number.isFinite(winStartS) ? Math.max(0, Math.floor(winStartS / majorStepS) * majorStepS) : 0
  const to = Number.isFinite(winEndS) ? Math.min(lengthS, winEndS) : lengthS
  const majors: number[] = []
  for (let t = from; t <= to; t += majorStepS) majors.push(t)

  return (
    <div
      className="pointer-events-none relative shrink-0 border-b border-border bg-bg-panel"
      style={{ width: contentWidth, height: RULER_H }}
    >
      {majors.map((t) => (
        <div key={t} className="absolute bottom-0 top-0" style={{ left: t * pxPerS }}>
          <div className="absolute bottom-0 h-2.5 w-px bg-border-strong" />
          <span className="absolute left-1 top-1 font-numeric text-[11px] text-text-muted">
            {rulerLabel(t, fps, majorStepS)}
          </span>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="absolute bottom-0 h-1 w-px bg-border"
              style={{ left: i * minorStepS * pxPerS }}
            />
          ))}
        </div>
      ))}
    </div>
  )
})

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

function TrackHeader({ track }: { track: Track }) {
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

  return (
    <div
      className="flex shrink-0 flex-col justify-center gap-1 border-b border-border/60 bg-bg-panel px-2"
      style={{ height: track.height }}
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

// ---------------------------------------------------------------------------
// Toolbar

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
  { tool: 'select', label: 'Selection tool', shortcut: 'V', icon: MousePointer2 },
  { tool: 'razor', label: 'Razor (blade) tool', shortcut: 'B', icon: Scissors },
  { tool: 'hand', label: 'Hand tool', shortcut: 'H', icon: Hand },
  // No Zoom tool: the timeline already zooms four ways that do not cost you the
  // pointer (wheel, the slider, = / -, and zoom-to-fit). A modal tool whose only
  // job is to zoom means clicking a clip stops selecting it until you switch
  // back — one door per feature, and this was the worst of the four.
]

function TimelineToolbar({ onZoomFit }: { onZoomFit: () => void }) {
  const tool = useStore((s) => s.ui.tool)
  const snapping = useStore((s) => s.ui.snapping)
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const setUI = useStore((s) => s.setUI)


  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border bg-bg-panel px-2">
      {TOOLS.map(({ tool: t, label, shortcut, icon: Icon }) => (
        <IconButton
          key={t}
          size="compact"
          label={label}
          shortcut={shortcut}
          active={tool === t}
          onClick={() => setUI({ tool: t })}
        >
          <Icon size={14} strokeWidth={1.5} />
        </IconButton>
      ))}
      <div className="mx-1.5 h-4 w-px bg-border" />
      <IconButton
        size="compact"
        label={snapping ? 'Snapping on' : 'Snapping off'}
        shortcut="S"
        active={snapping}
        onClick={() => setUI({ snapping: !snapping })}
        data-testid="snap-toggle"
      >
        <Magnet size={14} strokeWidth={1.5} />
      </IconButton>
      {/* Sequences were removed 2026-07-19: separate PROJECTS already serve
          that purpose, and a second nesting level with no delete affordance
          was bloat. Projects saved with extras are split on load, see
          state/sequenceSplit.ts. */}
      <div className="mx-1.5 h-4 w-px bg-border" />
      <IconButton
        size="compact"
        label="Add title"
        shortcut="T"
        onClick={() => addTitleClip()}
        data-testid="add-title"
      >
        <Type size={14} strokeWidth={1.5} />
      </IconButton>
      <IconButton
        size="compact"
        label="Add adjustment layer (grades everything below it)"
        onClick={() => addAdjustmentClip()}
        data-testid="add-adjustment"
      >
        <SlidersHorizontal size={14} strokeWidth={1.5} />
      </IconButton>

      <div className="ml-auto flex items-center gap-1.5">
        <IconButton size="compact" label="Zoom out" shortcut="-" onClick={zoomOut}>
          <ZoomOut size={14} strokeWidth={1.5} />
        </IconButton>
        <input
          type="range"
          aria-label="Timeline zoom"
          className="h-1 w-28 accent-accent"
          min={Math.log2(MIN_PX_PER_S)}
          max={Math.log2(MAX_PX_PER_S)}
          step={0.01}
          value={Math.log2(pxPerS)}
          onChange={(e) =>
            // The toolbar renders outside the lanes component - route through
            // the same anchored-zoom event the keymap uses.
            window.dispatchEvent(
              new CustomEvent('reel:zoom', { detail: { pxPerS: 2 ** Number(e.target.value) } }),
            )
          }
        />
        <IconButton size="compact" label="Zoom in" shortcut="=" onClick={zoomIn}>
          <ZoomIn size={14} strokeWidth={1.5} />
        </IconButton>
        <IconButton size="compact" label="Zoom to fit" shortcut="\" onClick={onZoomFit}>
          <Expand size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Clip

function familyFor(asset: MediaAsset | undefined): { bg: string; bd: string } {
  if (!asset) return { bg: 'var(--color-bg-input)', bd: 'var(--color-border-strong)' }
  if (asset.kind === 'audio') return { bg: 'var(--color-clip-audio)', bd: 'var(--color-clip-audio-bd)' }
  if (asset.kind === 'image') return { bg: 'var(--color-clip-image)', bd: 'var(--color-clip-image-bd)' }
  return { bg: 'var(--color-clip-video)', bd: 'var(--color-clip-video-bd)' }
}

interface ClipViewProps {
  clip: Clip
  asset: MediaAsset | undefined
  trackKind: 'video' | 'audio'
  trackHeight: number
  pxPerS: number
  selected: boolean
  /** Locked tracks reject every mutation, including effect/transition drops. */
  locked: boolean
  /**
   * False when a non-select tool is active or the track is locked: the trim
   * zones and fade dots hide, so the cursor never advertises a gesture the
   * pointer-down handlers would refuse. Also lets razor/hand presses land on
   * the clip itself instead of being swallowed by an edge handle.
   */
  interactive: boolean
  /** One-shot accent pulse for a genuinely NEW clip. With virtualization a
   *  mount can also be a scroll-in, so newness is decided by the parent. */
  pop: boolean
  onClipPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void
  onTrimPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'in' | 'out') => void
  onClipContextMenu: (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => void
  onFadeCommit: (clipId: Id, edge: 'in' | 'out', seconds: number) => void
  /** Live tooltip while dragging a fade handle (null clears it). */
  onFadePreview: (tip: { x: number; y: number; text: string } | null) => void
}

// Memoized: during a drag, previewSeq re-renders the lane tree every
// pointermove, but the engine preserves object identity for untouched clips -
// so with stable handler props, every clip NOT being dragged skips its render
// (filmstrip, waveform, fades and all). This is the big drag-feel win on
// caption-heavy timelines.
const ClipView = memo(function ClipView({
  clip,
  asset,
  trackKind,
  trackHeight,
  pxPerS,
  selected,
  locked,
  interactive,
  pop,
  onClipPointerDown,
  onTrimPointerDown,
  onClipContextMenu,
  onFadeCommit,
  onFadePreview,
}: ClipViewProps) {
  const left = clip.startS * pxPerS
  const durS = clipDurationS(clip)
  const width = Math.max(4, durS * pxPerS)
  const innerH = Math.max(1, trackHeight - 6)
  // Titles are generated (no asset): a distinct violet family + the text label.
  const isTitle = clip.title !== undefined
  const isAdjustment = clip.adjustment === true
  const isAudio = !isTitle && !isAdjustment && trackKind === 'audio'
  // Colour by the TRACK: an audio-track clip is audio-family even when it
  // references a video asset (a linked-audio split).
  const { bg, bd } = isTitle
    ? { bg: 'var(--color-clip-title)', bd: 'var(--color-clip-title-bd)' }
    : isAdjustment
      ? { bg: 'var(--color-accent-quiet)', bd: 'var(--color-accent)' }
      : trackKind === 'audio'
        ? { bg: 'var(--color-clip-audio)', bd: 'var(--color-clip-audio-bd)' }
        : familyFor(asset)
  const kind = isTitle ? 'title' : isAdjustment ? 'adjustment' : trackKind
  // The clip label mirrors the rendered case (textCase) so a lowercase/UPPERCASE
  // toggle visibly updates the timeline chip too, not just the preview.
  const titleText = isTitle
    ? clip.title!.textCase === 'upper'
      ? (clip.title!.text || 'Title').toUpperCase()
      : clip.title!.textCase === 'lower'
        ? (clip.title!.text || 'Title').toLowerCase()
        : clip.title!.text || 'Title'
    : ''
  const label = isTitle ? titleText : isAdjustment ? 'Adjustment' : (asset?.name ?? 'Missing media')
  const thumb = useBlobUrl(isTitle || isAdjustment || trackKind === 'audio' ? undefined : asset?.thumbnailKey)
  // Filmstrip across the whole clip (real NLE look); the single poster frame
  // stays as the instant placeholder while a strip generates.
  const strip = useFilmstrip(
    isTitle || trackKind === 'audio' ? undefined : asset,
    width,
    clip.inS,
    clip.outS,
    clip.speed,
  )

  // Fade drag: dragRef holds the gesture; fadePreview drives the live overlay.
  // The committed value is computed purely from the pointer + dragRef on release
  // (no stale state, no StrictMode double-commit).
  const fadeDragRef = useRef<{ edge: 'in' | 'out'; startX: number; startVal: number } | null>(null)
  const [fadePreview, setFadePreview] = useState<{ edge: 'in' | 'out'; val: number } | null>(null)
  const fadeInS = fadePreview?.edge === 'in' ? fadePreview.val : clip.fadeInS
  const fadeOutS = fadePreview?.edge === 'out' ? fadePreview.val : clip.fadeOutS

  const valFor = (d: { edge: 'in' | 'out'; startX: number; startVal: number }, clientX: number): number => {
    const delta = (clientX - d.startX) / pxPerS
    const raw = d.edge === 'in' ? d.startVal + delta : d.startVal - delta
    return Math.max(0, Math.min(durS, raw))
  }
  const beginFade = (e: ReactPointerEvent<HTMLDivElement>, edge: 'in' | 'out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startVal = edge === 'in' ? clip.fadeInS : clip.fadeOutS
    fadeDragRef.current = { edge, startX: e.clientX, startVal }
    setFadePreview({ edge, val: startVal })
  }
  const moveFade = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = fadeDragRef.current
    if (!d) return
    const val = valFor(d, e.clientX)
    setFadePreview({ edge: d.edge, val })
    onFadePreview({ x: e.clientX, y: e.clientY - 34, text: `Fade ${d.edge} ${val.toFixed(2)}s` })
  }
  const endFade = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = fadeDragRef.current
    fadeDragRef.current = null
    setFadePreview(null)
    onFadePreview(null)
    if (!d) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const val = valFor(d, e.clientX)
    if (Math.abs(val - d.startVal) > 1e-4) onFadeCommit(clip.id, d.edge, val)
  }

  const fadeInPx = fadeInS * pxPerS
  const fadeOutPx = fadeOutS * pxPerS

  // Keyframes, drawn ON the clip the way CapCut does — until now they existed
  // only inside the Inspector's 240px lane, so nothing on the timeline said a
  // clip was animated at all, let alone WHERE. Clip-local seconds map straight
  // to px at the current zoom.
  // Depends on exactly the two fields keyframes can live in; taking the whole
  // clip would recompute on every move, trim and rename.
  const { keyframes: clipKfs, effects: clipFx } = clip
  const keyframeTimes = useMemo(
    () => clipKeyframeTimes({ keyframes: clipKfs, effects: clipFx }),
    [clipKfs, clipFx],
  )

  // Dragging a diamond retimes the whole MOMENT. Live position is local state so
  // the drag is smooth; the commit is a single undo step on release, the same
  // shape the fade handles use.
  const kfDragRef = useRef<{ fromT: number; startX: number } | null>(null)
  const [kfPreview, setKfPreview] = useState<{ fromT: number; t: number } | null>(null)
  const beginKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>, t: number) => {
    if (e.button !== 0 || locked) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    kfDragRef.current = { fromT: t, startX: e.clientX }
    setKfPreview({ fromT: t, t })
  }
  // Takes the gesture explicitly rather than reading the ref: the commit path
  // clears the ref first, so reading it there silently produced t=0 and every
  // drag landed on the clip's head.
  const kfTimeAt = (d: { fromT: number; startX: number }, clientX: number): number =>
    Math.max(0, Math.min(durS, d.fromT + (clientX - d.startX) / pxPerS))
  const moveKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = kfDragRef.current
    if (!d) return
    setKfPreview({ fromT: d.fromT, t: kfTimeAt(d, e.clientX) })
  }
  const endKeyframeDrag = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = kfDragRef.current
    kfDragRef.current = null
    setKfPreview(null)
    if (!d) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const t = kfTimeAt(d, e.clientX)
    if (Math.abs(t - d.fromT) > 1e-4) moveClipKeyframe(clip.id, d.fromT, t)
  }

  // A transition's mark can never be wider than the clip it sits on, or two
  // long ones on a short clip would draw past each other.
  const halfPx = width / 2
  const transitionInPx = Math.min(halfPx, (clip.transitionIn?.durationS ?? 0) * pxPerS)
  const transitionOutPx = Math.min(halfPx, (clip.transitionOut?.durationS ?? 0) * pxPerS)

  // Effect / transition drops land on the clip itself. A transition takes the
  // edge nearest the cursor; `fxDropEdge` previews which one while hovering.
  const [fxDropEdge, setFxDropEdge] = useState<'in' | 'out' | null>(null)
  const [fxDropHot, setFxDropHot] = useState(false)

  // offsetX is relative to whatever CHILD is under the cursor (waveform, label,
  // fade handle), not the clip. Measure against the clip's own box instead.
  const offsetInClip = (e: DragEvent<HTMLDivElement>): number =>
    e.clientX - e.currentTarget.getBoundingClientRect().left

  const fxDragOver = (e: DragEvent<HTMLDivElement>) => {
    // A locked track rejects grades exactly like it rejects trims and moves.
    // (Found in review: this was the ONE mutation path that ignored the lock.)
    if (locked) return
    const t = e.dataTransfer.types
    const isEffect = dragHasType(t, EFFECT_MIME)
    const isTransition = dragHasType(t, TRANSITION_MIME)
    if (!isEffect && !isTransition) return
    // Neither effects nor transitions composite on audio (resolveFrame skips
    // audio tracks entirely), so either one dropped there would render nothing.
    // Refuse both here so the cursor shows "no-drop" instead of accepting
    // something dead.
    if (isAudio) return
    // Beat the track-level asset drop handler to the event.
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setFxDropHot(true)
    setFxDropEdge(isTransition ? edgeForOffset(offsetInClip(e), width) : null)
  }

  const clearFxDrop = () => {
    setFxDropHot(false)
    setFxDropEdge(null)
  }

  // dragleave also fires when the cursor crosses between a clip's own children,
  // which would flicker the hint. Only clear when it truly leaves the clip.
  const fxDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && e.currentTarget.contains(to)) return
    clearFxDrop()
  }

  const fxDrop = (e: DragEvent<HTMLDivElement>) => {
    if (locked) return
    const effectType = e.dataTransfer.getData(EFFECT_MIME)
    const transitionKind = e.dataTransfer.getData(TRANSITION_MIME)
    if (!effectType && !transitionKind) return
    // Neither composites on audio: a transition is a shader blending two
    // PICTURES, so dropping one on an audio clip wrote a field the renderer
    // never reads and drew a mark for a transition that could not happen. Audio
    // has its own verb — "Crossfade with previous" in the clip menu.
    if (isAudio) return
    e.preventDefault()
    e.stopPropagation()
    clearFxDrop()
    if (effectType) applyEffect(clip.id, effectType)
    else setClipTransition(clip.id, edgeForOffset(offsetInClip(e), width), transitionKind as TransitionKind)
    // Reveal what just happened in the Inspector.
    useStore.getState().setUI({ selection: [clip.id] })
  }

  return (
    <div
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-kind={kind}
      // A one-shot accent pulse for a genuinely new clip (add / paste / undo-
      // restore). Mount is NOT meaningful anymore - virtualization remounts
      // clips as they scroll in - so the parent decides newness by id.
      // Family look: flat fill, a dark hairline seam (so butted cuts stay
      // visible), and a brighter 1px TOP edge in the family color. Selection
      // is a 2px lavender ring plus a slight lift in fill luminance.
      className={`group/clip absolute bottom-[3px] top-[3px] ${pop ? 'animate-[clip-pop_500ms_ease-out]' : ''} overflow-hidden rounded-clip border border-black/40 ${
        // Selection lifts the clip (offset ring + brightness); an imminent FX
        // drop is an INSET ring - the two states must never look alike.
        selected ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-app brightness-110' : ''
      } ${clip.enabled ? '' : 'opacity-40'} ${fxDropHot ? 'ring-2 ring-inset ring-accent-hover' : ''}`}
      style={{ left, width, background: bg, borderTopColor: bd }}
      onPointerDown={(e) => onClipPointerDown(e, clip)}
      onContextMenu={(e) => onClipContextMenu(e, clip)}
      onDragOver={fxDragOver}
      onDragLeave={fxDragLeave}
      onDrop={fxDrop}
    >
      {fxDropEdge && (
        <div
          data-testid="transition-drop-hint"
          className={`pointer-events-none absolute inset-y-0 w-1/2 bg-accent/25 ${fxDropEdge === 'in' ? 'left-0' : 'right-0'}`}
        />
      )}
      {isAudio && asset && <ClipWaveform clip={clip} asset={asset} width={width} height={innerH} />}
      {clip.linkId && (
        <span
          className="pointer-events-none absolute bottom-1 right-1 rounded-[3px] bg-black/45 p-0.5 text-white/80"
          title="Linked A/V"
        >
          <Link2 size={9} strokeWidth={2} />
        </span>
      )}
      {strip && width > 48 ? (
        <img
          src={strip}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-80"
        />
      ) : (
        thumb &&
        width > 48 && (
          <img
            src={thumb}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-y-0 left-0 h-full w-auto object-cover opacity-80"
          />
        )
      )}
      {/* Solid name strip, only over footage imagery: a text-shadow alone
          can't hold 11px text over bright frames, and flat family fills must
          stay flat (no gradients anywhere). */}
      {width > 48 && (strip || thumb) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[15px] bg-black/45" />
      )}
      <span className="pointer-events-none absolute left-1.5 right-1.5 top-0.5 truncate text-[11px] font-medium text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
        {label}
      </span>

      {keyframeTimes.length > 0 && width > 8 && (
        <div data-testid="clip-keyframes" className="absolute inset-x-0 bottom-0 h-3">
          {keyframeTimes.map((t, i) => {
            const live = kfPreview?.fromT === t ? kfPreview.t : t
            const x = live * pxPerS
            if (x < -3 || x > width + 3) return null
            return (
              <span
                key={i}
                data-testid="clip-keyframe"
                title="Drag to retime this keyframe"
                className={`absolute bottom-[3px] h-[7px] w-[7px] -translate-x-1/2 rotate-45 border border-black/50 ${
                  kfPreview?.fromT === t ? 'bg-accent' : 'bg-white/90'
                } ${interactive && !locked ? 'cursor-ew-resize' : 'pointer-events-none'}`}
                style={{ left: x }}
                onPointerDown={(e) => beginKeyframeDrag(e, t)}
                onPointerMove={moveKeyframeDrag}
                onPointerUp={endKeyframeDrag}
                onPointerCancel={endKeyframeDrag}
              />
            )
          })}
        </div>
      )}

      {/* Transitions were INVISIBLE on the timeline: nothing read transitionIn/
          Out, so there was no way to see which cuts already had one, or which
          kind. A bowtie at the edge, the width of the transition, is the NLE
          convention and costs no extra hit area (it never takes pointers). */}
      {(transitionInPx > 0.5 || transitionOutPx > 0.5) && (
        <svg
          data-testid="transition-overlay"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={innerH}
          preserveAspectRatio="none"
        >
          {transitionInPx > 0.5 && (
            <g data-testid="transition-in-mark">
              <rect x={0} y={0} width={transitionInPx} height={innerH} fill="rgba(255,255,255,0.14)" />
              <path
                d={`M0,0 L${transitionInPx},${innerH} M0,${innerH} L${transitionInPx},0`}
                stroke="rgba(255,255,255,0.7)"
                strokeWidth={1}
                fill="none"
              />
            </g>
          )}
          {transitionOutPx > 0.5 && (
            <g data-testid="transition-out-mark">
              <rect
                x={width - transitionOutPx}
                y={0}
                width={transitionOutPx}
                height={innerH}
                fill="rgba(255,255,255,0.14)"
              />
              <path
                d={`M${width - transitionOutPx},0 L${width},${innerH} M${width - transitionOutPx},${innerH} L${width},0`}
                stroke="rgba(255,255,255,0.7)"
                strokeWidth={1}
                fill="none"
              />
            </g>
          )}
        </svg>
      )}

      {(fadeInPx > 0.5 || fadeOutPx > 0.5) && (
        <svg
          data-testid="fade-overlay"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={innerH}
          preserveAspectRatio="none"
        >
          {fadeInPx > 0.5 && (
            <>
              <path d={`M0,0 L${fadeInPx},0 L0,${innerH} Z`} fill="rgba(0,0,0,0.4)" />
              <line x1={0} y1={innerH} x2={fadeInPx} y2={0} stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
            </>
          )}
          {fadeOutPx > 0.5 && (
            <>
              <path d={`M${width},0 L${width - fadeOutPx},0 L${width},${innerH} Z`} fill="rgba(0,0,0,0.4)" />
              <line x1={width - fadeOutPx} y1={0} x2={width} y2={innerH} stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
            </>
          )}
        </svg>
      )}

      {/* Fade dots share the clip's corners with the trim zones - on narrow
          clips they'd fight for the same pixels, so they step aside. */}
      {width >= 32 && interactive && (
        <>
          <div
            data-testid="fade-in-handle"
            className="absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-white/80 bg-white/40 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ left: Math.min(width, Math.max(0, fadeInPx)) }}
            title="Drag to fade in"
            onPointerDown={(e) => beginFade(e, 'in')}
            onPointerMove={moveFade}
            onPointerUp={endFade}
            onPointerCancel={endFade}
          />
          <div
            data-testid="fade-out-handle"
            className="absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-white/80 bg-white/40 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ left: Math.max(0, width - fadeOutPx) }}
            title="Drag to fade out"
            onPointerDown={(e) => beginFade(e, 'out')}
            onPointerMove={moveFade}
            onPointerUp={endFade}
            onPointerCancel={endFade}
          />
        </>
      )}

      {/* Trim zones shrink on short clips so at least half the body stays
          grabbable - a 0.2s SFX at default zoom is 12px wide, and two fixed
          6px handles used to swallow it whole. Below ~10px, trim by keyboard
          (Q/W) or zoom in; the whole clip is for moving. */}
      {width >= 10 && interactive && (
        <>
          <div
            data-testid="trim-in"
            className="absolute inset-y-0 left-0 cursor-w-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ width: width < 24 ? Math.max(3, Math.floor(width / 4)) : 6 }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onTrimPointerDown(e, clip, 'in')
            }}
          />
          <div
            data-testid="trim-out"
            className="absolute inset-y-0 right-0 cursor-e-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
            style={{ width: width < 24 ? Math.max(3, Math.floor(width / 4)) : 6 }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onTrimPointerDown(e, clip, 'out')
            }}
          />
        </>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Timeline

/**
 * A stable-identity wrapper around a fresh-every-render closure. The returned
 * function never changes, but always calls the latest closure - what memoized
 * children need from handler props without threading useCallback dependency
 * lists through the Timeline's very large drag closures.
 */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}

type Drag =
  | {
      kind: 'move'
      clipId: Id
      grabOffsetS: number
      trackKind: 'video' | 'audio'
      /** Pointer-down spot: release within CLICK_SLOP_PX = a click, not a drag. */
      downClientX: number
      downClientY: number
      /**
       * The REST of a multi-selection (one entry per link group, original
       * startS at grab time): grabbing one selected clip moves them all,
       * matching Alt+Arrow nudge - anything else silently destroys the
       * selection's relative timing.
       */
      others: { id: Id; startS0: number }[]
      /**
       * Click-without-drag on an already-multi-selected clip collapses the
       * selection to just it (narrowing without deselect-all); a real drag
       * still moves the whole group.
       */
      collapseCandidate: boolean
    }
  /** `solo`: this half was singled out before the grab → trim it alone. */
  | { kind: 'trim'; clipId: Id; edge: 'in' | 'out'; ripple: boolean; solo: boolean }
  /** Alt+edge-drag: retime the clip (speed changes, source in/out stay put). */
  | { kind: 'stretch'; clipId: Id; edge: 'in' | 'out' }
  /** `solo`: this half was singled out before the grab → slip it alone. */
  | { kind: 'slip'; clipId: Id; startXPx: number; solo: boolean }
  /** Ctrl+Alt+edge-drag: roll the shared cut - both outer ends stay fixed. */
  | { kind: 'roll'; leftId: Id; rightId: Id }
  /** Ctrl+Alt+body-drag: slide the clip - neighbours absorb, totals preserved. */
  | { kind: 'slide'; clipId: Id; grabOffsetS: number; neighborIds: Id[] }
  | { kind: 'scrub' }
  /**
   * Shift/Ctrl+drag on empty lane space: rubber-band select. Content
   * coordinates. `additive` (Ctrl/Cmd) unions the rectangle's hits onto `base`
   * - the selection that existed when the drag began - so you can build a
   * selection up in passes, exactly like dragging a box on the desktop.
   */
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; base: Id[] }
  | { kind: 'hand'; startX: number; startY: number; scrollLeft: number; scrollTop: number }

/**
 * Footer bookmark: the shelf of NAMED track setups (state/trackTemplate.ts).
 * Clicking opens the app menu at the button - picking a preset reshapes the
 * current tracks, and one preset carries the flag for what new videos start
 * from (the checkmark). `count` only steers the tooltip; the presets themselves
 * live in localStorage, so the menu re-reads them on every open.
 */
function TrackPresetMenuButton() {
  const [count, setCount] = useState(() => listTrackPresets().length)

  const buildItems = (): MenuItem[] => {
    const presets = listTrackPresets()
    const defaultId = defaultTrackPresetId()
    const refresh = () => setCount(listTrackPresets().length)

    const items: MenuItem[] =
      presets.length > 0
        ? presets.map((p) => ({
            label: p.name,
            checked: p.id === defaultId,
            onClick: () => applyTrackPreset(p.id),
          }))
        : [{ label: 'No saved track setups yet', disabled: true }]

    items.push({
      label: 'Save current setup as preset...',
      separator: true,
      onClick: () => {
        // A menu row is a button, so there is nowhere to type inside the menu
        // and the app has no small single-field dialog primitive. The browser
        // prompt is the honest option here.
        const name = window.prompt('Name this track setup', `Setup ${presets.length + 1}`)
        if (name === null) return
        saveTrackPresetFromCurrent(name)
        refresh()
      },
    })

    if (presets.length > 0) {
      items.push({
        label: 'Set as default for new videos',
        submenu: presets.map((p) => ({
          label: p.name,
          checked: p.id === defaultId,
          // Picking the one already flagged clears it: new videos go back to
          // the stock tracks. This is where the old "Clear" action lives now.
          onClick: () => {
            setDefaultTrackPreset(p.id === defaultId ? null : p.id)
            refresh()
          },
        })),
      })
      items.push({
        label: 'Remove preset',
        submenu: presets.map((p) => ({
          label: p.name,
          danger: true,
          onClick: () => {
            removeTrackPreset(p.id)
            refresh()
          },
        })),
      })
    }
    return items
  }

  return (
    <button
      type="button"
      data-testid="save-track-template"
      aria-haspopup="menu"
      aria-label="Track setup presets"
      title={
        count > 0
          ? `Track setups: pick one to apply it to these tracks, or save the current setup (${count} saved)`
          : 'Track setups: save the current tracks as a preset you can pick later'
      }
      className="flex shrink-0 items-center justify-center rounded-[4px] border border-border px-1.5 py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
      onClick={(e) => {
        // Anchored to the button, not the pointer, so a keyboard activation
        // (clientX/Y = 0) still opens the menu on the button instead of the
        // top-left corner. ContextMenu clamps it into the viewport.
        const r = e.currentTarget.getBoundingClientRect()
        openContextMenu({ preventDefault: () => {}, clientX: r.left, clientY: r.bottom + 4 }, buildItems())
      }}
    >
      {/* h-[17px] ≈ the siblings' 11px text line box, so all three footer
          buttons land the same height (the icon itself stays 12px). */}
      <Bookmark size={12} strokeWidth={1.75} className="h-[17px]" />
    </button>
  )
}

export function Timeline({ height }: { height: number }) {
  const project = useStore((s) => s.project)
  const seq = activeSequence(project)
  const assets = project.assets
  const pxPerS = useStore((s) => s.ui.pxPerS)
  // DELIBERATELY no playheadS subscription: the transport ticks it every frame,
  // and a hook here re-renders this whole component tree at the display refresh
  // rate - the old "laggy preview". Handlers read it via useStore.getState();
  // the red line + timecodes are imperative leaves (PlayheadWidgets).
  const playing = useStore((s) => s.ui.playing)
  const snapping = useStore((s) => s.ui.snapping)
  const tool = useStore((s) => s.ui.tool)
  const selection = useStore((s) => s.ui.selection)
  const setUI = useStore((s) => s.setUI)
  const show = useToasts((s) => s.show)

  /**
   * Had the user singled this clip out BEFORE grabbing its edge? Selecting ONE
   * half of a linked A/V pair and trimming it means "trim just this clip", so
   * shortening the audio no longer shortens the video. With nothing selected -
   * or the whole pair selected - the edge still trims the pair together, which
   * IS the point of the link. Must be read before the grab's own select().
   */
  const soloTrimIntent = (clipId: Id): boolean =>
    selection.length > 0 &&
    selection.includes(clipId) &&
    !clipGroupIds(seq, clipId).every((g) => selection.includes(g))

  /**
   * Trimming never touches linkId, so a solo-trimmed pair stays linked and keeps
   * moving together - only their lengths differ.
   */
  const trimFnFor = (solo: boolean, ripple: boolean) => {
    if (solo) return ripple ? rippleTrimTo : trimClipTo
    return ripple ? rippleTrimGroup : trimGroup
  }

  const lanesRef = useRef<HTMLDivElement>(null)
  // Auto-follow suspension: manualScrollUntil holds a timestamp during which the
  // user's own scroll wins; programmaticScroll marks our own scrollLeft writes.
  const manualScrollUntil = useRef(0)
  const programmaticScroll = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)

  const [drag, setDrag] = useState<Drag | null>(null)
  const [previewSeq, setPreviewSeq] = useState<Sequence | null>(null)
  const [snapIndicatorT, setSnapIndicatorT] = useState<number | null>(null)
  const [trimTip, setTrimTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [dropPreview, setDropPreview] = useState<{ trackId: Id; tS: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hoverLane, setHoverLane] = useState<{ trackId: Id; valid: boolean } | null>(null)
  const [razorHover, setRazorHover] = useState<{ t: number; top: number } | null>(null)
  const dragFinal = useRef<{ trackId: Id; tS: number } | null>(null)
  // Right-drag box-select: a right-button drag on empty timeline rubber-bands a
  // selection (David finds this easier than Ctrl+drag). rightMarqueeRef marks an
  // in-flight right-drag; suppressContextRef swallows the contextmenu that fires
  // on right-button release so a drag-select never pops a menu.
  const rightMarqueeRef = useRef(false)
  // Timestamp of the last right-drag select. The contextmenu fired by that drag
  // is swallowed only if it lands within SUPPRESS_MS - a timestamp (not a bare
  // flag) so a stale suppression can never block a later, legit right-click.
  const suppressContextRef = useRef(0)

  const renderSeq = previewSeq ?? seq
  const vTracks = useMemo(() => [...videoTracks(renderSeq)].reverse(), [renderSeq])
  const aTracks = useMemo(() => audioTracks(renderSeq), [renderSeq])
  const hasClips = seq.tracks.some((t) => t.clips.length > 0)
  const area = workArea(seq)

  const lengthS = Math.max(120, seq.durationS + 60)
  const contentWidth = lengthS * pxPerS

  // --- Clip virtualization -------------------------------------------------
  // Only clips intersecting the visible time range (+ one full viewport of
  // margin each side, so ordinary scrolling never pops clips in at the edge)
  // are mounted. Until the first measure, everything renders (null viewport).
  const [viewport, setViewport] = useState<{ left: number; width: number } | null>(null)
  const scrollRafRef = useRef(0)
  const scheduleViewportMeasure = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = lanesRef.current
      if (el) setViewport({ left: el.scrollLeft, width: el.clientWidth })
    })
  }, [])
  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
    const ro = new ResizeObserver(scheduleViewportMeasure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
  }, [scheduleViewportMeasure])
  const winStartS = viewport ? (viewport.left - viewport.width) / pxPerS : -Infinity
  const winEndS = viewport ? (viewport.left + viewport.width * 2) / pxPerS : Infinity

  // Pop gating: ids seen on the previous commit. A clip id NOT in the set is
  // genuinely new (add / paste / undo-restore) and gets the one-shot pulse; a
  // virtualization remount is already in the set and stays quiet.
  const seenClipIdsRef = useRef<Set<string>>(new Set())
  const seenClipIds = seenClipIdsRef.current
  useEffect(() => {
    const ids = new Set<string>()
    for (const t of seq.tracks) for (const c of t.clips) ids.add(c.id)
    seenClipIdsRef.current = ids
  }, [seq])

  // Lane geometry in content space (below the ruler), for pointer hit tests.
  const laneInfos = useMemo(() => {
    const infos: { track: Track; top: number }[] = []
    let top = RULER_H
    for (const t of vTracks) {
      infos.push({ track: t, top })
      top += t.height
    }
    top += 2 // video/audio divider
    for (const t of aTracks) {
      infos.push({ track: t, top })
      top += t.height
    }
    return infos
  }, [vTracks, aTracks])

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const laneAt = (y: number): Track | null => {
    for (const { track, top } of laneInfos) {
      if (y >= top && y < top + track.height) return track
    }
    return null
  }

  const snapWithIndicator = (tS: number, excludeClipId?: Id | Id[]): number => {
    if (!snapping) {
      setSnapIndicatorT(null)
      return tS
    }
    // Exclude the whole link group of EVERY seed id: a linked A/V pair trims/
    // moves together, so the partner's stale edges must not magnetize the
    // gesture back onto itself. Roll/slide pass every clip whose edges ARE the
    // gesture's own origin (left+right of the cut; the slid clip + neighbours)
    // - otherwise the origin stays a snap magnet and fine adjustments no-op.
    const seeds = excludeClipId === undefined ? [] : Array.isArray(excludeClipId) ? excludeClipId : [excludeClipId]
    const excludeClipIds = seeds.length > 0 ? seeds.flatMap((id) => clipGroupIds(seq, id)) : undefined
    const points = collectSnapPoints(seq, {
      ...(excludeClipIds ? { excludeClipIds } : {}),
      playheadS: useStore.getState().ui.playheadS,
    })
    const r = snapTime(tS, points, SNAP_PX / pxPerS)
    setSnapIndicatorT(r.snapped ? r.t : null)
    return r.t
  }

  // Zoom re-anchors scrollLeft in the SAME event as the pxPerS change, so the
  // virtualization window must be re-measured synchronously too - the async
  // scroll-event measure lands after paint, and one frame culled against the
  // stale scrollLeft blanks every visible clip.
  const measureViewportNow = () => {
    const el = lanesRef.current
    if (!el) return
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
    setViewport({ left: el.scrollLeft, width: el.clientWidth })
  }

  const zoomAround = (clientX: number, factor: number) => {
    const el = lanesRef.current
    if (!el) return
    const old = useStore.getState().ui.pxPerS
    const next = Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, old * factor))
    if (next === old) return
    const rect = el.getBoundingClientRect()
    const tAt = (clientX - rect.left + el.scrollLeft) / old
    setUI({ pxPerS: next })
    el.scrollLeft = Math.max(0, tAt * next - (clientX - rect.left))
    measureViewportNow()
  }

  // Keyboard / toolbar / slider zoom: anchor on the playhead when it's in
  // view, else the viewport center - zooming must never slide the thing you
  // are looking at out of the window (raw setUI({pxPerS}) drifts toward t=0).
  const zoomTo = (nextRaw: number) => {
    const el = lanesRef.current
    if (!el) return
    const old = useStore.getState().ui.pxPerS
    const next = Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, nextRaw))
    if (next === old) return
    const playheadS = useStore.getState().ui.playheadS
    const viewStartS = el.scrollLeft / old
    const viewEndS = (el.scrollLeft + el.clientWidth) / old
    const anchorS =
      playheadS >= viewStartS && playheadS <= viewEndS ? playheadS : (viewStartS + viewEndS) / 2
    const anchorPx = anchorS * old - el.scrollLeft
    setUI({ pxPerS: next })
    el.scrollLeft = Math.max(0, anchorS * next - anchorPx)
    measureViewportNow()
  }

  // "=" / "-" in the central keymap (store.zoomIn/zoomOut dispatch this).
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent<{ factor?: number; pxPerS?: number }>).detail
      if (detail?.pxPerS !== undefined) zoomTo(detail.pxPerS)
      else zoomTo(useStore.getState().ui.pxPerS * (detail?.factor ?? 1))
    }
    window.addEventListener('reel:zoom', onZoom)
    return () => window.removeEventListener('reel:zoom', onZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- pointer interactions -------------------------------------------------

  const beginDrag = (e: ReactPointerEvent, d: Drag) => {
    lanesRef.current?.setPointerCapture(e.pointerId)
    setDrag(d)
  }

  // --- edge auto-scroll during drags ---------------------------------------
  // Speed ramps 4→20 px/frame with proximity to the container edge. The rAF
  // loop marks its scrollLeft writes as programmatic (playback-follow must not
  // suspend) and re-runs the drag math from the last pointer position.
  const lastDragPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const edgeScrollRaf = useRef<number | null>(null)
  const EDGE_ZONE_PX = 32

  const edgeSpeed = (el: HTMLElement, clientX: number): number => {
    const r = el.getBoundingClientRect()
    const leftGap = clientX - r.left
    const rightGap = r.right - clientX
    if (leftGap < EDGE_ZONE_PX) return -(4 + (16 * (EDGE_ZONE_PX - Math.max(0, leftGap))) / EDGE_ZONE_PX)
    if (rightGap < EDGE_ZONE_PX) return 4 + (16 * (EDGE_ZONE_PX - Math.max(0, rightGap))) / EDGE_ZONE_PX
    return 0
  }

  const stopEdgeScroll = () => {
    if (edgeScrollRaf.current !== null) cancelAnimationFrame(edgeScrollRaf.current)
    edgeScrollRaf.current = null
  }

  const maybeEdgeScroll = () => {
    const el = lanesRef.current
    const p = lastDragPointer.current
    if (!el || !p || edgeSpeed(el, p.clientX) === 0) {
      stopEdgeScroll()
      return
    }
    if (edgeScrollRaf.current !== null) return // loop already alive
    const step = () => {
      const el2 = lanesRef.current
      const p2 = lastDragPointer.current
      if (!el2 || !p2) {
        edgeScrollRaf.current = null
        return
      }
      const sp = edgeSpeed(el2, p2.clientX)
      if (sp === 0) {
        edgeScrollRaf.current = null
        return
      }
      const before = el2.scrollLeft
      programmaticScroll.current = true
      el2.scrollLeft = Math.max(0, before + sp)
      // At the rail ends nothing moved - don't spin the loop for free.
      if (el2.scrollLeft === before) {
        edgeScrollRaf.current = null
        return
      }
      handleLanesPointerMove(p2)
      edgeScrollRaf.current = requestAnimationFrame(step)
    }
    edgeScrollRaf.current = requestAnimationFrame(step)
  }

  // A dying component must never leave a scroll loop running.
  useEffect(() => stopEdgeScroll, [])

  // Move the grabbed clip's group to tS, then shift every other selected
  // group by the same delta on its own track - direction-ordered so earlier
  // moves never collide with clips that are themselves about to move (the
  // same trick as nudgeSelection). ONE sequence in, one out: preview and the
  // single-dispatch commit share it byte-for-byte.
  const moveSelectionWith = (
    base: Sequence,
    grabbedId: Id,
    targetTrackId: Id,
    tS: number,
    others: { id: Id; startS0: number }[],
  ): Sequence => {
    const grabbed = base.tracks.flatMap((t) => t.clips).find((c) => c.id === grabbedId)
    if (!grabbed) return base
    const deltaS = tS - grabbed.startS
    let next = moveGroup(base, grabbedId, targetTrackId, tS)
    if (others.length === 0 || deltaS === 0) return next
    const ordered = [...others].sort((a, b) => (deltaS > 0 ? b.startS0 - a.startS0 : a.startS0 - b.startS0))
    for (const o of ordered) {
      const tr = next.tracks.find((t) => t.clips.some((c) => c.id === o.id))
      const oc = tr?.clips.find((c) => c.id === o.id)
      if (!tr || !oc) continue
      next = moveGroup(next, o.id, tr.id, Math.max(0, oc.startS + deltaS))
    }
    return next
  }

  const handleClipPointerDown = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    // Any fresh press on a clip clears a stale right-drag suppression (e.g. a
    // right-drag that released over the track headers/monitor never got cleared),
    // so the next right-click always opens the menu.
    suppressContextRef.current = 0
    if (e.button !== 0) return
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (!track) return
    if (tool === 'hand') {
      beginHand(e)
      return
    }
    if (tool === 'razor') {
      if (track.locked) return
      const t = quantizeToFrame(contentPoint(e).x / pxPerS, seq.fps)
      updateActiveSequence('Split clip', (sq) => splitGroup(sq, clip.id, t))
      return
    }
    // Selection tool: select, then start a move (or Alt = slip) drag.
    // Read the A/V-link intent BEFORE the select below, exactly like the trim
    // path: grabbing always selects the clip, so asking afterwards would report
    // "solo" every time and quietly kill linked slipping.
    const soloSlip = soloTrimIntent(clip.id)
    if (e.shiftKey) {
      setUI({
        selection: selection.includes(clip.id)
          ? selection.filter((id) => id !== clip.id)
          : [...selection, clip.id],
      })
    } else if (!selection.includes(clip.id)) {
      setUI({ selection: [clip.id] })
    }
    if (track.locked) return
    const { x } = contentPoint(e)
    dragFinal.current = null
    // Ctrl+Alt = the advanced-trim pair (roll on an edge, slide on the body).
    // Checked before plain Alt: a Ctrl+Alt press has altKey === true too.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const idx = track.clips.findIndex((c) => c.id === clip.id)
      const neighborIds = [track.clips[idx - 1]?.id, track.clips[idx + 1]?.id].filter((id): id is Id => !!id)
      beginDrag(e, { kind: 'slide', clipId: clip.id, grabOffsetS: x / pxPerS - clip.startS, neighborIds })
      return
    }
    if (e.altKey) {
      beginDrag(e, { kind: 'slip', clipId: clip.id, startXPx: x, solo: soloSlip })
      return
    }
    // Multi-selection: carry every OTHER selected unlocked clip (deduped by
    // link group - moveGroup moves partners) so the whole selection travels.
    const selNow = useStore.getState().ui.selection
    const others: { id: Id; startS0: number }[] = []
    if (selNow.includes(clip.id) && selNow.length > 1) {
      const seen = new Set<Id>(clipGroupIds(seq, clip.id))
      for (const tr of seq.tracks) {
        if (tr.locked) continue
        for (const c of tr.clips) {
          if (!selNow.includes(c.id) || seen.has(c.id)) continue
          for (const gid of clipGroupIds(seq, c.id)) seen.add(gid)
          others.push({ id: c.id, startS0: c.startS })
        }
      }
    }
    beginDrag(e, {
      kind: 'move',
      clipId: clip.id,
      grabOffsetS: x / pxPerS - clip.startS,
      trackKind: track.kind,
      downClientX: e.clientX,
      downClientY: e.clientY,
      others,
      collapseCandidate: !e.shiftKey && selNow.includes(clip.id) && selNow.length > 1,
    })
  }

  const handleClipContextMenu = (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => {
    // A right-drag box-select that happened to end over a clip must NOT open the
    // clip menu - swallow this one contextmenu (only if it's fresh). 0 is the
    // "nothing pending" sentinel and must never suppress: with no guard, every
    // right-click during the first 500ms after navigation (performance.now()
    // still < 500) would be swallowed.
    if (suppressContextRef.current > 0 && performance.now() - suppressContextRef.current < 500) {
      suppressContextRef.current = 0
      e.preventDefault()
      return
    }
    // Right-clicking a clip that's part of a multi-selection KEEPS the selection
    // (so "apply to all" acts on every selected clip); otherwise select just it.
    const keepSelection = selection.includes(clip.id) && selection.length > 1
    if (!keepSelection) setUI({ selection: [clip.id] })
    const selNow = keepSelection ? selection : [clip.id]
    const titleIdsSel = seq.tracks
      .flatMap((t) => t.clips)
      .filter((c) => selNow.includes(c.id) && c.title)
      .map((c) => c.id)
    const playheadS = useStore.getState().ui.playheadS
    const playheadInside = playheadS > clip.startS && playheadS < clipEndS(clip)
    // Audio clips adjacent to a same-track neighbour can be crossfaded.
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    const idx = track ? track.clips.findIndex((c) => c.id === clip.id) : -1
    const prev = track && idx > 0 ? track.clips[idx - 1] : undefined
    const next = track ? track.clips[idx + 1] : undefined
    const canXfadePrev = !!prev && Math.abs(clipEndS(prev) - clip.startS) < 1e-3
    const canXfadeNext = !!next && Math.abs(clipEndS(clip) - next.startS) < 1e-3
    const crossfadeItems =
      track?.kind === 'audio' && (canXfadePrev || canXfadeNext)
        ? [
            ...(canXfadePrev
              ? [{ label: 'Crossfade with previous', onClick: () => crossfadeWithNeighbour(clip.id, 'prev') }]
              : []),
            ...(canXfadeNext
              ? [{ label: 'Crossfade with next', separator: !canXfadePrev, onClick: () => crossfadeWithNeighbour(clip.id, 'next') }]
              : []),
          ]
        : []

    // Local Whisper captions + beat-driven punches, for audio clips with sound.
    const captionItems =
      track?.kind === 'audio' && assets[clip.assetId]?.hasAudio
        ? [
            { label: 'Normalize volume', onClick: () => void normalizeClipGain(clip.id) },
            { label: 'Auto-Caption from voiceover', onClick: () => void autoCaptionFromClip(clip.id) },
            { label: 'Punch video on beats', onClick: () => void punchOnBeats(clip.id) },
          ]
        : []

    // Jettism Motion Pack, for video-track clips.
    const nextClip = next
    const nextTouches = !!nextClip && Math.abs(clipEndS(clip) - nextClip.startS) < 1e-3
    // Punch stays top-level (its P key is the workhorse); the rest fold into a
    // Motion submenu so the menu doesn't wall up. Speed-ramp flattens INTO it
    // (one-level submenu limit) as three leaves.
    const motionItems: MenuItem[] =
      track?.kind === 'video'
        ? [
            {
              label: 'Punch in at playhead',
              shortcut: 'P',
              separator: true,
              disabled: !playheadInside,
              onClick: () => punchInAtPlayhead(clip.id),
            },
            {
              label: 'Motion',
              submenu: [
                { label: 'Impact hit at playhead', disabled: !playheadInside, onClick: () => impactAtPlayhead(clip.id) },
                { label: 'Whip to next clip', disabled: !nextTouches, onClick: () => whipToNext(clip.id) },
                ...[2, 3, 0.5].map((f, i) => ({
                  label: `Speed ramp ×${f}`,
                  separator: i === 0,
                  onClick: () => rampWorkArea(clip.id, f),
                })),
              ],
            },
          ]
        : []

    // Transitions had NO menu at all: audio got one-click "Crossfade with
    // previous", video got nothing but a drag from the Effects browser. Both
    // edges are offered on every video clip, because a lone edge now runs the
    // real transition rather than degrading to a fade to black.
    const transitionItems: MenuItem[] =
      track?.kind === 'video'
        ? (['in', 'out'] as const).map((edge) => {
            const current = edge === 'in' ? clip.transitionIn : clip.transitionOut
            const neighbour = edge === 'in' ? canXfadePrev : canXfadeNext
            return {
              label: edge === 'in' ? 'Transition in' : 'Transition out',
              separator: edge === 'in',
              submenu: [
                {
                  label: 'None',
                  checked: !current,
                  onClick: () => removeClipTransition(clip.id, edge),
                },
                ...TRANSITION_KINDS.map((kind, i) => ({
                  // A lone edge plays the transition against nothing, which is a
                  // real look — say so rather than hiding half the list.
                  label: neighbour ? TRANSITION_LABELS[kind] : `${TRANSITION_LABELS[kind]} (from nothing)`,
                  separator: i === 0,
                  checked: current?.type === kind,
                  onClick: () => setClipTransition(clip.id, edge, kind),
                })),
              ],
            }
          })
        : []

    // One-click green-screen removal on a media clip (video/image that HAS a screen).
    // Applies the chroma-key effect, which defaults to keying green at a clean
    // strength — drop-and-done, then fine-tune in the Inspector if edges remain.
    const greenScreenItems: MenuItem[] =
      track?.kind === 'video' && !clip.title && !clip.adjustment
        ? [{ label: 'Remove green screen', onClick: () => applyEffect(clip.id, 'chromaKey') }]
        : []

    // "How it appears" - font/size quick-picks + entrance/exit/speed animation,
    // TITLE clips only (video animates via transitions + the Motion submenu).
    // All compile to keyframes (preview == export). Shared with the
    // preview-monitor menu via state/clipMenus.
    // Both target the selected TITLES - so right-clicking one of several
    // selected captions applies to all, and video clips inside a mixed
    // selection are left alone.
    const titleMenuIds = titleIdsSel.length > 1 ? titleIdsSel : [clip.id]
    const appearanceItems = [
      ...titleFontSizeItems(clip, titleMenuIds),
      ...appearanceMenuItems(clip, titleMenuIds),
    ]

    // Multi-selected text also gets whole STYLE presets (font+case+colour+outline
    // +animation together) applied to all, plus Save. (Entrance/Exit/Speed above
    // already apply to every selected title.)
    const bulkTitleItems: MenuItem[] =
      titleIdsSel.length > 1
        ? [
            {
              label: `Style preset (all ${titleIdsSel.length})`,
              separator: true,
              submenu: [
                ...allTextPresets().map((p) => ({
                  label: p.name,
                  onClick: () => applyTextPresetToClips(titleIdsSel, p),
                })),
                {
                  label: 'Save current as preset',
                  separator: true,
                  onClick: () => {
                    // Capture the clip you right-clicked (fallback: first selected title).
                    const src = clip.title ? clip.id : titleIdsSel[0]
                    const p = captureTextPreset(src, `Style ${useTextPresets.getState().saved.length + 1}`)
                    if (p) {
                      useTextPresets.getState().add(p)
                      show(`Saved "${p.name}"`, 'success')
                    }
                  },
                },
              ],
            },
          ]
        : []

    openContextMenu(e, [
      { label: 'Copy', shortcut: comboLabel('mod+c'), onClick: () => copySelection() },
      { label: 'Cut', shortcut: comboLabel('mod+x'), onClick: cutSelection },
      { label: 'Duplicate', shortcut: comboLabel('mod+d'), onClick: duplicateSelection },
      { label: 'Paste', shortcut: comboLabel('mod+v'), onClick: pasteAtPlayhead },
      { label: 'Copy attributes', shortcut: comboLabel('mod+alt+c'), separator: true, onClick: () => copyClipAttributes(clip.id) },
      {
        label: keepSelection ? `Paste attributes to ${selNow.length}` : 'Paste attributes',
        shortcut: comboLabel('mod+alt+v'),
        disabled: !hasClipAttributes(),
        onClick: () => pasteClipAttributes(keepSelection ? selNow : [clip.id]),
      },
      ...crossfadeItems,
      ...transitionItems,
      ...captionItems,
      ...motionItems,
      ...greenScreenItems,
      ...appearanceItems,
      ...bulkTitleItems,
      {
        label: 'Trim head to playhead',
        shortcut: 'Q',
        separator: true,
        disabled: !playheadInside,
        onClick: () => topAndTail('in'),
      },
      {
        label: 'Trim tail to playhead',
        shortcut: 'W',
        disabled: !playheadInside,
        onClick: () => topAndTail('out'),
      },
      {
        // C is the branded single-key cut; the old label advertised only the
        // secondary Ctrl+K chord and hid the key everyone should learn.
        label: keepSelection ? `Split ${selNow.length} clips at playhead` : 'Split at playhead',
        shortcut: 'C',
        disabled: !playheadInside,
        // The SAME verb the C key runs. This used to split only the clip you
        // right-clicked while the Delete item one row below said "Delete 5 clips".
        onClick: () => splitAtPlayhead(),
      },
      {
        // TWO deletes, not three (David, 2026-07-18): Delete is selection-
        // scoped (deleteScoped - an audio half goes alone, a video clip takes
        // its pair), which retired the enumerated "Delete audio only (keep
        // video)" / "Delete video only" items. The label says which it'll be.
        label: keepSelection
          ? `Delete ${selNow.length} clips`
          : clip.linkId !== undefined && track?.kind === 'audio'
            ? 'Delete audio'
            : 'Delete',
        shortcut: 'Del',
        separator: true,
        // The SAME verb the Del key runs, lock filter included — the inline copy
        // here skipped it, so right-click Delete removed clips Del refused to.
        onClick: () => deleteSelected(false),
      },
      {
        label: keepSelection ? `Ripple delete ${selNow.length} clips` : 'Ripple delete',
        shortcut: 'Shift+Del',
        danger: true,
        onClick: () => deleteSelected(true),
      },
      {
        label: 'Close gap before',
        separator: true,
        disabled: gapBefore(seq, clip.id) <= 1e-4,
        onClick: () => updateActiveSequence('Close gap', (sq) => closeGapBefore(sq, clip.id)),
      },
      ...(track
        ? [
            {
              label: 'Close all gaps on track',
              onClick: () => updateActiveSequence('Close gaps', (sq) => closeAllGaps(sq, track.id)),
            },
          ]
        : []),
    ])
  }

  const handleTrimPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: Clip,
    edge: 'in' | 'out',
  ) => {
    if (e.button !== 0 || tool !== 'select') return
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (!track || track.locked) return
    // Read the intent BEFORE the select below: grabbing the edge always selects
    // the clip, so asking afterwards would say "solo" every time and quietly
    // kill linked trimming. Having singled this half out ALREADY (clicked it,
    // partner not selected) is what means "trim just this one".
    const solo = soloTrimIntent(clip.id)
    setUI({ selection: [clip.id] })
    dragFinal.current = null
    // Edge modifiers: Ctrl = ripple trim, Alt = rate stretch, Ctrl+Alt = roll.
    // Roll is checked FIRST - a Ctrl+Alt press satisfies both single checks.
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const idx = track.clips.findIndex((c) => c.id === clip.id)
      const neighbor = edge === 'out' ? track.clips[idx + 1] : track.clips[idx - 1]
      if (neighbor) {
        beginDrag(e, {
          kind: 'roll',
          leftId: edge === 'out' ? clip.id : neighbor.id,
          rightId: edge === 'out' ? neighbor.id : clip.id,
        })
        return
      }
      // No neighbour to roll against - fall through to a plain trim.
    }
    if (e.altKey && !(e.ctrlKey || e.metaKey)) {
      beginDrag(e, { kind: 'stretch', clipId: clip.id, edge })
      return
    }
    // `!e.altKey` keeps the no-neighbour Ctrl+Alt fallthrough a PLAIN trim, as
    // documented above - Ctrl alone still means ripple.
    beginDrag(e, {
      kind: 'trim',
      clipId: clip.id,
      edge,
      ripple: (e.ctrlKey || e.metaKey) && !e.altKey,
      solo,
    })
  }

  const beginHand = (e: ReactPointerEvent) => {
    const el = lanesRef.current
    if (!el) return
    beginDrag(e, {
      kind: 'hand',
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    })
  }

  const scrubPlayheadTo = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = Math.max(0, (clientX - rect.left) / pxPerS)
    setUI({ playheadS: quantizeToFrame(t, seq.fps) })
  }

  // Vegas-style: click empty space (a track lane, or the blank area below the
  // tracks) to move the playhead there; drag to scrub. Deselects clips.
  const beginEmptyScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === 'hand') beginHand(e)
    else if (tool === 'select') {
      // Shift OR Ctrl/Cmd + drag = rubber-band select; plain click/drag =
      // scrub (Vegas). Ctrl/Cmd is additive (matches desktop box-select), Shift
      // replaces - so either modifier lets you "click and drag to select
      // multiple", the way David expects it to work.
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const { x, y } = contentPoint(e)
        const additive = e.ctrlKey || e.metaKey
        setMarquee({ x0: x, y0: y, x1: x, y1: y })
        beginDrag(e, {
          kind: 'marquee',
          x0: x,
          y0: y,
          additive,
          base: additive ? [...useStore.getState().ui.selection] : [],
        })
        return
      }
      pausePlayback()
      setUI({ selection: [] })
      scrubPlayheadTo(e.clientX)
      beginDrag(e, { kind: 'scrub' })
    }
  }

  // Right-button drag on empty timeline = rubber-band box-select (any tool).
  // Reuses the exact marquee drag machinery; replace-mode (fresh box).
  const beginRightMarquee = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = contentPoint(e)
    rightMarqueeRef.current = true
    suppressContextRef.current = 0
    setMarquee({ x0: x, y0: y, x1: x, y1: y })
    beginDrag(e, { kind: 'marquee', x0: x, y0: y, additive: false, base: [] })
  }

  const handleLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.button === 2) {
      beginRightMarquee(e)
      return
    }
    if (e.button !== 0) return
    beginEmptyScrub(e)
  }

  // The scroll container's own background (the blank area beneath the last
  // track). Bubbled events from lanes/clips/ruler are ignored via the target
  // check, so only a click on the empty background scrubs.
  const handleLanesBackgroundPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return
    // Ignore clicks on the native scrollbars: they sit inside the element's box
    // but past its client area, so without this, dragging the horizontal scrollbar
    // scrubs the playhead to it.
    const el = e.currentTarget
    if (pointOnScrollbar(el.getBoundingClientRect(), el.clientWidth, el.clientHeight, e.clientX, e.clientY)) return
    if (e.target !== e.currentTarget && e.target !== contentRef.current) return
    if (e.button === 2) {
      beginRightMarquee(e)
      return
    }
    beginEmptyScrub(e)
  }

  const handleLanesPointerMove = (e: { clientX: number; clientY: number }) => {
    if (!drag) {
      // Razor hover: preview the exact cut line the blade will make.
      if (tool === 'razor') {
        const { x, y } = contentPoint(e)
        const lane = laneAt(y)
        setRazorHover(lane ? { t: quantizeToFrame(Math.max(0, x / pxPerS), seq.fps), top: y } : null)
      } else if (razorHover) {
        setRazorHover(null)
      }
      return
    }
    if (razorHover) setRazorHover(null)
    if (drag.kind === 'hand') {
      const el = lanesRef.current
      if (el) {
        el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
        el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
      }
      return
    }
    // Every non-hand drag edge-scrolls: park the pointer near a side and the
    // view travels, re-running this handler from the parked coordinates so the
    // clip/trim/scrub keeps following. Pro-NLE table stakes.
    lastDragPointer.current = { clientX: e.clientX, clientY: e.clientY }
    maybeEdgeScroll()
    if (drag.kind === 'scrub') {
      scrubPlayheadTo(e.clientX)
      return
    }
    if (drag.kind === 'marquee') {
      // A right-drag that actually moved must swallow the contextmenu that fires
      // on button release, or the box-select would also pop a menu.
      if (rightMarqueeRef.current) suppressContextRef.current = performance.now()
      const p = contentPoint(e)
      setMarquee({ x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y })
      // Live-select every clip whose box overlaps the rectangle.
      const loX = Math.min(drag.x0, p.x)
      const hiX = Math.max(drag.x0, p.x)
      const loY = Math.min(drag.y0, p.y)
      const hiY = Math.max(drag.y0, p.y)
      const hits: Id[] = []
      for (const { track, top } of laneInfos) {
        if (top + track.height < loY || top > hiY) continue
        for (const c of track.clips) {
          const cx0 = c.startS * pxPerS
          const cx1 = clipEndS(c) * pxPerS
          if (cx1 >= loX && cx0 <= hiX) hits.push(c.id)
        }
      }
      // Additive (Ctrl/Cmd): fold the box onto the pre-drag selection, deduped.
      setUI({ selection: drag.additive ? [...new Set([...drag.base, ...hits])] : hits })
      return
    }
    const { x, y } = contentPoint(e)
    if (drag.kind === 'move') {
      const desiredRaw = quantizeToFrame(Math.max(0, x / pxPerS - drag.grabOffsetS), seq.fps)
      const current = seq.tracks.find((t) => t.clips.some((c) => c.id === drag.clipId))
      const clip = current?.clips.find((c) => c.id === drag.clipId)
      if (!current || !clip) return
      const durS = clipDurationS(clip)
      // Snap the leading edge, then the trailing edge; keep the closer catch.
      // The dragged clip's whole link group is excluded: its audio partner's
      // stale edges would otherwise snap the drag back to where it started.
      const points = snapping
        ? collectSnapPoints(seq, {
            excludeClipIds: clipGroupIds(seq, drag.clipId),
            playheadS: useStore.getState().ui.playheadS,
          })
        : []
      let desired = desiredRaw
      if (snapping) {
        const threshold = SNAP_PX / pxPerS
        const s1 = snapTime(desiredRaw, points, threshold)
        const s2 = snapTime(desiredRaw + durS, points, threshold)
        if (s1.snapped && (!s2.snapped || Math.abs(s1.t - desiredRaw) <= Math.abs(s2.t - durS - desiredRaw))) {
          desired = s1.t
          setSnapIndicatorT(s1.t)
        } else if (s2.snapped) {
          desired = s2.t - durS
          setSnapIndicatorT(s2.t)
        } else {
          setSnapIndicatorT(null)
        }
      }
      const hovered = laneAt(y)
      const valid = !!hovered && hovered.kind === drag.trackKind && !hovered.locked
      const target = valid ? hovered! : current
      // Tint the lane you're over - green ok, red no (wrong kind / locked).
      setHoverLane(hovered && hovered.id !== current.id ? { trackId: hovered.id, valid } : null)
      const finalT = Math.max(0, desired)
      dragFinal.current = { trackId: target.id, tS: finalT }
      // Moves get the live readout too: new start timecode + signed delta.
      // Suppressed inside the click slop so a plain click never flashes it.
      if (Math.hypot(e.clientX - drag.downClientX, e.clientY - drag.downClientY) >= CLICK_SLOP_PX) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Move  ${formatTimecode(finalT, seq.fps)}  ${fmtDelta(finalT - clip.startS, seq.fps)}`,
        })
      }
      setPreviewSeq(moveSelectionWith(seq, drag.clipId, target.id, finalT, drag.others))
    } else if (drag.kind === 'slip') {
      const deltaS = quantizeToFrame((x - drag.startXPx) / pxPerS, seq.fps)
      dragFinal.current = { trackId: '', tS: deltaS }
      const next = (drag.solo ? slipClip : slipGroup)(seq, assets, drag.clipId, deltaS)
      setPreviewSeq(next)
      const slipped = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const slipOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (slipped && slipOrig) {
        // Delta = the APPLIED source offset (slipClip clamps at the media ends),
        // so the readout never claims more slip than actually happened.
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Slip  in ${formatTimecode(slipped.inS, seq.fps)} · out ${formatTimecode(slipped.outS, seq.fps)}  ${fmtDelta(slipped.inS - slipOrig.inS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'roll') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      // Exclude BOTH sides of the cut: the left clip's out edge IS the origin
      // cut - leaving it in the snap set magnetizes every fine roll back to a
      // no-op.
      const t = snapWithIndicator(tRaw, [drag.leftId, drag.rightId])
      dragFinal.current = { trackId: '', tS: t }
      const next = rollEditTo(seq, assets, drag.leftId, drag.rightId, t)
      setPreviewSeq(next)
      const right = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.rightId)
      const rightOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.rightId)
      if (right && rightOrig) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Roll  ${formatTimecode(right.startS, seq.fps)}  ${fmtDelta(right.startS - rightOrig.startS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'slide') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS - drag.grabOffsetS), seq.fps)
      // Neighbours' facing edges ARE the slid clip's origin (slide requires
      // adjacency) - exclude them or the origin stays a snap magnet.
      const t = snapWithIndicator(tRaw, [drag.clipId, ...drag.neighborIds])
      dragFinal.current = { trackId: '', tS: t }
      const next = slideClip(seq, assets, drag.clipId, t)
      setPreviewSeq(next)
      const slid = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const slidOrig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (slid && slidOrig) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Slide  ${formatTimecode(slid.startS, seq.fps)}  ${fmtDelta(slid.startS - slidOrig.startS, seq.fps)}`,
        })
      }
    } else if (drag.kind === 'stretch') {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      // Snapping still applies: stretching a clip to end exactly on a marker or
      // a neighbour's edge is the whole point of the gesture half the time.
      const t = snapWithIndicator(tRaw, drag.clipId)
      dragFinal.current = { trackId: '', tS: t }
      const next = rateStretchGroup(seq, drag.clipId, drag.edge, t)
      setPreviewSeq(next)
      const stretched = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (stretched) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Speed ${Math.round(Math.abs(stretched.speed) * 100)}%  ·  ${formatTimecode(clipDurationS(stretched), seq.fps)}`,
        })
      }
    } else {
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      const t = snapWithIndicator(tRaw, drag.clipId)
      dragFinal.current = { trackId: '', tS: t }
      const next = trimFnFor(drag.solo, drag.ripple)(seq, assets, drag.clipId, drag.edge, t)
      setPreviewSeq(next)
      const trimmed = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      const orig = seq.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (trimmed && orig) {
        const edgeT = drag.edge === 'in' ? trimmed.startS : clipEndS(trimmed)
        const origT = drag.edge === 'in' ? orig.startS : clipEndS(orig)
        // Ripple-in keeps startS fixed; show the source-window edge instead.
        const shownT = drag.ripple && drag.edge === 'in' ? trimmed.inS : edgeT
        const delta = drag.ripple && drag.edge === 'in' ? trimmed.inS - orig.inS : edgeT - origT
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `${drag.ripple ? 'Ripple  ' : ''}${formatTimecode(shownT, seq.fps)}  ${fmtDelta(delta, seq.fps)}`,
        })
      }
    }
  }

  const handleLanesPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    stopEdgeScroll()
    lastDragPointer.current = null
    setHoverLane(null)
    lanesRef.current?.releasePointerCapture(e.pointerId)
    // Marquee is selection-only (no undo dispatch) - just drop the rectangle.
    if (drag.kind === 'marquee') {
      rightMarqueeRef.current = false // keep suppressContextRef for the imminent contextmenu
      setMarquee(null)
      setDrag(null)
      return
    }
    // A release within the slop of the pointer-down is a CLICK on the clip, not
    // a drag: move the playhead there so the preview shows the spot you clicked
    // (CapCut-style), and skip the no-op move commit (keeps undo history clean).
    const isClipClick =
      drag.kind === 'move' &&
      Math.hypot(e.clientX - drag.downClientX, e.clientY - drag.downClientY) < CLICK_SLOP_PX
    if (isClipClick) {
      // Narrow a multi-selection to the clicked clip (drags keep the group).
      if (drag.kind === 'move' && drag.collapseCandidate) setUI({ selection: [drag.clipId] })
      scrubTo(drag.downClientX)
    } else if (drag.kind === 'move' && dragFinal.current) {
      const { trackId, tS } = dragFinal.current
      updateActiveSequence(drag.others.length > 0 ? 'Move clips' : 'Move clip', (sq) =>
        moveSelectionWith(sq, drag.clipId, trackId, tS, drag.others),
      )
    } else if (drag.kind === 'trim' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence(drag.ripple ? 'Ripple trim' : 'Trim clip', (sq) =>
        trimFnFor(drag.solo, drag.ripple)(sq, assets, drag.clipId, drag.edge, tS),
      )
    } else if (drag.kind === 'stretch' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Rate stretch', (sq) => rateStretchGroup(sq, drag.clipId, drag.edge, tS))
    } else if (drag.kind === 'slip' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Slip clip', (sq) => (drag.solo ? slipClip : slipGroup)(sq, assets, drag.clipId, tS))
    } else if (drag.kind === 'roll' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Roll edit', (sq) => rollEditTo(sq, assets, drag.leftId, drag.rightId, tS))
    } else if (drag.kind === 'slide' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Slide clip', (sq) => slideClip(sq, assets, drag.clipId, tS))
    }
    setDrag(null)
    setPreviewSeq(null)
    setSnapIndicatorT(null)
    setTrimTip(null)
    dragFinal.current = null
  }

  // --- drop from the media bin ----------------------------------------------

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    const isAsset = e.dataTransfer.types.includes(ASSET_MIME)
    const isSfx = e.dataTransfer.types.includes(SFX_MIME)
    if (!isAsset && !isSfx) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // Bin drags edge-scroll too (the loop only scrolls here - the preview line
    // is content-anchored, and dragover re-fires on the next mouse move).
    lastDragPointer.current = { clientX: e.clientX, clientY: e.clientY }
    maybeEdgeScroll()
    const { x, y } = contentPoint(e)
    const lane = laneAt(y)
    if (!lane || (isSfx && lane.kind !== 'audio')) {
      setDropPreview(null)
      return
    }
    const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
    const t = snapWithIndicator(tRaw)
    setDropPreview({ trackId: lane.id, tS: t })
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    const sfxId = e.dataTransfer.getData(SFX_MIME)
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    stopEdgeScroll()
    lastDragPointer.current = null
    setDropPreview(null)
    setSnapIndicatorT(null)
    // A dragged SFX lands on the hovered audio lane at the drop time.
    if (sfxId) {
      e.preventDefault()
      const { x, y } = contentPoint(e)
      const lane = laneAt(y)
      const target = lane?.kind === 'audio' && !lane.locked ? lane : audioTracks(seq).find((t) => !t.locked)
      const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
      const points = snapping ? collectSnapPoints(seq, { playheadS: useStore.getState().ui.playheadS }) : []
      const t = snapping ? snapTime(tRaw, points, SNAP_PX / pxPerS).t : tRaw
      void insertSfxAtPlayhead(sfxId, { atS: t, ...(target ? { trackId: target.id } : {}) })
      return
    }
    if (!assetId) return
    e.preventDefault()
    const asset = assets[assetId]
    if (!asset) return
    const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
    const { x, y } = contentPoint(e)
    const hovered = laneAt(y)
    const target =
      hovered && hovered.kind === wantKind && !hovered.locked
        ? hovered
        : seq.tracks.find((t) => t.kind === wantKind && !t.locked)
    if (!target) {
      show(`No unlocked ${wantKind} track for ${asset.name}`, 'danger')
      return
    }
    const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
    const points = snapping
      ? collectSnapPoints(seq, { playheadS: useStore.getState().ui.playheadS })
      : []
    const t = snapping ? snapTime(tRaw, points, SNAP_PX / pxPerS).t : tRaw
    // Dropping a video with audio splits its sound to a linked audio clip on A1.
    if (asset.kind === 'video' && asset.hasAudio) {
      const audioTrack = audioTracks(seq).find((tr) => !tr.locked) ?? null
      updateActiveSequence(`Add ${asset.name}`, (sq) =>
        addClipWithLinkedAudio(sq, target.id, audioTrack?.id ?? null, asset, t).seq,
      )
      return
    }
    updateActiveSequence(`Add ${asset.name}`, (sq) => addClipFromAsset(sq, target.id, asset, t).seq)
  }

  // --- scroll/zoom behaviors --------------------------------------------------

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomAround(e.clientX, e.deltaY < 0 ? 1.2 : 1 / 1.2)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Modifier-hover cursor language: holding Alt arms slip (clip body) and rate
  // stretch (edge), Ctrl+Alt arms slide (body) and roll (edge), and Alt flips
  // the zoom tool to zoom-out. Written straight to the container's dataset so
  // a held key never touches React state; index.css keys on
  // [data-tool][data-mods] to re-cursor the targets.
  useEffect(() => {
    const write = (ctrl: boolean, alt: boolean) => {
      const el = lanesRef.current
      if (!el) return
      const mods = ctrl && alt ? 'ctrl-alt' : alt ? 'alt' : ctrl ? 'ctrl' : ''
      if (mods) el.dataset.mods = mods
      else delete el.dataset.mods
    }
    const onKey = (e: KeyboardEvent) => write(e.ctrlKey || e.metaKey, e.altKey)
    // Alt+Tab and friends can steal the keyup: clear on window blur too.
    const clear = () => write(false, false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Keep the playhead visible while playing (page-scroll like Premiere), but
  // never fight a manual scroll: suspend auto-follow for a moment after the
  // user scrolls the lanes themselves.
  // Auto-follow rides an IMPERATIVE playhead subscription (not a React effect
  // keyed on playheadS - that re-ran per transport tick). pxPerS via ref so
  // zoom changes mid-play take effect without resubscribing.
  const pxPerSRef = useRef(pxPerS)
  pxPerSRef.current = pxPerS
  useEffect(() => {
    if (!playing) return
    return useStore.subscribe(
      (s) => s.ui.playheadS,
      (t) => {
        const el = lanesRef.current
        if (!el) return
        if (performance.now() < manualScrollUntil.current) return
        const px = t * pxPerSRef.current
        const left = el.scrollLeft
        const right = left + el.clientWidth
        // Page forward when the playhead runs off the right edge; re-centre only
        // when it is fully off-screen (e.g. after Home). Do NOT tug back when the
        // user has scrolled ahead of the playhead.
        if (px > right - 40 || px < left - el.clientWidth) {
          programmaticScroll.current = true
          el.scrollLeft = Math.max(0, px - 80)
        }
      },
    )
  }, [playing])

  const zoomFit = () => {
    const el = lanesRef.current
    if (!el || seq.durationS <= 0) return
    const next = Math.min(
      MAX_PX_PER_S,
      Math.max(MIN_PX_PER_S, (el.clientWidth - 40) / seq.durationS),
    )
    setUI({ pxPerS: next })
    el.scrollLeft = 0
    measureViewportNow()
  }

  // "\" in the central keymap.
  useEffect(() => {
    window.addEventListener('reel:zoom-fit', zoomFit)
    return () => window.removeEventListener('reel:zoom-fit', zoomFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq.durationS])

  const scrubTo = (clientX: number) => {
    pausePlayback()
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = Math.max(0, (clientX - rect.left) / pxPerS)
    setUI({ playheadS: quantizeToFrame(t, seq.fps) })
  }

  // The pointer always says what a press would do: a razor blade for the
  // blade tool, grab that closes to grabbing while a hand-pan is live, zoom
  // magnifier (flipped to zoom-out by Alt via CSS on data-mods). Children
  // inherit, so the whole lane area speaks the tool. Modifier-hover cursors
  // for slip/stretch (Alt) and slide/roll (Ctrl+Alt) key off data-mods below.
  const cursorClass =
    tool === 'razor'
      ? 'cursor-razor'
      : tool === 'hand'
        ? drag?.kind === 'hand'
          ? 'cursor-grabbing'
          : 'cursor-grab'
        : ''

  // Stable identities for the ClipView handler props - without these, every
  // Timeline render (each pointermove during a drag) would hand every ClipView
  // fresh functions and defeat its memo().
  const stableClipPointerDown = useStableCallback(handleClipPointerDown)
  const stableTrimPointerDown = useStableCallback(handleTrimPointerDown)
  const stableClipContextMenu = useStableCallback(handleClipContextMenu)

  const renderLane = (track: Track, tint: string) => {
    // Drop-target feedback during a cross-track move: green valid, red no-go.
    const hov = hoverLane?.trackId === track.id ? hoverLane : null
    const hovClass = hov
      ? hov.valid
        ? 'ring-1 ring-inset ring-accent/50 bg-accent/10'
        : 'ring-1 ring-inset ring-danger/50 bg-danger/10'
      : ''
    return (
    <div
      key={track.id}
      className={`relative border-b border-border ${tint} ${hovClass} ${track.locked ? 'opacity-60' : ''}`}
      style={{ height: track.height }}
      onPointerDown={handleLanePointerDown}
    >
      {track.clips.map((clip) =>
        clipEndS(clip) < winStartS || clip.startS > winEndS ? null : (
          <ClipView
            key={clip.id}
            clip={clip}
            asset={assets[clip.assetId]}
            trackKind={track.kind}
            trackHeight={track.height}
            pxPerS={pxPerS}
            selected={selection.includes(clip.id)}
            locked={track.locked}
            interactive={tool === 'select' && !track.locked}
            pop={!seenClipIds.has(clip.id)}
            onClipPointerDown={stableClipPointerDown}
            onTrimPointerDown={stableTrimPointerDown}
            onClipContextMenu={stableClipContextMenu}
            onFadeCommit={setClipFade}
            onFadePreview={setTrimTip}
          />
        ),
      )}
      {dropPreview?.trackId === track.id && (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] bg-accent"
          style={{ left: dropPreview.tS * pxPerS }}
        />
      )}
    </div>
    )
  }

  return (
    <section
      data-testid="timeline"
      aria-label="Timeline"
      className="flex shrink-0 flex-col bg-bg-panel"
      style={{ height }}
    >
      <TimelineToolbar onZoomFit={zoomFit} />
      <div className="flex min-h-0 flex-1">
        <div
          ref={headersRef}
          data-testid="track-headers"
          className="flex shrink-0 flex-col overflow-hidden border-r border-border"
          style={{ width: HEADERS_W }}
          // The headers column is overflow-hidden (no scrollbar of its own) and is
          // kept in sync by the lanes' onScroll. But a wheel over the headers must
          // still scroll: forward it to the lanes, which mirrors back here. Without
          // this, scrolling only works with the cursor over the lanes - "can't
          // scroll on the left" once there are more tracks than fit.
          onWheel={(e) => {
            if (lanesRef.current) lanesRef.current.scrollTop += e.deltaY
          }}
        >
          <div className="shrink-0 border-b border-border" style={{ height: RULER_H }} />
          {vTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
          <div className="h-[2px] shrink-0 bg-border-strong" />
          {aTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
          {/* Blank space below the tracks: buttons to add a video or audio track.
              Fixed height, mirrored by a spacer in the lanes so the shared scroll
              can always bring these into view (see ADD_TRACK_ROW_H). */}
          <div
            className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2"
            style={{ height: ADD_TRACK_ROW_H }}
          >
            <button
              type="button"
              data-testid="add-video-track"
              className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
              onClick={() => updateActiveSequence('Add video track', (sq) => addTrack(sq, 'video'))}
              title="Add a video track"
            >
              <Plus size={12} strokeWidth={1.75} />
              Video
            </button>
            <button
              type="button"
              data-testid="add-audio-track"
              className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
              onClick={() => updateActiveSequence('Add audio track', (sq) => addTrack(sq, 'audio'))}
              title="Add an audio track"
            >
              <Plus size={12} strokeWidth={1.75} />
              Audio
            </button>
            <TrackPresetMenuButton />
          </div>
        </div>

        <div
          ref={lanesRef}
          className={`relative min-w-0 flex-1 overflow-auto ${cursorClass}`}
          data-testid="timeline-lanes"
          data-tool={tool}
          onContextMenu={(e) => {
            // No browser menu on the timeline background; also clears the
            // right-drag-select suppression flag after it's served its purpose.
            e.preventDefault()
            suppressContextRef.current = 0
          }}
          onPointerDown={handleLanesBackgroundPointerDown}
          onPointerMove={handleLanesPointerMove}
          onPointerLeave={() => razorHover && setRazorHover(null)}
          onPointerUp={handleLanesPointerUp}
          onPointerCancel={handleLanesPointerUp}
          onScroll={(e) => {
            // Track headers share vertical scroll with the lanes.
            if (headersRef.current) headersRef.current.scrollTop = e.currentTarget.scrollTop
            // A scroll we didn't trigger is the user's - suspend auto-follow so
            // playback doesn't yank the view back while they drag the scrollbar.
            if (programmaticScroll.current) programmaticScroll.current = false
            else manualScrollUntil.current = performance.now() + 2000
            // Virtualization window follows the scroll (rAF-throttled).
            scheduleViewportMeasure()
          }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={(e) => {
            if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
              setDropPreview(null)
              setSnapIndicatorT(null)
            }
          }}
        >
          <div ref={contentRef} className="relative" style={{ width: contentWidth }}>
            <div
              className="sticky top-0 z-20 cursor-ew-resize"
              data-testid="ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                scrubTo(e.clientX)
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX)
              }}
            >
              <Ruler contentWidth={contentWidth} lengthS={lengthS} winStartS={winStartS} winEndS={winEndS} />
              {/* Work area: the range an export renders. Drawn under the markers
                  so a marker sitting on the in point stays legible. */}
              {area.active && (
                <>
                  <div
                    data-testid="work-area"
                    className="pointer-events-none absolute top-0 border-x border-accent bg-accent/20"
                    style={{
                      left: area.startS * pxPerS,
                      width: Math.max(1, (area.endS - area.startS) * pxPerS),
                      height: RULER_H,
                    }}
                  />
                  <div
                    data-testid="work-area-in"
                    title={`In ${formatTimecode(area.startS, seq.fps)}`}
                    className="pointer-events-none absolute h-2 w-2 bg-accent"
                    style={{ left: area.startS * pxPerS, top: 0, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
                  />
                  <div
                    data-testid="work-area-out"
                    title={`Out ${formatTimecode(area.endS, seq.fps)}`}
                    className="pointer-events-none absolute h-2 w-2 bg-accent"
                    style={{ left: area.endS * pxPerS - 8, top: 0, clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
                  />
                </>
              )}
              {seq.markers.map((m) => (
                <div
                  key={m.id}
                  data-testid="marker"
                  title={m.label || formatTimecode(m.t, seq.fps)}
                  className="pointer-events-none absolute h-2 w-2 rotate-45 rounded-[1px]"
                  style={{ left: m.t * pxPerS - 4, top: RULER_H - 11, background: m.color }}
                />
              ))}
            </div>

            {/* Alternating lane tints: with 3+ tracks a flat wash makes lane
                targeting during drags pure guesswork. Audio lanes carry a
                whisper of the audio-clip green so the zone reads instantly. */}
            {vTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-bg-input/30' : 'bg-bg-input/[0.12]'))}
            <div className="h-[2px] bg-border-strong" />
            {aTracks.map((t, i) => renderLane(t, i % 2 === 0 ? 'bg-clip-audio/[0.08]' : 'bg-transparent'))}
            {/* Mirrors the headers' add-track row so both columns scroll to the
                same depth and those buttons stay reachable with many tracks. */}
            <div className="shrink-0" style={{ height: ADD_TRACK_ROW_H }} />

            {/* Snap lock line: keyed on the snapped time so landing on a NEW
                edge remounts it and re-fires the one-shot pulse. Reduced
                motion collapses the pulse; the line itself always shows. */}
            {snapIndicatorT !== null && (
              <div
                key={snapIndicatorT}
                data-testid="snap-line"
                className="pointer-events-none absolute bottom-0 z-30 w-px animate-[snap-pulse_240ms_ease-out] bg-accent"
                style={{ left: snapIndicatorT * pxPerS, top: RULER_H }}
              />
            )}

            {razorHover && tool === 'razor' && (
              <div
                data-testid="razor-line"
                className="pointer-events-none absolute bottom-0 z-30 w-px bg-text-primary/70"
                style={{ left: razorHover.t * pxPerS, top: RULER_H }}
              />
            )}

            {marquee && (
              <div
                className="pointer-events-none absolute z-30 rounded-[2px] border border-accent bg-accent/10"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}

            <RemotePlayheads pxPerS={pxPerS} />
            <PlayheadLine pxPerS={pxPerS} />
          </div>

          {!hasClips && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center"
              style={{ top: RULER_H }}
            >
              <span className="text-[12px] text-text-muted">Drag a clip here to start</span>
            </div>
          )}
        </div>
      </div>

      {trimTip && (
        <div
          className="pointer-events-none fixed z-[90] rounded-[4px] border border-border bg-bg-elevated px-2 py-1 font-numeric text-[11px] text-text-primary shadow-pop"
          style={{ left: trimTip.x, top: trimTip.y }}
        >
          {trimTip.text}
        </div>
      )}
    </section>
  )
}
