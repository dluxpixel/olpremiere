import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  MonitorPlay,
  Pause,
  Play,
  Repeat,
  Scan,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { prewarmAudio } from '../engine/audio'
import { setPreviewScale } from '../engine/frameCache'
import { prewarmPreview, previewEpoch, renderPreview } from '../engine/preview'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence, type Sequence } from '../engine/types'
import { pausePlayback, subscribeShuttleRate, toggleLoop, togglePlay } from '../state/playbackControl'
import { useSettings } from '../state/settings'
import { setActiveSequenceFormat, useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { MasterMeter } from './MasterMeter'
import { fitCanvasBox } from './monitorSizing'
import { MonitorTransformOverlay } from './MonitorTransformOverlay'
import { PlayheadTimecode } from './PlayheadWidgets'

type Quality = 1 | 0.5 | 0.25

// Aspect presets. Switching one reformats the sequence AND scales clips to fill.
const FORMATS = [
  { key: '16:9', label: '16:9 Wide', w: 1920, h: 1080 },
  { key: '9:16', label: '9:16 Shorts', w: 1080, h: 1920 },
  { key: '1:1', label: '1:1 Square', w: 1080, h: 1080 },
] as const

function aspectKeyFor(w: number, h: number): string {
  if (w === h) return '1:1'
  return h > w ? '9:16' : '16:9'
}

// The preview never needs to redraw faster than this. The <video> upload +
// composite is the frame's real cost, so on a 144/240 Hz display an uncapped
// rAF loop did that work 2-4x more often than any content changed: the "laggy
// preview". 60 fps is smoother than any timeline footage and imperceptible next
// to it. (Scrub/drag bursts and playback all coalesce to this ceiling.)
const MAX_PREVIEW_FPS = 60
const MIN_FRAME_MS = 1000 / MAX_PREVIEW_FPS

/** rAF draw loop: reads the store imperatively so playback never re-renders React. */
function useProgramCanvas(quality: Quality) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    // Dirty-check state: only repaint when a real input changed (playhead frame,
    // play/pause, canvas size, project edit, or a live gizmo drag), and never
    // faster than MAX_PREVIEW_FPS. A frame that's still decoding leaves
    // `prevComplete=false` so we keep polling until its exact frame lands.
    let lastDrawT = -Infinity
    let prevKey = ''
    let prevSeq: Sequence | null = null
    let prevComplete = false

    // Parent size via ResizeObserver, NOT getBoundingClientRect per rAF: a
    // per-frame rect read plus unconditional style writes forced a style/layout
    // pass on every frame, competing with the video for main-thread time.
    const parent = canvas.parentElement
    let parentW = parent?.clientWidth ?? 0
    let parentH = parent?.clientHeight ?? 0
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        parentW = en.contentRect.width
        parentH = en.contentRect.height
      }
    })
    if (parent) ro.observe(parent)
    let styleW = ''
    let styleH = ''

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const s = useStore.getState()
      const seq = activeSequence(s.project)
      // CSS box AND raster snapped to whole device pixels (fitCanvasBox): a
      // fractional device-pixel box makes the compositor resample the finished
      // canvas, a uniform blur no render-side sharpness can beat.
      const box = fitCanvasBox(parentW, parentH, seq.width / seq.height, window.devicePixelRatio || 1, quality)
      const pw = box.pxW
      const ph = box.pxH

      const playing = s.ui.playing
      const fps = seq.fps > 0 ? seq.fps : 30
      const frameIdx = Math.floor(s.ui.playheadS * fps + 1e-6)
      // cssW/cssH in the key: the CSS box can move by a device pixel while the
      // reduced-quality raster rounds to the same pw×ph, so the style write
      // below must not be skipped by the parked-frame early-out when that happens.
      const key = `${frameIdx}|${playing ? 1 : 0}|${pw}x${ph}|${box.cssW}x${box.cssH}|${previewEpoch()}`
      const changed = key !== prevKey || seq !== prevSeq

      // Parked on a fully-resolved frame with nothing new: do zero GPU work.
      if (!changed && prevComplete) return
      // Cap the redraw rate (tames high-refresh displays and rapid scrub/drag).
      if (now - lastDrawT < MIN_FRAME_MS) return
      lastDrawT = now

      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      // Write styles only on CHANGE: a same-value style write still dirties
      // style state in some engines and forces a recalc.
      const wPx = `${box.cssW}px`
      const hPx = `${box.cssH}px`
      if (wPx !== styleW) {
        styleW = wPx
        canvas.style.width = wPx
      }
      if (hPx !== styleH) {
        styleH = hPx
        canvas.style.height = hPx
      }
      prevComplete = renderPreview(canvas, seq, s.project.assets, s.ui.playheadS, playing)
      prevKey = key
      prevSeq = seq
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [quality])
  return canvasRef
}

/**
 * Viewport-only safe-margin guides: action-safe (90%) + title-safe (80%)
 * rectangles over the letterboxed video area, the broadcast-spec insets.
 * Tracks the canvas display size
 * (set each frame by the draw loop) so it follows resize/letterboxing. Never
 * touches the canvas render or export; it is an overlay, not a layer.
 */
function SafeMargins({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!canvas) return
    // ResizeObserver, not a rAF poll: the canvas CSS size only changes on panel
    // resize / format switch, so polling it every frame was pure overhead.
    const ro = new ResizeObserver(() => {
      const w = parseFloat(canvas.style.width) || 0
      const h = parseFloat(canvas.style.height) || 0
      setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvas])

  if (!box || box.w === 0) return null
  const inset = (pct: number) => ({
    left: `${((1 - pct) / 2) * 100}%`,
    top: `${((1 - pct) / 2) * 100}%`,
    right: `${((1 - pct) / 2) * 100}%`,
    bottom: `${((1 - pct) / 2) * 100}%`,
  })
  return (
    <div
      data-testid="safe-margins"
      className="pointer-events-none absolute"
      style={{ width: box.w, height: box.h }}
    >
      <div
        className="absolute rounded-[1px] border border-dashed"
        style={{ ...inset(0.9), borderColor: 'var(--color-border-strong)' }}
      />
      <div
        className="absolute rounded-[1px] border border-dashed"
        style={{ ...inset(0.8), borderColor: 'var(--color-accent-quiet)' }}
      />
    </div>
  )
}

/** J/K/L shuttle indicator; shows only when shuttling faster/reverse. */
function ShuttleBadge() {
  const [rate, setRate] = useState(0)
  useEffect(() => subscribeShuttleRate(setRate), [])
  if (rate === 0 || (rate > 0 && rate <= 1)) return null // normal play / paused: hide
  const arrow = rate < 0 ? '◀◀' : '▶▶'
  return (
    // Ember pill: shuttle is a live transport state, and the mono digits keep
    // the rate readout steady while J/K/L pumps it.
    <span
      data-testid="shuttle-badge"
      className="rounded-full bg-ember-quiet px-2 py-0.5 font-numeric text-dense font-medium text-ember"
    >
      {arrow} {Math.abs(rate)}×
    </span>
  )
}

export function Monitor() {
  const assets = useStore((s) => s.project.assets)
  // Decode audio + spin up pooled elements so the first Space press starts
  // instantly, but ONLY for assets the active sequence actually uses.
  // Warming the whole bin meant importing a 100-clip library spun up 100
  // video decoders + 100 full PCM decodes at once. Keyed on the SET of used
  // asset ids (stable string), not the sequence object: every edit replaces
  // the sequence reference, and re-sweeping per keystroke churned the pools.
  const usedAssetKey = useStore((s) => {
    const sq = activeSequence(s.project)
    const used = new Set<string>()
    for (const t of sq.tracks) for (const c of t.clips) if (c.assetId) used.add(c.assetId)
    return [...used].sort().join('|')
  })
  useEffect(() => {
    if (!usedAssetKey) return
    const used = new Set(usedAssetKey.split('|'))
    const list = Object.values(assets).filter((a) => used.has(a.id))
    prewarmAudio(list)
    prewarmPreview(list)
  }, [assets, usedAssetKey])

  // No playheadS subscription: the timecode is an imperative leaf
  // (PlayheadTimecode), so transport ticks never re-render the Monitor.
  const playing = useStore((s) => s.ui.playing)
  const loop = useStore((s) => s.ui.loop)
  const setUI = useStore((s) => s.setUI)
  const seq = useStore((s) => activeSequence(s.project))
  const hasContent = seq.durationS > 0
  // Opens at the Settings default; the picker below still owns the session.
  const [quality, setQuality] = useState<Quality>(() => useSettings.getState().previewQuality)
  // Quality tier drives BOTH the canvas raster (dpr) and the frame-cache decode
  // resolution, so Half/Quarter genuinely cut scrub cost on large sources.
  useEffect(() => {
    setPreviewScale(quality)
  }, [quality])
  const [safeMargins, setSafeMargins] = useState(false)
  const regionRef = useRef<HTMLDivElement>(null)
  const canvasRef = useProgramCanvas(quality)

  const stepFrames = (frames: number) => {
    pausePlayback()
    const t = quantizeToFrame(useStore.getState().ui.playheadS, seq.fps) + frames / seq.fps
    setUI({ playheadS: Math.min(Math.max(0, t), seq.durationS) })
  }

  return (
    <section
      ref={regionRef}
      data-testid="monitor"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-app"
      aria-label="Program monitor"
      onPointerDownCapture={() => {
        if (useStore.getState().ui.focusedPanel !== 'monitor') setUI({ focusedPanel: 'monitor' })
      }}
    >
      <div className="flex min-h-0 flex-1 items-stretch gap-2 p-3">
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
          <canvas ref={canvasRef} data-testid="program-canvas" className="rounded-[2px] bg-black" />
          {safeMargins && <SafeMargins canvas={canvasRef.current} />}
          {/* Click the picture to pause; every video player teaches this.
              (Paused, the overlay's select layer handles click/scrub instead.) */}
          {playing && (
            <div
              data-testid="click-to-pause"
              className="absolute inset-0 cursor-pointer"
              onPointerDown={() => pausePlayback()}
            />
          )}
          <MonitorTransformOverlay canvas={canvasRef.current} />
          {!hasContent && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <MonitorPlay size={28} strokeWidth={1.5} className="text-text-muted" aria-hidden />
              <span className="text-ui-sm text-text-muted">No media yet</span>
            </div>
          )}
        </div>
        {/* Meter lives in its OWN column, never over the video. */}
        <MasterMeter />
      </div>

      <div className="relative flex h-11 shrink-0 items-center gap-2 border-t border-border bg-bg-panel px-3">
        <span data-testid="timecode" className="font-numeric text-ui-sm text-text-primary">
          <PlayheadTimecode fps={seq.fps} editable testId="monitor-timecode" />
          <span className="text-text-muted"> / {formatTimecode(seq.durationS, seq.fps)}</span>
        </span>
        <ShuttleBadge />

        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
          <IconButton
            label="Go to start"
            shortcut="Home"
            onClick={() => {
              pausePlayback()
              setUI({ playheadS: 0 })
            }}
          >
            <SkipBack size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Step back 1 frame" shortcut="←" onClick={() => stepFrames(-1)}>
            <ChevronLeft size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label={playing ? 'Pause' : 'Play'}
            shortcut="Space"
            onClick={togglePlay}
            disabled={!hasContent}
            data-testid="play-toggle"
            className="text-text-primary!"
          >
            {playing ? <Pause size={16} strokeWidth={1.5} /> : <Play size={16} strokeWidth={1.5} />}
          </IconButton>
          <IconButton label="Step forward 1 frame" shortcut="→" onClick={() => stepFrames(1)}>
            <ChevronRight size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Go to end"
            shortcut="End"
            onClick={() => {
              pausePlayback()
              // Last real frame, not durationS (which resolves to a black frame).
              setUI({ playheadS: Math.max(0, seq.durationS - 1 / (seq.fps || 30)) })
            }}
          >
            <SkipForward size={16} strokeWidth={1.5} />
          </IconButton>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            data-testid="format-select"
            aria-label="Aspect ratio"
            title="Aspect ratio: 9:16 makes a vertical Shorts video"
            className="h-7 cursor-default rounded-field border border-border bg-bg-input px-2 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:text-text-primary focus:border-accent focus:outline-none"
            value={aspectKeyFor(seq.width, seq.height)}
            onChange={(e) => {
              const f = FORMATS.find((x) => x.key === e.target.value)
              if (f) setActiveSequenceFormat(f.w, f.h)
            }}
          >
            {FORMATS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <IconButton
            label="Loop playback: repeats the In/Out range"
            shortcut="/"
            active={loop}
            onClick={toggleLoop}
            data-testid="loop-toggle"
            className={loop ? 'bg-ember-quiet! text-ember!' : ''}
          >
            <Repeat size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Safe margins"
            active={safeMargins}
            onClick={() => setSafeMargins((v) => !v)}
            data-testid="safe-margins-toggle"
          >
            <Scan size={16} strokeWidth={1.5} />
          </IconButton>
          <select
            aria-label="Preview quality"
            title="Preview quality: lower = smoother scrubbing on big footage. Never affects the export."
            className="h-7 cursor-default rounded-field border border-border bg-bg-input px-2 text-ui-sm text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:text-text-primary focus:border-accent focus:outline-none"
            value={String(quality)}
            onChange={(e) => setQuality(Number(e.target.value) as Quality)}
          >
            <option value="1">Preview: Full</option>
            <option value="0.5">Preview: Half</option>
            <option value="0.25">Preview: Quarter</option>
          </select>
          <IconButton
            label="Fullscreen"
            onClick={() => void regionRef.current?.requestFullscreen?.()}
          >
            <Maximize size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>
    </section>
  )
}
