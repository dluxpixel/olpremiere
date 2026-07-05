import {
  Expand,
  Hand,
  Headphones,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Scissors,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useRef, type PointerEvent } from 'react'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence, audioTracks, videoTracks, type Track } from '../engine/types'
import { comboLabel } from '../keymap'
import {
  MAX_PX_PER_S,
  MIN_PX_PER_S,
  useStore,
  zoomIn,
  zoomOut,
  type Tool,
} from '../state/store'
import { IconButton } from '../ui/Button'

const RULER_H = 28
const HEADERS_W = 160

// ---------------------------------------------------------------------------
// Ruler ticks

interface TickSpec {
  majorStepS: number
  minorStepS: number
}

const MAJOR_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

export function tickSpecFor(pxPerS: number): TickSpec {
  const majorStepS = MAJOR_STEPS_S.find((s) => s * pxPerS >= 70) ?? 600
  return { majorStepS, minorStepS: majorStepS / 5 }
}

function rulerLabel(tS: number, fps: number, majorStepS: number): string {
  if (majorStepS < 1) return formatTimecode(tS, fps).slice(3) // MM:SS:FF
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
// Track headers

function TrackHeader({ track }: { track: Track }) {
  const dispatch = useStore((s) => s.dispatch)

  const toggle = (field: 'muted' | 'solo' | 'locked', label: string) =>
    dispatch(label, (p) => {
      const seq = activeSequence(p)
      const tracks = seq.tracks.map((t) => (t.id === track.id ? { ...t, [field]: !t[field] } : t))
      return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, tracks } } }
    })

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
        {track.muted ? <VolumeX size={14} strokeWidth={1.5} /> : <Volume2 size={14} strokeWidth={1.5} />}
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
        {track.locked ? <Lock size={14} strokeWidth={1.5} /> : <LockOpen size={14} strokeWidth={1.5} />}
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

function TimelineToolbar() {
  const tool = useStore((s) => s.ui.tool)
  const snapping = useStore((s) => s.ui.snapping)
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const fps = useStore((s) => activeSequence(s.project).fps)

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
        <IconButton
          size="compact"
          label="Zoom to fit"
          shortcut={comboLabel('\\')}
          onClick={() => setUI({ pxPerS: 60 })}
        >
          <Expand size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline

export function Timeline({ height }: { height: number }) {
  const seq = useStore((s) => activeSequence(s.project))
  const pxPerS = useStore((s) => s.ui.pxPerS)
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const contentRef = useRef<HTMLDivElement>(null)

  // Visible video tracks top→bottom = V2, V1; audio below = A1, A2.
  const vTracks = [...videoTracks(seq)].reverse()
  const aTracks = audioTracks(seq)
  const hasClips = seq.tracks.some((t) => t.clips.length > 0)

  const lengthS = Math.max(120, seq.durationS + 60)
  const contentWidth = lengthS * pxPerS

  const scrubTo = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = Math.max(0, (clientX - rect.left) / pxPerS)
    setUI({ playheadS: quantizeToFrame(t, seq.fps) })
  }

  const handleRulerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubTo(e.clientX)
  }
  const handleRulerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX)
  }

  return (
    <section
      data-testid="timeline"
      aria-label="Timeline"
      className="flex shrink-0 flex-col bg-bg-panel"
      style={{ height }}
    >
      <TimelineToolbar />
      <div className="flex min-h-0 flex-1">
        {/* Track headers */}
        <div
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

        {/* Lanes */}
        <div className="relative min-w-0 flex-1 overflow-auto" data-testid="timeline-lanes">
          <div ref={contentRef} className="relative" style={{ width: contentWidth }}>
            {/* Scrub layer: the ruler owns pointer events */}
            <div
              className="sticky top-0 z-20 cursor-ew-resize"
              onPointerDown={handleRulerDown}
              onPointerMove={handleRulerMove}
              data-testid="ruler"
            >
              <Ruler contentWidth={contentWidth} lengthS={lengthS} />
            </div>

            {vTracks.map((t) => (
              <div
                key={t.id}
                className="relative border-b border-border/60 bg-bg-input/30"
                style={{ height: t.height }}
              />
            ))}
            <div className="h-[2px] bg-border-strong" />
            {aTracks.map((t) => (
              <div
                key={t.id}
                className="relative border-b border-border/60 bg-bg-input/20"
                style={{ height: t.height }}
              />
            ))}

            {/* Playhead */}
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
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center" style={{ top: RULER_H }}>
              <span className="text-[12px] text-text-muted">Drag a clip here to start</span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
