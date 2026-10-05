// Where the details of a failed update check go, now that the toast no longer carries
// them. One small rolling file in the app's logs folder: a packaged build has no
// console anyone can read, so `console.error` alone would have thrown the detail away
// the moment the toast stopped printing it.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The file name inside the logs folder. */
export const UPDATE_LOG_NAME = 'update-check.log'

/** Past this the file is cut back to its newest half, so it can never grow without end. */
export const UPDATE_LOG_MAX_BYTES = 200_000

/**
 * Add one entry to the log. Never throws: a problem with the log must not be the
 * thing that stops an update, so every failure here is swallowed.
 */
export function appendUpdateLog(file: string, entry: string, maxBytes = UPDATE_LOG_MAX_BYTES): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      // not there yet
    }
    if (size > maxBytes) {
      const keep = readFileSync(file).subarray(-Math.floor(maxBytes / 2))
      // Start on a whole line, not half of one.
      const nl = keep.indexOf(0x0a)
      writeFileSync(file, nl >= 0 ? keep.subarray(nl + 1) : keep)
    }
    appendFileSync(file, entry, 'utf8')
  } catch {
    // see above
  }
}
