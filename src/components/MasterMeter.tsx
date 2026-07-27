import { useEffect, useRef, type RefObject } from 'react'
import { getMasterChain, readAnalyserPeak } from '../engine/audio'
import { useStore } from '../state/store'

/** Peak amplitude → 0..1 bar fraction on a −60..0 dBFS scale. */
function ampToFrac(peak: number): number {
  if (peak <= 1e-4) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/** Tick labels down the gutter; fraction is position on the −60..0 scale. */
const TICKS: { db: number; frac: number }[] = [0, -6, -12, -24, -40, -60].map((db) => ({
  db,
  frac: (db + 60) / 60,
}))

function Channel({
  fillRef,
  holdRef,
  clipRef,
}: {
  fillRef: RefObject<HTMLDivElement>
  holdRef: RefObject<HTMLDivElement>
  clipRef: RefObject<HTMLDivElement>
}) {
  return (
    <div className="flex h-full flex-col items-stretch gap-1">
      {/* Clip LED: latches red on a ≥0dBFS peak, clears on click / after 2s. */}
      <div
        ref={clipRef}
        data-testid="meter-clip-led"
        className="h-1.5 w-full shrink-0 rounded-[1px] bg-white/10"
      />
      <div className="relative min-h-0 w-[11px] flex-1 overflow-hidden rounded-[2px] border border-white/10 bg-black/50">
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, var(--color-success) 0%, var(--color-success) 62%, var(--color-warning) 82%, var(--color-danger) 100%)',
          }}
        />
        <div ref={fillRef} className="absolute inset-x-0 top-0 bg-bg-app" style={{ height: '100%' }} />
        <div ref={holdRef} className="absolute inset-x-0 h-[1.5px] bg-text-primary/80" style={{ bottom: '0%' }} />
      </div>
    </div>
  )
}

/**
 * Master L/R level meter. Reads the persistent analyser chain each frame and
 * drives bars imperatively (no React re-render). The rAF is gated on
 * ui.playing (parked and zeroed while idle) and lives in its OWN column so
 * it never occludes video.
 */
export function MasterMeter() {
  const lFill = useRef<HTMLDivElement>(null)
  const rFill = useRef<HTMLDivElement>(null)
  const lHold = useRef<HTMLDivElement>(null)
  const rHold = useRef<HTMLDivElement>(null)
  const lClip = useRef<HTMLDivElement>(null)
  const rClip = useRef<HTMLDivElement>(null)

  const clearClips = () => {
    for (const led of [lClip.current, rClip.current]) led?.classList.remove('!bg-danger')
  }

  useEffect(() => {
    const bufL = new Float32Array(1024)
    const bufR = new Float32Array(1024)
    let holdL = 0
    let holdR = 0
    let clipUntilL = 0
    let clipUntilR = 0
    let frame = 0
    let raf = 0
    let running = false

    const zero = () => {
      if (lFill.current) lFill.current.style.height = '100%'
      if (rFill.current) rFill.current.style.height = '100%'
      if (lHold.current) lHold.current.style.bottom = '0%'
      if (rHold.current) rHold.current.style.bottom = '0%'
      holdL = holdR = 0
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      frame++
      const chain = getMasterChain()
      let fl = 0
      let fr = 0
      let peakL = 0
      let peakR = 0
      if (chain) {
        peakL = readAnalyserPeak(chain.analyserL, bufL)
        peakR = readAnalyserPeak(chain.analyserR, bufR)
        fl = ampToFrac(peakL)
        fr = ampToFrac(peakR)
      }
      holdL = Math.max(fl, holdL - 0.012)
      holdR = Math.max(fr, holdR - 0.012)
      if (lFill.current) lFill.current.style.height = `${(1 - fl) * 100}%`
      if (rFill.current) rFill.current.style.height = `${(1 - fr) * 100}%`
      if (lHold.current) lHold.current.style.bottom = `${holdL * 100}%`
      if (rHold.current) rHold.current.style.bottom = `${holdR * 100}%`
      // Clip latch: ≥0dBFS lights the LED for ~2s (120 frames).
      if (peakL >= 0.999) clipUntilL = frame + 120
      if (peakR >= 0.999) clipUntilR = frame + 120
      lClip.current?.classList.toggle('!bg-danger', frame < clipUntilL)
      rClip.current?.classList.toggle('!bg-danger', frame < clipUntilR)
    }

    const start = () => {
      if (running) return
      running = true
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
      zero()
    }

    // Follow playback imperatively (no subscription-driven re-render here).
    if (useStore.getState().ui.playing) start()
    else zero()
    const unsub = useStore.subscribe(
      (s) => s.ui.playing,
      (playing) => (playing ? start() : stop()),
    )
    return () => {
      unsub()
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      data-testid="master-meter"
      className="flex shrink-0 items-stretch gap-1.5 select-none"
      title="Master level (click to clear clip)"
      onClick={clearClips}
    >
      {/* dB tick gutter, rendered once for zero per-frame cost. */}
      <div className="relative w-6 shrink-0 text-[8px] leading-none text-text-muted">
        {TICKS.map((t) => (
          <span
            key={t.db}
            className="absolute right-0 -translate-y-1/2 tabular-nums"
            style={{ bottom: `${t.frac * 100}%` }}
          >
            {t.db}
          </span>
        ))}
      </div>
      <Channel fillRef={lFill} holdRef={lHold} clipRef={lClip} />
      <Channel fillRef={rFill} holdRef={rHold} clipRef={rClip} />
    </div>
  )
}
