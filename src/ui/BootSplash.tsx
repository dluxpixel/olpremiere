import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MELON_H, MELON_W, melonPixels } from './melon'
import styles from './BootSplash.module.css'

/** Must match the exit animation duration in BootSplash.module.css. */
const EXIT_MS = 420

/**
 * The opening screen, shared brand moment with the OL Studio DAW: a deep
 * near-black field with a soft coral glow and the pixel-melon floating as the
 * hero. No text, by design. Clicking the melon is also the user gesture that
 * lets the editor's AudioContext start unmuted.
 */
export function BootSplash({ onLaunch, onFinished }: { onLaunch: () => void; onFinished: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const launchedRef = useRef(false)
  const finishedRef = useRef(false)
  const pixels = useMemo(() => melonPixels(), [])
  // With reduced motion the exit animation is suppressed; don't sit on a delay
  // that would just read as lag, hand off immediately.
  const prefersReduced = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // Autofocus the melon so Enter/Space launches without reaching for the mouse.
  useEffect(() => {
    btnRef.current?.focus()
  }, [])

  // Once leaving, unmount the splash after the exit animation (fires once).
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(
      () => {
        if (finishedRef.current) return
        finishedRef.current = true
        onFinished()
      },
      prefersReduced ? 0 : EXIT_MS,
    )
    return () => window.clearTimeout(t)
  }, [leaving, onFinished, prefersReduced])

  const launch = () => {
    if (launchedRef.current) return
    launchedRef.current = true
    onLaunch() // mount the editor behind the splash, now
    setLeaving(true)
  }

  return (
    <div
      className={`${styles.overlay} ${leaving ? styles.leaving : ''}`}
      role="dialog"
      aria-label="OL Premiere"
      data-testid="boot-splash"
    >
      <button
        ref={btnRef}
        type="button"
        className={styles.melonBtn}
        onClick={launch}
        aria-label="Launch OL Premiere"
        title="Launch OL Premiere"
      >
        <span className={styles.halo} aria-hidden="true" />
        <MelonMark className={styles.melon} pixels={pixels} />
      </button>
    </div>
  )
}

/** The pixel-melon as an SVG, crisp at any size (splash hero AND topbar mark). */
export function MelonMark({
  className,
  pixels,
  size,
}: {
  className?: string
  pixels?: ReturnType<typeof melonPixels>
  size?: number
}) {
  const px = pixels ?? melonPixels()
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MELON_W} ${MELON_H}`}
      width={size}
      height={size ? (size * MELON_H) / MELON_W : undefined}
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated' }}
      aria-hidden="true"
    >
      {px.map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1} height={1} fill={p.color} />
      ))}
    </svg>
  )
}

/**
 * Boot gate: splash first, the editor mounts on launch and the splash overlays
 * it until its exit animation lands ("opens into" the app). Skipped entirely
 * under automation (navigator.webdriver): every e2e spec and verify probe
 * drives the app directly, and a click gate would break all of them.
 */
export function Boot({ children }: { children: ReactNode }) {
  const skip = typeof navigator !== 'undefined' && navigator.webdriver === true
  const [launched, setLaunched] = useState(skip)
  const [finished, setFinished] = useState(skip)
  return (
    <>
      {launched && children}
      {!finished && <BootSplash onLaunch={() => setLaunched(true)} onFinished={() => setFinished(true)} />}
    </>
  )
}
