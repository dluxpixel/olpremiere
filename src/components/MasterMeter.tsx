import { useEffect, useRef, type RefObject } from 'react'
import { getMasterChain, readAnalyserPeak } from '../engine/audio'

/** Peak amplitude → 0..1 bar fraction on a −60..0 dBFS scale. */
function ampToFrac(peak: number): number {
  if (peak <= 1e-4) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

function Channel({ fillRef, holdRef }: { fillRef: RefObject<HTMLDivElement>; holdRef: RefObject<HTMLDivElement> }) {
  return (
    <div className="relative h-full w-[7px] overflow-hidden rounded-[2px] border border-white/10 bg-black/50">
      {/* Full-height gradient; a cover from the top masks the un-lit portion. */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to top, var(--color-success) 0%, var(--color-success) 62%, var(--color-warning) 82%, var(--color-danger) 100%)' }}
      />
      <div ref={fillRef} className="absolute inset-x-0 top-0 bg-bg-app" style={{ height: '100%' }} />
      <div ref={holdRef} className="absolute inset-x-0 h-[1.5px] bg-text-primary/80" style={{ bottom: '0%' }} />
    </div>
  )
}

/**
 * Master L/R level meter. Reads the persistent analyser chain (built on first
 * play) each frame and drives bar heights imperatively so metering never
 * re-renders React. Idle (silent) until playback feeds the master.
 */
export function MasterMeter() {
  const lFill = useRef<HTMLDivElement>(null)
  const rFill = useRef<HTMLDivElement>(null)
  const lHold = useRef<HTMLDivElement>(null)
  const rHold = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const bufL = new Float32Array(1024)
    const bufR = new Float32Array(1024)
    let holdL = 0
    let holdR = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const chain = getMasterChain()
      let fl = 0
      let fr = 0
      if (chain) {
        fl = ampToFrac(readAnalyserPeak(chain.analyserL, bufL))
        fr = ampToFrac(readAnalyserPeak(chain.analyserR, bufR))
      }
      holdL = Math.max(fl, holdL - 0.012)
      holdR = Math.max(fr, holdR - 0.012)
      // The masking cover height is the UN-lit portion (from the top).
      if (lFill.current) lFill.current.style.height = `${(1 - fl) * 100}%`
      if (rFill.current) rFill.current.style.height = `${(1 - fr) * 100}%`
      if (lHold.current) lHold.current.style.bottom = `${holdL * 100}%`
      if (rHold.current) rHold.current.style.bottom = `${holdR * 100}%`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      data-testid="master-meter"
      aria-hidden
      className="pointer-events-none absolute right-2 top-3 bottom-3 flex items-stretch gap-[3px]"
      title="Master level"
    >
      <Channel fillRef={lFill} holdRef={lHold} />
      <Channel fillRef={rFill} holdRef={rHold} />
    </div>
  )
}
