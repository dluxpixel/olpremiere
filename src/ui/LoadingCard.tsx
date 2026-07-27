// The loading card — the first thing the app shows, in the spirit of the Vegas Pro
// splash he sent: a small landscape box in the middle of a dark screen, the brand
// on one side behind a diagonal seam, the work it is doing listed on the other, a
// status line and a real progress bar along the bottom. When the work is done the
// card pops open into the big melon you click.
//
// The rows are not decoration. Each one is a real startup task reporting itself
// (see bootProgress.ts) — so the list doubles as proof the app did what it should.

import { useMemo } from 'react'
import { APP_VERSION } from '../appVersion'
import { melonPixels } from './melon'
import { MelonMark } from './MelonMark'
import { labelOf, progressOf, statusLine, statusOf, stepsFor, useBootLedger } from './bootProgress'
import styles from './LoadingCard.module.css'

const MARK: Record<string, string> = { done: '✓', failed: '!', active: '›', pending: '·' }

export function LoadingCard({ leaving = false }: { leaving?: boolean }) {
  const isElectron = typeof window !== 'undefined' && window.api?.isElectron === true
  const specs = useMemo(() => stepsFor(isElectron), [isElectron])
  const pixels = useMemo(() => melonPixels(), [])
  const statuses = useBootLedger((s) => s.statuses)

  const pct = Math.round(progressOf(specs, statuses) * 100)
  const line = statusLine(specs, statuses)

  return (
    <div
      className={`${styles.card} ${leaving ? styles.leaving : ''}`}
      data-testid="boot-loading-card"
      role="dialog"
      aria-label="OL Premiere is starting"
    >
      <div className={styles.brand}>
        <span className={styles.glow} aria-hidden="true" />
        <MelonMark className={styles.melon} pixels={pixels} />
        <p className={styles.wordmark}>
          OL <span className={styles.wordmarkStrong}>Premiere</span>
        </p>
        <p className={styles.version}>Version {APP_VERSION}</p>
      </div>

      {/* The lit diagonal edge between the brand and the work. Drawn as a line in
          its own grid cell so it lands exactly on the brand pane's clip path at
          any card size, instead of a skewed div that drifts when the box grows. */}
      <span className={styles.seam} aria-hidden="true">
        <svg viewBox="0 0 30 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="olp-seam" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 138, 108, 0.62)" />
              <stop offset="100%" stopColor="rgba(240, 96, 76, 0.08)" />
            </linearGradient>
          </defs>
          <line x1="30" y1="0" x2="0" y2="100" stroke="url(#olp-seam)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      </span>

      <div className={styles.panel}>
        <p className={styles.panelTitle}>Starting up</p>
        <ul className={styles.steps}>
          {specs.map((spec) => {
            const status = statusOf(statuses, spec.id)
            return (
              <li key={spec.id} className={styles.step} data-state={status.state} data-step={spec.id}>
                <span className={styles.mark} aria-hidden="true">
                  {MARK[status.state]}
                </span>
                <span className={styles.stepText}>{labelOf(spec, status)}</span>
              </li>
            )
          })}
        </ul>
      </div>

      <div className={styles.footer}>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Startup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.footRow}>
          {/* aria-live so a screen reader hears each step land, same as the eye sees it. */}
          <p className={styles.status} data-testid="boot-status-line" role="status" aria-live="polite">
            {line}
          </p>
          <p className={styles.percent}>{pct}%</p>
        </div>
        <p className={styles.legal}>Local-first · your media never leaves this machine</p>
      </div>
    </div>
  )
}
