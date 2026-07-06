import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  MonitorPlay,
  Pause,
  Play,
  Scan,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { prewarmAudio } from '../engine/audio'
import { prewarmPreview, renderPreview } from '../engine/preview'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence } from '../engine/types'
import { pausePlayback, togglePlay } from '../state/playbackControl'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'

type Quality = 1 | 0.5 | 0.25

/** rAF draw loop: reads the store imperatively so playback never re-renders React. */
function useProgramCanvas(quality: Quality) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const s = useStore.getState()
      const seq = activeSequence(s.project)
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      const aspect = seq.width / seq.height
      let w = rect.width
      let h = w / aspect
      if (h > rect.height) {
        h = rect.height
        w = h * aspect
      }
      const dpr = (window.devicePixelRatio || 1) * quality
      const pw = Math.max(1, Math.round(w * dpr))
      const ph = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      renderPreview(canvas, seq, s.project.assets, s.ui.playheadS, s.ui.playing)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [quality])
  return canvasRef
}

/**
 * Viewport-only safe-margin guides: action-safe (93%) + title-safe (90%)
 * rectangles over the letterboxed video area. Tracks the canvas display size
 * (set each frame by the draw loop) so it follows resize/letterboxing. Never
 * touches the canvas render or export — it is an overlay, not a layer.
 */
function SafeMargins({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!canvas) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const w = parseFloat(canvas.style.width) || 0
      const h = parseFloat(canvas.style.height) || 0
      setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
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
        style={{ ...inset(0.93), borderColor: 'var(--color-border-strong)' }}
      />
      <div
        className="absolute rounded-[1px] border border-dashed"
        style={{ ...inset(0.9), borderColor: 'var(--color-accent-quiet)' }}
      />
    </div>
  )
}

export function Monitor() {
  const assets = useStore((s) => s.project.assets)
  // Decode audio + spin up pooled elements as soon as media exists, so the
  // first Space press starts instantly instead of stalling on decode.
  useEffect(() => {
    const list = Object.values(assets)
    prewarmAudio(list)
    prewarmPreview(list)
  }, [assets])

  const playheadS = useStore((s) => s.ui.playheadS)
  const playing = useStore((s) => s.ui.playing)
  const setUI = useStore((s) => s.setUI)
  const seq = useStore((s) => activeSequence(s.project))
  const hasContent = seq.durationS > 0
  const [quality, setQuality] = useState<Quality>(1)
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
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <canvas ref={canvasRef} data-testid="program-canvas" className="rounded-[2px] bg-black" />
        {safeMargins && <SafeMargins canvas={canvasRef.current} />}
        {!hasContent && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <MonitorPlay size={28} strokeWidth={1.5} className="text-text-muted" aria-hidden />
            <span className="text-[12px] text-text-muted">No media yet</span>
          </div>
        )}
      </div>

      <div className="relative flex h-11 shrink-0 items-center gap-2 border-t border-border bg-bg-panel px-3">
        <span data-testid="timecode" className="text-[12px] tabular-nums text-text-primary">
          {formatTimecode(playheadS, seq.fps)}
          <span className="text-text-muted"> / {formatTimecode(seq.durationS, seq.fps)}</span>
        </span>

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
              setUI({ playheadS: seq.durationS })
            }}
          >
            <SkipForward size={16} strokeWidth={1.5} />
          </IconButton>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label="Safe margins"
            active={safeMargins}
            onClick={() => setSafeMargins((v) => !v)}
            data-testid="safe-margins-toggle"
          >
            <Scan size={16} strokeWidth={1.5} />
          </IconButton>
          <select
            aria-label="Playback quality"
            className="h-6 rounded-[4px] border border-border bg-bg-input px-1.5 text-[11px] text-text-secondary focus:border-accent focus:outline-none"
            value={String(quality)}
            onChange={(e) => setQuality(Number(e.target.value) as Quality)}
          >
            <option value="1">Full</option>
            <option value="0.5">Half</option>
            <option value="0.25">Quarter</option>
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
