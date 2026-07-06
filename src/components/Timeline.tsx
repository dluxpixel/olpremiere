import {
  Expand,
  Hand,
  Headphones,
  ListPlus,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
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
  clipDurationS,
  clipEndS,
  collectSnapPoints,
  deleteGroup,
  moveGroup,
  rippleDeleteGroup,
  rippleTrimGroup,
  slipClip,
  snapTime,
  splitGroup,
  trimGroup,
} from '../engine/timeline'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { comboLabel } from '../keymap'
import {
  activeSequence,
  audioTracks,
  newSequence,
  videoTracks,
  type Clip,
  type Id,
  type MediaAsset,
  type Sequence,
  type Track,
} from '../engine/types'
import { pausePlayback } from '../state/playbackControl'
import { addTitleClip } from '../state/titleActions'
import { copySelection, cutSelection, duplicateSelection } from '../state/clipboard'
import { openContextMenu } from '../state/contextMenu'
import { useBlobUrl } from '../state/blobUrls'
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
const HEADERS_W = 160
const SNAP_PX = 8
const ASSET_MIME = 'application/x-reel-asset'

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

function TrackHeader({ track }: { track: Track }) {
  const toggle = (field: 'muted' | 'solo' | 'locked', label: string) =>
    updateActiveSequence(label, (seq) => ({
      ...seq,
      tracks: seq.tracks.map((t) => (t.id === track.id ? { ...t, [field]: !t[field] } : t)),
    }))

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-bg-panel px-2"
      style={{ height: track.height }}
    >
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
  { tool: 'select', label: 'Selection tool', shortcut: 'V', icon: MousePointer2 },
  { tool: 'razor', label: 'Razor tool', shortcut: 'C', icon: Scissors },
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
  pxPerS: number
  selected: boolean
  onClipPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void
  onTrimPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'in' | 'out') => void
  onClipContextMenu: (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => void
}

function ClipView({
  clip,
  asset,
  trackKind,
  pxPerS,
  selected,
  onClipPointerDown,
  onTrimPointerDown,
  onClipContextMenu,
}: ClipViewProps) {
  const left = clip.startS * pxPerS
  const width = Math.max(4, clipDurationS(clip) * pxPerS)
  // Titles are generated (no asset): a distinct violet family + the text label.
  const isTitle = clip.title !== undefined
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

  return (
    <div
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-kind={kind}
      className={`group/clip absolute bottom-[3px] top-[3px] overflow-hidden rounded-[6px] border ${
        selected ? 'ring-2 ring-accent' : ''
      } ${clip.enabled ? '' : 'opacity-40'}`}
      style={{ left, width, background: bg, borderColor: bd }}
      onPointerDown={(e) => onClipPointerDown(e, clip)}
      onContextMenu={(e) => onClipContextMenu(e, clip)}
    >
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
    const points = collectSnapPoints(seq, { excludeClipId, playheadS })
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
    openContextMenu(e, [
      { label: 'Copy', shortcut: comboLabel('mod+c'), onClick: () => copySelection() },
      { label: 'Cut', shortcut: comboLabel('mod+x'), onClick: cutSelection },
      { label: 'Duplicate', shortcut: comboLabel('mod+d'), onClick: duplicateSelection },
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
      const points = snapping ? collectSnapPoints(seq, { excludeClipId: drag.clipId, playheadS }) : []
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
          pxPerS={pxPerS}
          selected={selection.includes(clip.id)}
          onClipPointerDown={handleClipPointerDown}
          onTrimPointerDown={handleTrimPointerDown}
          onClipContextMenu={handleClipContextMenu}
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
          className="flex shrink-0 flex-col overflow-hidden border-r border-border"
          style={{ width: HEADERS_W }}
        >
          <div className="shrink-0 border-b border-border" style={{ height: RULER_H }} />
          {vTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
          <div className="h-[2px] shrink-0 bg-border-strong" />
          {aTracks.map((t) => (
            <TrackHeader key={t.id} track={t} />
          ))}
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
