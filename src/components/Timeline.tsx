import {
  Expand,
  Gauge,
  Hand,
  Headphones,
  ListPlus,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Plus,
  Scissors,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
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
  collectSnapPoints,
  deleteClip,
  deleteGroup,
  moveGroup,
  rateStretchGroup,
  rippleDeleteGroup,
  rippleTrimGroup,
  slipClip,
  snapTime,
  splitGroup,
  trimGroup,
} from '../engine/timeline'
import type { TransitionKind } from '../engine/render/types'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { workArea } from '../engine/workArea'
import { applyEffect, setClipTransition } from '../state/clipEdits'
import { ASSET_MIME, EFFECT_MIME, TRANSITION_MIME, dragHasType, edgeForOffset } from '../state/dnd'
import { comboLabel } from '../keymap'
import {
  activeSequence,
  audioTracks,
  newSequence,
  videoTracks,
  type AutoLevel,
  type Clip,
  type Id,
  type MediaAsset,
  type Sequence,
  type Track,
} from '../engine/types'
import { pausePlayback } from '../state/playbackControl'
import { addTitleClip } from '../state/titleActions'
import { copySelection, cutSelection, duplicateSelection } from '../state/clipboard'
import { crossfadeWithNeighbour, setClipFade } from '../state/clipEdits'
import { setTrackAutoLevel, setTrackPan, setTrackVolumeDb } from '../state/trackEdits'
import { openContextMenu } from '../state/contextMenu'
import { useBlobUrl } from '../state/blobUrls'
import { ClipWaveform } from './ClipWaveform'
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
// The add-track button row lives at the bottom of the HEADERS column. The lanes
// column carries a spacer of the SAME height so both columns scroll to the same
// depth — otherwise, with many tracks, the buttons sit below the lanes' scroll
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

function Ruler({ contentWidth, lengthS }: { contentWidth: number; lengthS: number }) {
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const { majorStepS, minorStepS } = tickSpecFor(pxPerS)

  const majors: number[] = []
  for (let t = 0; t <= lengthS; t += majorStepS) majors.push(t)

  return (
    <div
      className="pointer-events-none relative shrink-0 border-b border-border bg-bg-panel"
      style={{ width: contentWidth, height: RULER_H }}
    >
      {majors.map((t) => (
        <div key={t} className="absolute bottom-0 top-0" style={{ left: t * pxPerS }}>
          <div className="absolute bottom-0 h-2.5 w-px bg-border-strong" />
          <span className="absolute left-1 top-1 text-[11px] tabular-nums text-text-muted">
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
}

// ---------------------------------------------------------------------------
// Track header

/**
 * Range control that commits ONE undoable value on release (pointer-up / key-up
 * / blur), previewing locally during a drag — so dragging is never an undo
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
  { key: 'low', label: 'Low — gentle' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High — strong' },
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
        label: level === l.key ? `${l.label}  ✓` : l.label,
        onClick: () => setTrackAutoLevel(track.id, l.key),
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
        <IconButton
          size="compact"
          label={track.muted ? 'Unmute track' : 'Mute track'}
          active={track.muted}
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
  { tool: 'zoom', label: 'Zoom tool', shortcut: 'Z', icon: ZoomIn },
]

function TimelineToolbar({ onZoomFit }: { onZoomFit: () => void }) {
  const tool = useStore((s) => s.ui.tool)
  const snapping = useStore((s) => s.ui.snapping)
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const fps = useStore((s) => activeSequence(s.project).fps)
  const project = useStore((s) => s.project)
  const setActiveSequenceId = useStore((s) => s.setActiveSequenceId)
  const dispatch = useStore((s) => s.dispatch)

  const addSequence = () => {
    dispatch('Add sequence', (p) => {
      const sq = newSequence(`Sequence ${Object.keys(p.sequences).length + 1}`)
      return { ...p, sequences: { ...p.sequences, [sq.id]: sq }, activeSequenceId: sq.id }
    })
    setUI({ playheadS: 0, selection: [] })
  }

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
        label="Snapping"
        shortcut="S"
        active={snapping}
        onClick={() => setUI({ snapping: !snapping })}
        data-testid="snap-toggle"
      >
        <Magnet size={14} strokeWidth={1.5} />
      </IconButton>
      <div className="mx-1.5 h-4 w-px bg-border" />
      <select
        data-testid="sequence-select"
        aria-label="Active sequence"
        value={project.activeSequenceId}
        onChange={(e) => setActiveSequenceId(e.target.value)}
        className="h-6 max-w-36 rounded-[4px] border border-border bg-bg-input px-1.5 text-[11px] text-text-secondary focus:border-accent focus:outline-none"
      >
        {Object.values(project.sequences).map((sq) => (
          <option key={sq.id} value={sq.id}>
            {sq.name}
          </option>
        ))}
      </select>
      <IconButton size="compact" label="New sequence" onClick={addSequence} data-testid="sequence-new">
        <ListPlus size={14} strokeWidth={1.5} />
      </IconButton>
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

      <div className="ml-auto flex items-center gap-1.5">
        <span className="mr-2 text-[11px] tabular-nums text-text-secondary">
          {formatTimecode(playheadS, fps)}
        </span>
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
          onChange={(e) => setUI({ pxPerS: 2 ** Number(e.target.value) })}
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
  onClipPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void
  onTrimPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'in' | 'out') => void
  onClipContextMenu: (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => void
  onFadeCommit: (clipId: Id, edge: 'in' | 'out', seconds: number) => void
}

function ClipView({
  clip,
  asset,
  trackKind,
  trackHeight,
  pxPerS,
  selected,
  locked,
  onClipPointerDown,
  onTrimPointerDown,
  onClipContextMenu,
  onFadeCommit,
}: ClipViewProps) {
  const left = clip.startS * pxPerS
  const durS = clipDurationS(clip)
  const width = Math.max(4, durS * pxPerS)
  const innerH = Math.max(1, trackHeight - 6)
  // Titles are generated (no asset): a distinct violet family + the text label.
  const isTitle = clip.title !== undefined
  const isAudio = !isTitle && trackKind === 'audio'
  // Colour by the TRACK: an audio-track clip is audio-family even when it
  // references a video asset (a linked-audio split).
  const { bg, bd } = isTitle
    ? { bg: '#4a3b6b', bd: '#7a5fb0' }
    : trackKind === 'audio'
      ? { bg: 'var(--color-clip-audio)', bd: 'var(--color-clip-audio-bd)' }
      : familyFor(asset)
  const kind = isTitle ? 'title' : trackKind
  const label = isTitle ? clip.title!.text || 'Title' : (asset?.name ?? 'Missing media')
  const thumb = useBlobUrl(isTitle || trackKind === 'audio' ? undefined : asset?.thumbnailKey)

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
    setFadePreview({ edge: d.edge, val: valFor(d, e.clientX) })
  }
  const endFade = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = fadeDragRef.current
    fadeDragRef.current = null
    setFadePreview(null)
    if (!d) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const val = valFor(d, e.clientX)
    if (Math.abs(val - d.startVal) > 1e-4) onFadeCommit(clip.id, d.edge, val)
  }

  const fadeInPx = fadeInS * pxPerS
  const fadeOutPx = fadeOutS * pxPerS

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
      className={`group/clip absolute bottom-[3px] top-[3px] overflow-hidden rounded-[6px] border ${
        selected ? 'ring-2 ring-accent' : ''
      } ${clip.enabled ? '' : 'opacity-40'} ${fxDropHot ? 'ring-2 ring-accent' : ''}`}
      style={{ left, width, background: bg, borderColor: bd }}
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
          className="pointer-events-none absolute bottom-0.5 right-1 text-[9px] text-white/50"
          title="Linked A/V"
        >
          🔗
        </span>
      )}
      {thumb && width > 48 && (
        <img
          src={thumb}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-y-0 left-0 h-full w-auto object-cover opacity-80"
        />
      )}
      <span className="pointer-events-none absolute left-1.5 right-1.5 top-0.5 truncate text-[11px] font-medium text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
        {label}
      </span>

      {isAudio && (fadeInPx > 0.5 || fadeOutPx > 0.5) && (
        <svg
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

      {isAudio && (
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

      <div
        data-testid="trim-in"
        className="absolute inset-y-0 left-0 w-[6px] cursor-w-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
        onPointerDown={(e) => {
          e.stopPropagation()
          onTrimPointerDown(e, clip, 'in')
        }}
      />
      <div
        data-testid="trim-out"
        className="absolute inset-y-0 right-0 w-[6px] cursor-e-resize bg-white/25 opacity-0 transition-opacity duration-[120ms] group-hover/clip:opacity-100"
        onPointerDown={(e) => {
          e.stopPropagation()
          onTrimPointerDown(e, clip, 'out')
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline

type Drag =
  | { kind: 'move'; clipId: Id; grabOffsetS: number; trackKind: 'video' | 'audio' }
  | { kind: 'trim'; clipId: Id; edge: 'in' | 'out'; ripple: boolean }
  /** Alt+edge-drag: retime the clip (speed changes, source in/out stay put). */
  | { kind: 'stretch'; clipId: Id; edge: 'in' | 'out' }
  | { kind: 'slip'; clipId: Id; startXPx: number }
  | { kind: 'scrub' }
  | { kind: 'hand'; startX: number; startY: number; scrollLeft: number; scrollTop: number }

export function Timeline({ height }: { height: number }) {
  const project = useStore((s) => s.project)
  const seq = activeSequence(project)
  const assets = project.assets
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const playheadS = useStore((s) => s.ui.playheadS)
  const playing = useStore((s) => s.ui.playing)
  const snapping = useStore((s) => s.ui.snapping)
  const tool = useStore((s) => s.ui.tool)
  const selection = useStore((s) => s.ui.selection)
  const setUI = useStore((s) => s.setUI)
  const show = useToasts((s) => s.show)

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
  const dragFinal = useRef<{ trackId: Id; tS: number } | null>(null)

  const renderSeq = previewSeq ?? seq
  const vTracks = useMemo(() => [...videoTracks(renderSeq)].reverse(), [renderSeq])
  const aTracks = useMemo(() => audioTracks(renderSeq), [renderSeq])
  const hasClips = seq.tracks.some((t) => t.clips.length > 0)
  const area = workArea(seq)

  const lengthS = Math.max(120, seq.durationS + 60)
  const contentWidth = lengthS * pxPerS

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

  const snapWithIndicator = (tS: number, excludeClipId?: Id): number => {
    if (!snapping) {
      setSnapIndicatorT(null)
      return tS
    }
    // Exclude the whole link group: a linked A/V pair trims/moves together, so
    // the partner's stale edges must not magnetize the gesture back onto itself.
    const excludeClipIds = excludeClipId ? clipGroupIds(seq, excludeClipId) : undefined
    const points = collectSnapPoints(seq, { ...(excludeClipIds ? { excludeClipIds } : {}), playheadS })
    const r = snapTime(tS, points, SNAP_PX / pxPerS)
    setSnapIndicatorT(r.snapped ? r.t : null)
    return r.t
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
  }

  // --- pointer interactions -------------------------------------------------

  const beginDrag = (e: ReactPointerEvent, d: Drag) => {
    lanesRef.current?.setPointerCapture(e.pointerId)
    setDrag(d)
  }

  const handleClipPointerDown = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (e.button !== 0) return
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (!track) return
    if (tool === 'hand') {
      beginHand(e)
      return
    }
    if (tool === 'zoom') {
      zoomAround(e.clientX, e.altKey ? 1 / 1.4 : 1.4)
      return
    }
    if (tool === 'razor') {
      if (track.locked) return
      const t = quantizeToFrame(contentPoint(e).x / pxPerS, seq.fps)
      updateActiveSequence('Split clip', (sq) => splitGroup(sq, clip.id, t))
      return
    }
    // Selection tool: select, then start a move (or Alt = slip) drag.
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
    if (e.altKey) {
      beginDrag(e, { kind: 'slip', clipId: clip.id, startXPx: x })
      return
    }
    beginDrag(e, {
      kind: 'move',
      clipId: clip.id,
      grabOffsetS: x / pxPerS - clip.startS,
      trackKind: track.kind,
    })
  }

  const handleClipContextMenu = (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => {
    setUI({ selection: [clip.id] })
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
    openContextMenu(e, [
      { label: 'Copy', shortcut: comboLabel('mod+c'), onClick: () => copySelection() },
      { label: 'Cut', shortcut: comboLabel('mod+x'), onClick: cutSelection },
      { label: 'Duplicate', shortcut: comboLabel('mod+d'), onClick: duplicateSelection },
      ...crossfadeItems,
      {
        label: 'Split at playhead',
        shortcut: comboLabel('mod+k'),
        separator: true,
        disabled: !playheadInside,
        onClick: () =>
          updateActiveSequence('Split at playhead', (sq) => splitGroup(sq, clip.id, playheadS)),
      },
      {
        label: 'Delete',
        shortcut: 'Del',
        separator: true,
        onClick: () => {
          updateActiveSequence('Delete clip', (sq) => deleteGroup(sq, clip.id))
          setUI({ selection: [] })
        },
      },
      // Only meaningful for a linked A/V pair: delete just THIS half, keep the
      // other. Deleting the audio keeps the video silent (its own audio stays
      // suppressed by the surviving link marker); deleting the video keeps the
      // audio playing. deleteClip acts on one clip, never the group.
      ...(clip.linkId !== undefined
        ? [
            {
              label:
                track?.kind === 'audio'
                  ? 'Delete audio only (keep video)'
                  : track?.kind === 'video'
                    ? 'Delete video only (keep audio)'
                    : 'Delete this clip only',
              disabled: !!track?.locked,
              onClick: () => {
                updateActiveSequence('Delete clip (keep linked)', (sq) => deleteClip(sq, clip.id))
                setUI({ selection: [] })
              },
            },
          ]
        : []),
      {
        label: 'Ripple delete',
        shortcut: 'Shift+Del',
        danger: true,
        onClick: () => {
          updateActiveSequence('Ripple delete', (sq) => rippleDeleteGroup(sq, clip.id))
          setUI({ selection: [] })
        },
      },
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
    setUI({ selection: [clip.id] })
    dragFinal.current = null
    // Edge modifiers: Ctrl = ripple trim, Alt = rate stretch (retime, not trim).
    if (e.altKey) {
      beginDrag(e, { kind: 'stretch', clipId: clip.id, edge })
      return
    }
    beginDrag(e, { kind: 'trim', clipId: clip.id, edge, ripple: e.ctrlKey || e.metaKey })
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
    else if (tool === 'zoom') zoomAround(e.clientX, e.altKey ? 1 / 1.4 : 1.4)
    else if (tool === 'select') {
      pausePlayback()
      setUI({ selection: [] })
      scrubPlayheadTo(e.clientX)
      beginDrag(e, { kind: 'scrub' })
    }
  }

  const handleLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    beginEmptyScrub(e)
  }

  // The scroll container's own background (the blank area beneath the last
  // track). Bubbled events from lanes/clips/ruler are ignored via the target
  // check, so only a click on the empty background scrubs.
  const handleLanesBackgroundPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (e.target !== e.currentTarget && e.target !== contentRef.current) return
    beginEmptyScrub(e)
  }

  const handleLanesPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    if (drag.kind === 'hand') {
      const el = lanesRef.current
      if (el) {
        el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
        el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
      }
      return
    }
    if (drag.kind === 'scrub') {
      scrubPlayheadTo(e.clientX)
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
        ? collectSnapPoints(seq, { excludeClipIds: clipGroupIds(seq, drag.clipId), playheadS })
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
      const target = hovered && hovered.kind === drag.trackKind && !hovered.locked ? hovered : current
      dragFinal.current = { trackId: target.id, tS: Math.max(0, desired) }
      setPreviewSeq(moveGroup(seq, drag.clipId, target.id, Math.max(0, desired)))
    } else if (drag.kind === 'slip') {
      const deltaS = quantizeToFrame((x - drag.startXPx) / pxPerS, seq.fps)
      dragFinal.current = { trackId: '', tS: deltaS }
      const next = slipClip(seq, assets, drag.clipId, deltaS)
      setPreviewSeq(next)
      const slipped = next.tracks.flatMap((tr) => tr.clips).find((c) => c.id === drag.clipId)
      if (slipped) {
        setTrimTip({
          x: e.clientX,
          y: e.clientY - 34,
          text: `Slip  in ${formatTimecode(slipped.inS, seq.fps)} · out ${formatTimecode(slipped.outS, seq.fps)}`,
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
      const trimFn = drag.ripple ? rippleTrimGroup : trimGroup
      const next = trimFn(seq, assets, drag.clipId, drag.edge, t)
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
          text: `${drag.ripple ? 'Ripple  ' : ''}${formatTimecode(shownT, seq.fps)}  (${delta >= 0 ? '+' : '−'}${formatTimecode(Math.abs(delta), seq.fps).slice(6)})`,
        })
      }
    }
  }

  const handleLanesPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    lanesRef.current?.releasePointerCapture(e.pointerId)
    if (drag.kind === 'move' && dragFinal.current) {
      const { trackId, tS } = dragFinal.current
      updateActiveSequence('Move clip', (sq) => moveGroup(sq, drag.clipId, trackId, tS))
    } else if (drag.kind === 'trim' && dragFinal.current) {
      const { tS } = dragFinal.current
      const trimFn = drag.ripple ? rippleTrimGroup : trimGroup
      updateActiveSequence(drag.ripple ? 'Ripple trim' : 'Trim clip', (sq) =>
        trimFn(sq, assets, drag.clipId, drag.edge, tS),
      )
    } else if (drag.kind === 'stretch' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Rate stretch', (sq) => rateStretchGroup(sq, drag.clipId, drag.edge, tS))
    } else if (drag.kind === 'slip' && dragFinal.current) {
      const { tS } = dragFinal.current
      updateActiveSequence('Slip clip', (sq) => slipClip(sq, assets, drag.clipId, tS))
    }
    setDrag(null)
    setPreviewSeq(null)
    setSnapIndicatorT(null)
    setTrimTip(null)
    dragFinal.current = null
  }

  // --- drop from the media bin ----------------------------------------------

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { x, y } = contentPoint(e)
    const lane = laneAt(y)
    if (!lane) {
      setDropPreview(null)
      return
    }
    const tRaw = quantizeToFrame(Math.max(0, x / pxPerS), seq.fps)
    const t = snapWithIndicator(tRaw)
    setDropPreview({ trackId: lane.id, tS: t })
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    setDropPreview(null)
    setSnapIndicatorT(null)
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
    const points = snapping ? collectSnapPoints(seq, { playheadS }) : []
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

  // Keep the playhead visible while playing (page-scroll like Premiere), but
  // never fight a manual scroll: suspend auto-follow for a moment after the
  // user scrolls the lanes themselves.
  useEffect(() => {
    if (!playing) return
    const el = lanesRef.current
    if (!el) return
    if (performance.now() < manualScrollUntil.current) return
    const px = playheadS * pxPerS
    const left = el.scrollLeft
    const right = left + el.clientWidth
    // Page forward when the playhead runs off the right edge; re-centre only
    // when it is fully off-screen (e.g. after Home). Do NOT tug back when the
    // user has scrolled ahead of the playhead.
    if (px > right - 40 || px < left - el.clientWidth) {
      programmaticScroll.current = true
      el.scrollLeft = Math.max(0, px - 80)
    }
  }, [playheadS, playing, pxPerS])

  const zoomFit = () => {
    const el = lanesRef.current
    if (!el || seq.durationS <= 0) return
    const next = Math.min(
      MAX_PX_PER_S,
      Math.max(MIN_PX_PER_S, (el.clientWidth - 40) / seq.durationS),
    )
    setUI({ pxPerS: next })
    el.scrollLeft = 0
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

  const cursorClass =
    tool === 'razor'
      ? 'cursor-crosshair'
      : tool === 'hand'
        ? 'cursor-grab'
        : tool === 'zoom'
          ? 'cursor-zoom-in'
          : ''

  const renderLane = (track: Track, tint: string) => (
    <div
      key={track.id}
      className={`relative border-b border-border/60 ${tint} ${track.locked ? 'opacity-60' : ''}`}
      style={{ height: track.height }}
      onPointerDown={handleLanePointerDown}
    >
      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          asset={assets[clip.assetId]}
          trackKind={track.kind}
          trackHeight={track.height}
          pxPerS={pxPerS}
          selected={selection.includes(clip.id)}
          locked={track.locked}
          onClipPointerDown={handleClipPointerDown}
          onTrimPointerDown={handleTrimPointerDown}
          onClipContextMenu={handleClipContextMenu}
          onFadeCommit={setClipFade}
        />
      ))}
      {dropPreview?.trackId === track.id && (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] bg-accent"
          style={{ left: dropPreview.tS * pxPerS }}
        />
      )}
    </div>
  )

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
          // this, scrolling only works with the cursor over the lanes — "can't
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
          </div>
        </div>

        <div
          ref={lanesRef}
          className={`relative min-w-0 flex-1 overflow-auto ${cursorClass}`}
          data-testid="timeline-lanes"
          onPointerDown={handleLanesBackgroundPointerDown}
          onPointerMove={handleLanesPointerMove}
          onPointerUp={handleLanesPointerUp}
          onPointerCancel={handleLanesPointerUp}
          onScroll={(e) => {
            // Track headers share vertical scroll with the lanes.
            if (headersRef.current) headersRef.current.scrollTop = e.currentTarget.scrollTop
            // A scroll we didn't trigger is the user's — suspend auto-follow so
            // playback doesn't yank the view back while they drag the scrollbar.
            if (programmaticScroll.current) programmaticScroll.current = false
            else manualScrollUntil.current = performance.now() + 2000
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
              <Ruler contentWidth={contentWidth} lengthS={lengthS} />
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

            {vTracks.map((t) => renderLane(t, 'bg-bg-input/30'))}
            <div className="h-[2px] bg-border-strong" />
            {aTracks.map((t) => renderLane(t, 'bg-bg-input/20'))}
            {/* Mirrors the headers' add-track row so both columns scroll to the
                same depth and those buttons stay reachable with many tracks. */}
            <div className="shrink-0" style={{ height: ADD_TRACK_ROW_H }} />

            {snapIndicatorT !== null && (
              <div
                className="pointer-events-none absolute bottom-0 z-30 w-px bg-accent"
                style={{ left: snapIndicatorT * pxPerS, top: RULER_H }}
              />
            )}

            <div
              data-testid="playhead"
              className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-playhead"
              style={{ left: playheadS * pxPerS }}
            >
              <div
                className="absolute -left-[5px] top-0 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent"
                style={{ borderTopColor: 'var(--color-playhead)' }}
              />
            </div>
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
          className="pointer-events-none fixed z-[90] rounded-[4px] border border-border bg-bg-elevated px-2 py-1 text-[11px] tabular-nums text-text-primary shadow-pop"
          style={{ left: trimTip.x, top: trimTip.y }}
        >
          {trimTip.text}
        </div>
      )}
    </section>
  )
}
