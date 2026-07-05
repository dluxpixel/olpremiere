import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  MonitorPlay,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useRef } from 'react'
import { formatTimecode, quantizeToFrame } from '../engine/timecode'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'

export function Monitor() {
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const seq = useStore((s) => activeSequence(s.project))
  const regionRef = useRef<HTMLDivElement>(null)

  const stepFrames = (frames: number) => {
    const t = quantizeToFrame(playheadS, seq.fps) + frames / seq.fps
    setUI({ playheadS: Math.min(Math.max(0, t), seq.durationS) })
  }

  return (
    <section
      ref={regionRef}
      data-testid="monitor"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-app"
      aria-label="Program monitor"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="flex aspect-video max-h-full w-full max-w-full items-center justify-center rounded-[2px] bg-black">
          <div className="flex flex-col items-center gap-2 text-center">
            <MonitorPlay size={28} strokeWidth={1.5} className="text-text-muted" aria-hidden />
            <span className="text-[12px] text-text-muted">No media yet</span>
          </div>
        </div>
      </div>

      <div className="relative flex h-11 shrink-0 items-center gap-2 border-t border-border bg-bg-panel px-3">
        <span data-testid="timecode" className="text-[12px] tabular-nums text-text-primary">
          {formatTimecode(playheadS, seq.fps)}
          <span className="text-text-muted"> / {formatTimecode(seq.durationS, seq.fps)}</span>
        </span>

        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
          <IconButton label="Go to start" shortcut="Home" onClick={() => setUI({ playheadS: 0 })}>
            <SkipBack size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Step back 1 frame" shortcut="←" onClick={() => stepFrames(-1)}>
            <ChevronLeft size={16} strokeWidth={1.5} />
          </IconButton>
          <Tooltip label="Play — arrives in Phase 1" shortcut="Space">
            <button
              aria-label="Play"
              disabled
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-text-secondary opacity-40"
            >
              <Play size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
          <IconButton label="Step forward 1 frame" shortcut="→" onClick={() => stepFrames(1)}>
            <ChevronRight size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton
            label="Go to end"
            shortcut="End"
            onClick={() => setUI({ playheadS: seq.durationS })}
          >
            <SkipForward size={16} strokeWidth={1.5} />
          </IconButton>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Playback quality"
            className="h-6 rounded-[4px] border border-border bg-bg-input px-1.5 text-[11px] text-text-secondary focus:border-accent focus:outline-none"
            defaultValue="full"
          >
            <option value="full">Full</option>
            <option value="half">Half</option>
            <option value="quarter">Quarter</option>
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
