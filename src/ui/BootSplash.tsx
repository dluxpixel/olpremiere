import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { APP_VERSION } from '../appVersion'
import { useUpdateFeed, updateLine } from '../state/updateStatus'
import { LoadingCard } from './LoadingCard'
import { MelonMark } from './MelonMark'
import {
  CARD_EXIT_MS,
  HARD_CAP_MS,
  OPTIONAL_GRACE_MS,
  allSettled,
  bootOverride,
  gateReady,
  labelOf,
  progressOf,
  statusLine,
  statusOf,
  stepsFor,
  useBootLedger,
  type BootOverride,
} from './bootProgress'
import { BOOT_DURATION_MS, allRevealed, maskStatuses, useRevealed } from './bootReveal'
import { melonPixels } from './melon'
import styles from './BootSplash.module.css'

/** Must match the exit animation duration in BootSplash.module.css. */
const EXIT_MS = 420

export type BootPhase = 'loading' | 'closing' | 'ready'

/** This page's `?boot=` override, if any (see bootOverride, a normal launch has none). */
function currentOverride(): BootOverride {
  return typeof window === 'undefined' ? null : bootOverride(window.location.search)
}

/** The phase an override pins us to. `show` pins nothing: it just runs for real. */
function heldPhase(): BootPhase | null {
  const v = currentOverride()
  if (v === 'hold') return 'loading'
  if (v === 'melon') return 'ready'
  return null
}

/**
 * Decide when the loading card gives way to the melon.
 *
 * Three rules, in this order: never flash by (a minimum showing), never wait on
 * the network (the update row is optional and gets a short grace once the local
 * work is done), and never trap him (a hard cap opens the app no matter what is
 * still pending). Polled rather than reactive so a step that never reports at all
 * cannot stall the transition.
 */
export function useBootPhase(isElectron: boolean): BootPhase {
  const held = useMemo(heldPhase, [])
  const [phase, setPhase] = useState<BootPhase>(() => held ?? 'loading')

  useEffect(() => {
    if (held || phase !== 'loading') return
    const specs = stepsFor(isElectron)
    const startedAt = performance.now()
    let gateAt: number | null = null

    const tick = (): void => {
      const { statuses } = useBootLedger.getState()
      const now = performance.now()
      if (gateReady(specs, statuses) && gateAt === null) gateAt = now
      // The randomised run (4 to 8 seconds) plus every tick having landed: the
      // card must never leave mid-reveal, or the last rows would flash past.
      const waitedEnough = now - startedAt >= BOOT_DURATION_MS && allRevealed(specs.length)
      const optionalDone = allSettled(specs, statuses)
      const graceUsedUp = gateAt !== null && now - gateAt >= OPTIONAL_GRACE_MS
      const capped = now - startedAt >= HARD_CAP_MS
      if (capped || (gateAt !== null && waitedEnough && (optionalDone || graceUsedUp))) {
        window.clearInterval(timer)
        setPhase('closing')
      }
    }
    const timer = window.setInterval(tick, 80)
    tick()
    return () => window.clearInterval(timer)
  }, [held, phase, isElectron])

  // The card's pop, then the melon takes the screen.
  useEffect(() => {
    if (phase !== 'closing') return
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const t = window.setTimeout(() => setPhase('ready'), reduced ? 0 : CARD_EXIT_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  return phase
}

/**
 * The opening screen, shared brand moment with the OL Studio DAW: a deep
 * near-black field with a soft coral glow. It runs in two beats: the loading
 * card while the app starts itself, then the pixel-melon floating as the hero,
 * which is the button that opens the editor. Clicking it is also the user gesture
 * that lets the editor's AudioContext start unmuted.
 */
export function BootSplash({ onLaunch, onFinished }: { onLaunch: () => void; onFinished: () => void }) {
  const isElectron = typeof window !== 'undefined' && window.api?.isElectron === true
  const phase = useBootPhase(isElectron)
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

  // Autofocus the melon as soon as it exists, so Enter/Space launches without
  // reaching for the mouse.
  useEffect(() => {
    if (phase === 'ready') btnRef.current?.focus()
  }, [phase])

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
      className={`${styles.overlay} ${leaving ? styles.leaving : ''} ${phase === 'ready' ? '' : styles.starting}`}
      role="dialog"
      aria-label="OL Premiere"
      data-testid="boot-splash"
      data-phase={phase}
    >
      {phase !== 'ready' ? (
        <LoadingCard leaving={phase === 'closing'} />
      ) : (
        <>
          <div className={styles.melonStage}>
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
          <UpdateStatus />
        </>
      )}
    </div>
  )
}

/**
 * The update check, SAID OUT LOUD on the opening screen, every launch.
 *
 * His words, and he is right: *"every time I open this app, it shows a big
 * loading chunk that checks for every new update, and if there is one, it
 * downloads it automatically."* He had spent weeks on a build four versions old
 * while the app checked silently, failed silently (the feed 404'd), and told him
 * nothing, so from where he sat there was no update system at all.
 *
 * The check and the download were already automatic. What was missing was any
 * evidence of it. The loading card now narrates the check as one of its rows; this
 * line carries whatever is still happening (a download in flight, an update
 * staged for restart) after the card is gone.
 *
 * It deliberately does NOT hold the app hostage while it waits. Blocking the boot
 * on a network call is how you get an editor that will not open when the wifi is
 * bad, and an app that cannot start is a far worse failure than one that starts
 * before it knows.
 */
function UpdateStatus() {
  const status = useUpdateFeed((s) => s.status)
  const text = updateLine(status)
  if (!text) return null
  return (
    <p data-testid="boot-update-status" className={styles.updateStatus}>
      {text}
    </p>
  )
}

/**
 * Boot gate: the loading card and then the melon, with the editor mounting on
 * launch and the splash overlaying it until its exit animation lands ("opens
 * into" the app). Skipped entirely under automation (navigator.webdriver): every
 * e2e spec and verify probe drives the app directly, and a click gate would break
 * all of them.
 */
/**
 * The desktop boot: no card inside the app at all.
 *
 * On the desktop the card lives in its own frameless window over his desktop (see
 * electron/main.ts), which is what he asked for: "no background, no X, it would
 * just show the desktop". So the editor mounts straight away behind a window that
 * is still hidden, mirrors the real ledger out to the splash, and tells main to
 * swap the two when the same gate the web card uses is satisfied.
 */
function DesktopBoot({ children }: { children: ReactNode }) {
  const phase = useBootPhase(true)
  const raw = useBootLedger((s) => s.statuses)
  const specs = useMemo(() => stepsFor(true), [])
  const revealed = useRevealed(specs.length)
  // Same masking as the in-app card, so the ticks land at the same scattered
  // moments in the splash window as they would in the page.
  const statuses = useMemo(() => maskStatuses(specs, raw, revealed), [specs, raw, revealed])

  useEffect(() => {
    const api = window.api
    if (!api?.reportBootProgress) return
    api.reportBootProgress({
      rows: specs.map((spec) => {
        const status = statusOf(statuses, spec.id)
        return { id: spec.id, label: labelOf(spec, status), state: status.state }
      }),
      line: statusLine(specs, statuses),
      percent: Math.round(progressOf(specs, statuses) * 100),
      version: APP_VERSION,
    })
  }, [specs, statuses])

  // The card that is leaving lives in the SPLASH window, not this one, so hand over
  // the moment the gate opens instead of sitting out an exit animation this window
  // is not drawing. Waiting for 'ready' left the splash parked at 100% for the
  // length of a card exit it had not started yet.
  useEffect(() => {
    if (phase !== 'loading') window.api?.bootFinished?.()
  }, [phase])

  return <>{children}</>
}

export function Boot({ children }: { children: ReactNode }) {
  // A `?boot=` override turns the automation skip off. That is how the boot
  // screens get rendered and driven in tests instead of being taken on trust.
  const override = useMemo(currentOverride, [])
  const skip = !override && typeof navigator !== 'undefined' && navigator.webdriver === true
  // The desktop shows the card in its OWN window, so the app must not draw a
  // second one inside itself. An override still forces the in-app screens, which
  // is how they get photographed in the packaged shell.
  const desktop = !override && typeof window !== 'undefined' && window.api?.isElectron === true
  const [launched, setLaunched] = useState(skip)
  const [finished, setFinished] = useState(skip)
  if (desktop) return <DesktopBoot>{children}</DesktopBoot>
  return (
    <>
      {launched && children}
      {!finished && <BootSplash onLaunch={() => setLaunched(true)} onFinished={() => setFinished(true)} />}
    </>
  )
}
