// The private usage log: a plain record of what he does in the app, kept on his
// own machine and never sent anywhere. His words, 2026-10-04: *"start tracking my
// actions in the app, every single action. After 1 week or more of usage, we can
// see what doesn't get used and could be cut off from the app, and more."*
//
// THE LOG IS ONE JSON OBJECT PER LINE, one file per day, and a line looks like
//
//   {"t":1759570000000,"s":"k3x9","p":"a1b2c3","k":"key","a":"mod+z","d":{"cmd":"Undo"}}
//
//   t   when, epoch ms          s   which launch (or browser tab) it came from
//   p   the project that was open, by id only (never the name)
//   k   the kind of thing       a   its name
//   d   a few small details: counts, tool names, file extensions, settings
//   ms  how long it lasted, for the things that last (a play, an export, a dialog)
//
// ⛔ WHAT IS NEVER WRITTEN, AND THIS IS THE WHOLE POINT OF THE FILE: what he types,
// his caption words, a file's contents, a file or project name, a path. Names
// that come from his own material are masked before they get here (usageNames.ts)
// and `cleanDetails` below is the second lock: a detail that looks like a path is
// cut down to its extension, whoever passed it.
//
// ⛔ IT MAY NEVER COST HIM A FRAME. `record` is one array push and a check; the
// JSON, the grouping into days and the write all happen later, in a batch, off the
// interaction path (every few seconds, and once more as the window closes). A
// sink that fails puts the batch back and tries again later, and the buffer is
// bounded, so a disk that is full or a sink that is gone can never grow memory.
//
// This file knows nothing about the store, React or Electron. The shell attaches a
// sink (usageWiring.ts), which is also what lets the tests drive all of it.

export type UsageKind =
  | 'edit'
  | 'history'
  | 'key'
  | 'ui'
  | 'dialog'
  | 'project'
  | 'import'
  | 'export'
  | 'caption'
  | 'record'
  | 'play'
  | 'zoom'
  | 'toast'
  | 'error'
  | 'session'

export type UsageValue = string | number | boolean
export type UsageDetails = Record<string, UsageValue | undefined | null>

export interface UsageEvent {
  t: number
  s: string
  p?: string
  k: UsageKind
  a: string
  d?: Record<string, UsageValue>
  ms?: number
}

/** Writes one day's lines (already newline terminated). May reject: the batch is kept and retried. */
export type UsageSink = (day: string, lines: string) => Promise<void>

export const FLUSH_EVERY_MS = 5_000
/** A burst this big does not wait for the timer. */
export const FLUSH_AT_EVENTS = 200
/** The most a dead sink may hold. Oldest go first, newest are what he is doing now. */
export const MAX_BUFFERED = 4_000
const RETRY_MAX_MS = 60_000
const MAX_DETAIL_KEYS = 14
const MAX_STRING = 96

/** `2026-10-04` in HIS clock: a day's file is the day he lived, not the UTC one. */
export function usageDay(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `.mp4` of `C:\x\my film.mp4`, or '' when there is none. Extensions are all a path may leave behind. */
export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name.trim())
  return m ? m[1]!.toLowerCase() : ''
}

/** A drive, a backslash, or a run of folders. "In/Out" and "Play / Pause" are words, not paths. */
function looksLikePath(s: string): boolean {
  return /^[A-Za-z]:/.test(s) || s.includes('\\') || /(?:^|\s)\.{0,2}\/[^\s/]+\//.test(s) || /[^\s/]+\/[^\s/]+\/[^\s/]+/.test(s)
}

/** A detail string: one line, short, and never a path. */
export function cleanString(v: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (looksLikePath(flat)) return extensionOf(flat) || '?'
  return flat.length > MAX_STRING ? flat.slice(0, MAX_STRING) : flat
}

/** The second lock: only small primitives, short keys, no paths, at most a handful. */
export function cleanDetails(details: UsageDetails | undefined): Record<string, UsageValue> | undefined {
  if (!details) return undefined
  let out: Record<string, UsageValue> | undefined
  let n = 0
  for (const key of Object.keys(details)) {
    const v = details[key]
    if (v === undefined || v === null) continue
    if (n >= MAX_DETAIL_KEYS) break
    let clean: UsageValue
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue
      clean = Math.round(v * 1000) / 1000
    } else if (typeof v === 'boolean') clean = v
    else clean = cleanString(String(v))
    out ??= {}
    out[key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'x'] = clean
    n += 1
  }
  return out
}

const cleanAction = (a: string): string =>
  // eslint-disable-next-line no-control-regex
  a.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) || '?'

function groupByDay(events: readonly UsageEvent[]): Map<string, UsageEvent[]> {
  const days = new Map<string, UsageEvent[]>()
  for (const e of events) {
    const day = usageDay(e.t)
    const list = days.get(day)
    if (list) list.push(e)
    else days.set(day, [e])
  }
  return days
}

export interface UsageStats {
  recorded: number
  written: number
  dropped: number
  failedBatches: number
  pending: number
}

export interface UsageRecorder {
  /**
   * One thing he did. Cheap: nothing here touches a disk, a store or the DOM. `at` is for
   * the rare thing noticed a moment after it happened (a dialog that opened), so the line
   * carries when it HAPPENED and not when a busy page got round to looking.
   */
  record: (kind: UsageKind, action: string, details?: UsageDetails, ms?: number, at?: number) => void
  /** Start timing something that lasts. The returned function records it, with its length, once. */
  span: (kind: UsageKind, action: string, details?: UsageDetails) => (more?: UsageDetails) => void
  /**
   * A held key fires again and again. Counts one more on the newest event when it is
   * this same key and has not been written yet, instead of making a line per repeat.
   * Typing into a field is the same shape: one edit per keystroke, one line per run.
   * Only while the last one is under `withinMs` old, so two runs a minute apart stay two.
   */
  repeat: (kind: UsageKind, action: string, withinMs?: number) => boolean
  /** Write everything waiting. Resolves when this batch is on disk (or kept for a retry). */
  flush: () => Promise<void>
  /** Off stops recording at once; what was already recorded is written first unless `discard`. */
  setEnabled: (on: boolean, opts?: { discard?: boolean }) => Promise<void>
  isEnabled: () => boolean
  /** Where batches go, and how to tell which project is open. Null sink = keep buffering. */
  attach: (sink: UsageSink | null, projectId?: () => string | undefined) => void
  stats: () => UsageStats
  readonly session: string
}

export interface RecorderOptions {
  sink?: UsageSink | null
  projectId?: () => string | undefined
  now?: () => number
  flushEveryMs?: number
  flushAtEvents?: number
  maxBuffered?: number
  enabled?: boolean
}

export function createUsageRecorder(opts: RecorderOptions = {}): UsageRecorder {
  // Read Date.now at call time, never captured: a clock that is faked afterwards still counts.
  const now = opts.now ?? ((): number => Date.now())
  const flushEveryMs = opts.flushEveryMs ?? FLUSH_EVERY_MS
  const flushAtEvents = opts.flushAtEvents ?? FLUSH_AT_EVENTS
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED
  const session = Math.random().toString(36).slice(2, 6).padEnd(4, '0')

  let sink: UsageSink | null = opts.sink ?? null
  let projectId: (() => string | undefined) | undefined = opts.projectId
  let enabled = opts.enabled ?? true
  let buffer: UsageEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let retryMs = flushEveryMs
  let recorded = 0
  let written = 0
  let dropped = 0
  let failedBatches = 0
  /** When the newest line was last added to, by `record` or by `repeat`. */
  let touched = 0

  /** The timer is already set for as soon as this task ends, so a burst does not set it again. */
  let soon = false

  const arm = (ms: number): void => {
    if (!sink) return
    if (ms === 0) {
      if (soon) return
      // A burst reached the size where waiting for the timer is pointless: replace it.
      if (timer !== null) clearTimeout(timer)
      soon = true
    } else if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      soon = false
      void flush()
    }, ms)
    // A pending log write must never be the thing that keeps a process alive.
    ;(timer as { unref?: () => void }).unref?.()
  }

  /**
   * Past the bound, let go of the oldest down TO the bound. Done a quarter over, not on every
   * push, so a dead sink costs one copy per quarter of a buffer and not one per event.
   */
  const trim = (): void => {
    if (buffer.length <= maxBuffered) return
    dropped += buffer.length - maxBuffered
    buffer = buffer.slice(buffer.length - maxBuffered)
  }

  const push = (e: UsageEvent): void => {
    buffer.push(e)
    touched = e.t
    recorded += 1
    if (buffer.length > maxBuffered + (maxBuffered >> 2)) trim()
    // Soon, not now: `record` stays a push.
    arm(buffer.length >= flushAtEvents ? 0 : retryMs)
  }

  const send = async (batch: UsageEvent[]): Promise<void> => {
    const failed: UsageEvent[] = []
    const write = sink
    if (!write) {
      buffer = [...batch, ...buffer]
      trim()
      return
    }
    // Every day's write is started in the same breath, before anything is awaited:
    // the last flush runs as the window closes and gets no second chance.
    await Promise.all(
      [...groupByDay(batch)].map(async ([day, events]) => {
        try {
          await write(day, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
          written += events.length
        } catch {
          failed.push(...events)
        }
      }),
    )
    if (failed.length > 0) {
      failedBatches += 1
      failed.sort((a, b) => a.t - b.t)
      buffer = [...failed, ...buffer]
      trim()
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
      arm(retryMs)
    } else retryMs = flushEveryMs
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight.then(() => (buffer.length > 0 && sink ? flush() : undefined))
    if (!sink || buffer.length === 0) return Promise.resolve()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    soon = false
    const batch = buffer
    buffer = []
    inFlight = send(batch).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const recorder: UsageRecorder = {
    session,

    record(kind, action, details, ms, at) {
      if (!enabled) return
      const e: UsageEvent = { t: at ?? now(), s: session, k: kind, a: cleanAction(action) }
      const p = projectId?.()
      if (p) e.p = p
      const d = cleanDetails(details)
      if (d) e.d = d
      if (ms !== undefined && Number.isFinite(ms)) e.ms = Math.max(0, Math.round(ms))
      push(e)
    },

    span(kind, action, details) {
      const started = now()
      let done = false
      return (more) => {
        if (done) return
        done = true
        recorder.record(kind, action, { ...details, ...more }, now() - started)
      }
    },

    repeat(kind, action, withinMs = 1000) {
      if (!enabled) return false
      const last = buffer[buffer.length - 1]
      if (!last || last.k !== kind || last.a !== action || now() - touched > withinMs) return false
      touched = now()
      const d = (last.d ??= {})
      d.rep = (typeof d.rep === 'number' ? d.rep : 0) + 1
      return true
    },

    flush,

    async setEnabled(on, o) {
      if (on === enabled) return
      if (!on) {
        // What he did while it was on is his record; switching off ends it there.
        if (o?.discard) buffer = []
        else await flush()
        enabled = false
        return
      }
      enabled = true
    },

    isEnabled: () => enabled,

    attach(next, project) {
      sink = next
      if (project) projectId = project
      if (sink && buffer.length > 0) arm(0)
    },

    stats: () => ({ recorded, written, dropped, failedBatches, pending: buffer.length }),
  }
  return recorder
}

/** The one log the app writes to. Starts without a sink, so early events wait for the shell. */
export const usage: UsageRecorder = createUsageRecorder()
