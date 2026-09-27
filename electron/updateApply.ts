// WHEN a downloaded update gets applied, as a pure decision so it can be tested
// without an Electron window.
//
// His ask, 2026-08-17: *"you can check the app every time it does a big thing, and
// then it automatically goes. You don't need to click the melon and stuff like
// that. Make it automatic."*
//
// ⛔ AND IT MUST NOT RESTART UNDER HIM. He streams, so an app that vanishes and
// comes back mid sentence is worse than a toast. So the door is HIS idleness,
// measured by `powerMonitor.getSystemIdleTime()`, which is the whole machine and
// not just this app: it cannot fire while he is typing anywhere. The other door
// is closing the app, which main handles (`autoInstallOnAppQuit`).
//
// ⛔ NO LAUNCH WINDOW, 2026-09-27. Until then an update that finished downloading
// in the first three minutes after launch applied at once, so opening the app
// often meant watching it restart straight into a patch. He was asked and picked
// "Only when I close it". Opening the app is the start of work, not a pause in it.

/** Seconds of no input anywhere on the machine before an update applies itself. */
export const IDLE_APPLY_S = 300

/** How often to look, once an update is sitting downloaded. */
export const IDLE_POLL_MS = 30_000

export interface ApplyInputs {
  /** Seconds since the last input ANYWHERE on the machine. */
  idleSeconds: number
  /** An export, a proxy or a remux is mid flight. A restart would truncate it. */
  busy: boolean
}

/**
 * `'now'` to apply immediately, `'when-idle'` to keep watching, `'never'` while
 * something is mid render.
 *
 * Busy outranks idleness on purpose: a force quit through an export truncates
 * the file and orphans an ffmpeg child, and he would rather have the old version
 * than a broken render.
 */
export function updateApplyDecision({ idleSeconds, busy }: ApplyInputs): 'now' | 'when-idle' | 'never' {
  if (busy) return 'never'
  return idleSeconds >= IDLE_APPLY_S ? 'now' : 'when-idle'
}
