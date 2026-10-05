// The update log: where the detail of a failed check goes now that the toast no longer
// prints it. Real folders in the system temp, because the part worth proving is what is
// on disk afterwards and that a broken log can never break the updater.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendUpdateLog, UPDATE_LOG_NAME } from './updateLog'

let root: string
let file: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'olp-updlog-'))
  file = path.join(root, 'logs', UPDATE_LOG_NAME)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('appendUpdateLog', () => {
  it('makes the folder and the file on the first entry, and adds to it after', () => {
    appendUpdateLog(file, 'first\n')
    appendUpdateLog(file, 'second\n')
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
  })

  it('cuts a file that has grown past the cap back to its newest part, on a whole line', () => {
    const line = (n: number): string => `entry ${String(n).padStart(4, '0')} ${'x'.repeat(40)}\n`
    appendUpdateLog(file, Array.from({ length: 100 }, (_, i) => line(i)).join(''), 1_000_000)
    expect(statSync(file).size).toBeGreaterThan(4000)
    appendUpdateLog(file, line(100), 4000)
    const text = readFileSync(file, 'utf8')
    expect(statSync(file).size).toBeLessThan(2300)
    // The newest entries survive and the oldest are gone.
    expect(text).toContain('entry 0100')
    expect(text).toContain('entry 0099')
    expect(text).not.toContain('entry 0000')
    // It starts at the head of a line, not halfway into one.
    expect(text.startsWith('entry ')).toBe(true)
  })

  it('never throws, even when the folder cannot be made', () => {
    // A FILE where the folder should be.
    const blocker = path.join(root, 'blocker')
    writeFileSync(blocker, 'not a folder')
    expect(() => appendUpdateLog(path.join(blocker, UPDATE_LOG_NAME), 'x\n')).not.toThrow()
  })
})
