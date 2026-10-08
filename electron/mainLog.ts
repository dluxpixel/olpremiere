// The main process's diary: logs/main.log, never shown to him.
//
// A packaged build has no console anyone can read, so every `console.warn` in main went
// nowhere: a preview copy that failed, which encoder the conversions settled on, an
// emoji font that would not download, and the updater's own account of what it did.
// Those are exactly what the "the store rebuilt itself" hunts needed and did not have.
// Same rolling file rule as the update log (./updateLog): small, cut back to its newest
// half past 200 KB, and never able to throw.
//
// No `electron` import, so the modules that log (proxy, remuxRun) still run in tests.
// main points it at the file once it knows where the logs folder is.

import { appendUpdateLog } from './updateLog'

export const MAIN_LOG_NAME = 'main.log'

/** Longest one entry can be. A stack is enough, a whole response is not. */
const ENTRY_CHARS = 4000

export type Level = 'info' | 'warn' | 'error'

let file: string | null = null

/** Where entries go from now on, or null for the console only. */
export function setMainLogFile(path: string | null): void {
  file = path
}

function text(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}

/** One entry: when, how bad, what. A stack keeps its lines, indented under the first. */
export function formatEntry(at: Date, level: Level, args: readonly unknown[]): string {
  const body = args.map(text).join(' ').slice(0, ENTRY_CHARS).replace(/\r?\n/g, '\n    ')
  return `${at.toISOString()} ${level} ${body}\n`
}

/** Say it on the console, as before, and keep it in logs/main.log. */
export function mainLog(level: Level, ...args: unknown[]): void {
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  out(...args)
  if (file) appendUpdateLog(file, formatEntry(new Date(), level, args))
}

/** The shape electron-updater wants for `autoUpdater.logger`. */
export const mainLogger = {
  info: (message?: unknown): void => mainLog('info', message),
  warn: (message?: unknown): void => mainLog('warn', message),
  error: (message?: unknown): void => mainLog('error', message),
}
