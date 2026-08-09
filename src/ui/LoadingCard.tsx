// The loading card: the first thing the app shows. A small landscape box in the
// middle of a dark screen, the brand on one side, the work it is doing listed on
// the other, a status line and a real progress bar along the bottom. When the work
// is done the card pops open into the big melon you click.
//
// The rows are not decoration. Each one is a real startup task reporting itself
// (see bootProgress.ts), so the list doubles as proof the app did what it should.
//
// The list is in TWO groups, and that split is the honest part of this screen.
// The top group is the rows that hold the app shut; the bar under it has one
// segment per one of them and the readout says "3 of 8". The bottom group is the
// rows the app deliberately does not wait for, named as such, because it really
// does open before the update check and the caption model have finished and a card
// that hid that was showing him a full bar over three unfinished rows.

import { useMemo } from 'react'
import { displayVersion } from '../appVersion'
import { melonPixels } from './melon'
import { MelonMark } from './MelonMark'
import {
  gatingCount,
  labelOf,
  progressOf,
  statusLine,
  statusOf,
  stepsFor,
  useBootLedger,
  type BootStepSpec,
} from './bootProgress'
import { BACKGROUND_TITLE, GATING_TITLE, LEGAL_LINE, MARK, cursorIndex, splitRows } from './bootCopy'
import { maskStatuses, useRevealed } from './bootReveal'
import styles from './LoadingCard.module.css'

export function LoadingCard({ leaving = false }: { leaving?: boolean }) {
  const isElectron = typeof window !== 'undefined' && window.api?.isElectron === true
  const specs = useMemo(() => stepsFor(isElectron), [isElectron])
  const pixels = useMemo(() => melonPixels(), [])
  const raw = useBootLedger((s) => s.statuses)
  // The ticks land on their own scattered schedule (his ask: 4 to 8 seconds, one
  // after a second, one after 1.5, one after 4). A row still only shows what the
  // real work did, it just waits for its moment to show it.
  const revealed = useRevealed(specs.length)
  const statuses = useMemo(() => maskStatuses(specs, raw, revealed), [specs, raw, revealed])

  const { gating, background } = splitRows(specs)
  const { settled, total } = gatingCount(specs, statuses)
  const pct = Math.round(progressOf(specs, statuses) * 100)
  const line = statusLine(specs, statuses)
  // The one row the eye should land on, picked over the WHOLE list in display
  // order, so the lit row keeps walking downward as it crosses into the second
  // group instead of restarting at the top of it.
  const cursor = cursorIndex(specs.map((spec) => statusOf(statuses, spec.id).state))
  const cursorId = cursor >= 0 ? specs[cursor].id : null

  const row = (spec: BootStepSpec) => {
    const status = statusOf(statuses, spec.id)
    return (
      <li
        key={spec.id}
        className={styles.step}
        data-state={status.state}
        data-step={spec.id}
        data-cursor={spec.id === cursorId ? 'true' : undefined}
      >
        <span className={styles.mark} aria-hidden="true">
          {MARK[status.state]}
        </span>
        <span className={styles.stepText}>{labelOf(spec, status)}</span>
      </li>
    )
  }

  return (
    <div
      className={`${styles.card} ${leaving ? styles.leaving : ''}`}
      data-testid="boot-loading-card"
      role="dialog"
      aria-label="OL Premiere is starting"
    >
      <div className={styles.brand}>
        {/* The bloom is inside the same box as the fruit, so it stays centred on it
            at any card height rather than on a percentage of the pane. */}
        <span className={styles.brandMark}>
          <span className={styles.glow} aria-hidden="true" />
          <MelonMark className={styles.melon} pixels={pixels} />
        </span>
        <p className={styles.wordmark}>
          OL <span className={styles.wordmarkStrong}>Premiere</span>
        </p>
        <p className={styles.version}>Version {displayVersion()}</p>
      </div>

      <div className={styles.panel}>
        <p className={styles.groupTitle}>{GATING_TITLE}</p>
        {/* data-group is the hook the e2e spec counts against the bar's segments.
            Without a stable name for "the rows the bar is counting" there is no way
            to assert from the outside that the two agree, which is the whole fault
            this screen was redesigned for. */}
        <ul className={styles.steps} data-group="gating">
          {gating.map(row)}
        </ul>
        {background.length > 0 && (
          <>
            <p className={`${styles.groupTitle} ${styles.groupLater}`}>{BACKGROUND_TITLE}</p>
            <ul className={styles.steps} data-group="background">
              {background.map(row)}
            </ul>
          </>
        )}
      </div>

      <div className={styles.footer}>
        {/* One segment per gating row. aria-valuenow stays the percentage because
            that is what the role is defined in; aria-valuetext carries the count
            the eye is given, so neither reading is the one nobody can check. */}
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Startup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${settled} of ${total} startup steps`}
        >
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={styles.seg}
              data-fill={i < settled ? 'true' : undefined}
              data-lead={i === settled - 1 ? 'true' : undefined}
            />
          ))}
        </div>
        <div className={styles.footRow}>
          {/* aria-live so a screen reader hears each step land, same as the eye sees it. */}
          <p className={styles.status} data-testid="boot-status-line" role="status" aria-live="polite">
            {line}
          </p>
          <p className={styles.count} data-testid="boot-step-count">
            {settled} of {total}
          </p>
        </div>
        <p className={styles.legal}>{LEGAL_LINE}</p>
      </div>
    </div>
  )
}
