// The private usage log as ordinary files: `usage-2026-10-04.jsonl`, one per day,
// in the app's own user data folder. The renderer decides WHAT is a line (see
// src/state/usageLog.ts for the format and for what is never in one); this decides
// only WHERE, keeps the days apart, and throws away the ones that are too old.
//
// Nothing here parses a line. A batch is appended as it arrives, so the main
// process, which is also the thread that routes his mouse and keyboard, spends its
// time on one small write every few seconds and nothing else. The report script
// (scripts/usage-report.mjs) is the only reader, and it reads a copy of the folder
// as happily as the folder itself.
//
// No import of 'electron' on purpose, so the rotation, which DELETES files, is
// tested against real temporary folders (usageFiles.test.ts).

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

/** Whole days kept. A month and a half past what he asked to look back over. */
export const KEEP_DAYS = 90
/** A day's file stops growing here. A normal day is a few hundred KB; this is a runaway guard. */
export const MAX_DAY_BYTES = 25 * 1024 * 1024
/** One batch is a few KB. Anything near this is not one. */
const MAX_BATCH_CHARS = 2_000_000

const DAY = /^\d{4}-\d{2}-\d{2}$/
const FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/

export const usageFileName = (day: string): string => `usage-${day}.jsonl`

/** `2026-10-04` on the clock of this machine. */
export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The day `keepDays` before `today` (both `YYYY-MM-DD`): files older than this are gone. */
export function cutoffDay(today: string, keepDays: number = KEEP_DAYS): string {
  const [y, m, d] = today.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) - keepDays * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Delete the day files older than the rotation. Only files that are named exactly
 * like ours are touched, so a note he drops in the folder, or the report he saves
 * there, is never swept. Returns the names it removed.
 */
export async function pruneUsage(dir: string, today: string, keepDays: number = KEEP_DAYS): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const cutoff = cutoffDay(today, keepDays)
  const gone: string[] = []
  for (const name of names) {
    const m = FILE.exec(name)
    if (!m || m[1]! >= cutoff) continue
    try {
      await unlink(path.join(dir, name))
      gone.push(name)
    } catch {
      // Locked or already gone: housekeeping must never fail the write that triggered it.
    }
  }
  return gone
}

// One append at a time, so two batches can never interleave inside one line.
let chain: Promise<unknown> = Promise.resolve()
const prunedToday = new Set<string>()

/**
 * Append one day's batch of lines. The renderer is trusted no further than the
 * shape: a day that is a real date string and a text that is not absurd, so this
 * can only ever write a file with our own name pattern inside our own folder.
 */
export function appendUsage(dir: string, day: string, lines: string, maxDayBytes: number = MAX_DAY_BYTES): Promise<void> {
  if (typeof day !== 'string' || !DAY.test(day) || typeof lines !== 'string' || lines.length === 0 || lines.length > MAX_BATCH_CHARS) {
    return Promise.reject(new Error('Refused: not a usage batch'))
  }
  const run = chain.then(async () => {
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, usageFileName(day))
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    )
    // Past the cap the day is simply full: dropping is the safe way to be wrong.
    if (size > maxDayBytes) return
    await appendFile(file, lines.endsWith('\n') ? lines : `${lines}\n`, 'utf8')
    // Rotation runs once a day, against THIS clock, never against the day the renderer
    // sent: a wrong date in a batch must not be able to age his whole log out.
    const today = localDay(new Date())
    const key = `${dir}|${today}`
    if (!prunedToday.has(key)) {
      prunedToday.add(key)
      void pruneUsage(dir, today).catch(() => undefined)
    }
  })
  chain = run.catch(() => undefined)
  return run
}
