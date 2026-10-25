// What to do when the editor's page dies under him, as a pure decision so it can be
// tested without crashing a real window.
//
// ⛔ A DEAD PAGE USED TO STAY DEAD. The editor is GPU and memory heavy (WebGL, WebCodecs,
// 4K decode, on a machine measured already paging), so an out of memory or GPU crash
// mid edit is a real thing. Until 2026-10-06 nothing answered it: the window went blank,
// took no input, and nothing wrote down why. A packaged build has no console, so the
// reason was lost and he had to close a dead window and open it again.
//
// So the page is loaded again, and the reason goes in a log. But a page that dies on
// every load would reload forever, burning his machine, so a third death inside a few
// minutes stops and says so instead.

/** Reloads allowed inside CRASH_WINDOW_MS before the app gives up and says so. */
export const MAX_RELOADS = 2

/** How far back a death still counts against MAX_RELOADS. */
export const CRASH_WINDOW_MS = 5 * 60_000

/** The log the reasons go to, inside the app's logs folder. */
export const CRASH_LOG_NAME = 'crash.log'

/**
 * `'nothing'` for a page that ended on purpose, `'reload'` to bring it back, `'stop'`
 * when it has already died MAX_RELOADS times inside CRASH_WINDOW_MS.
 *
 * `earlier` is when the page died before (any order, old ones are ignored), not
 * counting this time.
 */
export function crashPlan(reason: string, earlier: readonly number[], now: number): 'nothing' | 'reload' | 'stop' {
  if (reason === 'clean-exit') return 'nothing'
  const recent = earlier.filter((t) => now - t >= 0 && now - t < CRASH_WINDOW_MS).length
  return recent >= MAX_RELOADS ? 'stop' : 'reload'
}

/** One line for the crash log. Never more than one line, whatever it is handed. */
export function crashLogLine(
  at: Date,
  what: string,
  details: { reason?: string; exitCode?: number; type?: string; name?: string },
  version: string,
  plan?: string,
): string {
  const parts = [
    at.toISOString(),
    what,
    `reason=${details.reason ?? '?'}`,
    `exitCode=${details.exitCode ?? '?'}`,
    details.type ? `type=${details.type}` : '',
    details.name ? `name=${details.name}` : '',
    `version=${version}`,
    plan ? `then=${plan}` : '',
  ]
  return parts.filter(Boolean).join(' ').replace(/[\r\n]+/g, ' ') + '\n'
}
