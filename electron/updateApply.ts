// WHEN a downloaded update gets applied, as a pure decision so it can be tested
// without an Electron window.
//
// His ask, 2026-08-17: *"you can check the app every time it does a big thing, and
// then it automatically goes. You don't need to click the melon and stuff like
// that. Make it automatic."*
//
// Before this, an update applied itself ONLY inside a three minute window after
// launch. Any update that arrived while he was working showed a "Restart to
// install" toast and then waited for a click, which is the click he asked to be
// rid of.
//
// ⛔ AND IT MUST NOT RESTART UNDER HIM. He streams, so an app that vanishes and
// comes back mid sentence is worse than a toast. So the second door is HIS
// idleness, measured by `powerMonitor.getSystemIdleTime()`, which is the whole
// machine and not just this app: it cannot fire while he is typing anywhere.

/** Seconds of no input anywhere on the machine before an update applies itself. */
export const IDLE_APPLY_S = 300

/** How often to look, once an update is sitting downloaded. */
export const IDLE_POLL_MS = 30_000

export interface ApplyInputs {
  /** Still inside the post-launch window, where restarting costs him nothing. */
  freshLaunch: boolean
  /** Seconds since the last input ANYWHERE on the machine. */
  idleSeconds: number
  /** An export, a proxy or a remux is mid flight. A restart would truncate it. */
  busy: boolean
}

/**
 * `'now'` to apply immediately, `'when-idle'` to keep watching, `'never'` while
 * something is mid render.
 *
 * Busy outranks both doors on purpose: a force quit through an export truncates
 * the file and orphans an ffmpeg child, and he would rather have the old version
 * than a broken render.
 */
export function updateApplyDecision({ freshLaunch, idleSeconds, busy }: ApplyInputs): 'now' | 'when-idle' | 'never' {
  if (busy) return 'never'
  if (freshLaunch) return 'now'
  return idleSeconds >= IDLE_APPLY_S ? 'now' : 'when-idle'
}
