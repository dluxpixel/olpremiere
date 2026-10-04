// The usage log's files: one per day, appended to whole, and the days older than the
// rotation thrown away without touching anything else in the folder. Real folders in
// the system temp, because the part worth proving is what survives and what is deleted.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendUsage, cutoffDay, KEEP_DAYS, localDay, pruneUsage, usageFileName } from './usageFiles'

let dir: string

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), 'olp-usage-')), 'Usage log')
})
afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true })
})

const names = (): string[] => readdirSync(dir).sort()
const line = (n: number): string => JSON.stringify({ t: n, s: 'abcd', k: 'key', a: 'c' }) + '\n'

describe('appending a day', () => {
  it('makes the folder and the day file on the first write, and adds to it after', async () => {
    await appendUsage(dir, '2026-10-04', line(1) + line(2))
    await appendUsage(dir, '2026-10-04', line(3))
    expect(names()).toEqual(['usage-2026-10-04.jsonl'])
    expect(readFileSync(path.join(dir, 'usage-2026-10-04.jsonl'), 'utf8')).toBe(line(1) + line(2) + line(3))
  })

  it('keeps each day in its own file', async () => {
    await appendUsage(dir, '2026-10-04', line(1))
    await appendUsage(dir, '2026-10-05', line(2))
    expect(names()).toEqual(['usage-2026-10-04.jsonl', 'usage-2026-10-05.jsonl'])
  })

  it('ends a batch with a newline, so the next one starts on its own line', async () => {
    await appendUsage(dir, '2026-10-04', line(1).trimEnd())
    await appendUsage(dir, '2026-10-04', line(2))
    const lines = readFileSync(path.join(dir, usageFileName('2026-10-04')), 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => JSON.parse(l).t)).toEqual([1, 2])
  })

  it('never lets two batches meet inside a line, however many arrive at once', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => appendUsage(dir, '2026-10-04', line(i).repeat(20))))
    const lines = readFileSync(path.join(dir, usageFileName('2026-10-04')), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(800)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })

  it('refuses anything that is not a real day or a sensible batch, so only our own file names can be written', async () => {
    for (const day of ['../evil', '2026-10-4', '2026-10-04/../x', '', 'usage', '2026-10-04\n']) {
      await expect(appendUsage(dir, day, line(1))).rejects.toThrow(/Refused/)
    }
    await expect(appendUsage(dir, '2026-10-04', '')).rejects.toThrow(/Refused/)
    await expect(appendUsage(dir, '2026-10-04', 'x'.repeat(2_000_001))).rejects.toThrow(/Refused/)
    await expect(appendUsage(dir, '2026-10-04', 42 as unknown as string)).rejects.toThrow(/Refused/)
    expect(() => readdirSync(dir)).toThrow()
  })

  it('stops growing a day that has run away, and says nothing about it', async () => {
    await appendUsage(dir, '2026-10-04', line(1), 100)
    await appendUsage(dir, '2026-10-04', line(2).repeat(10), 100)
    const before = readFileSync(path.join(dir, usageFileName('2026-10-04')), 'utf8').length
    await appendUsage(dir, '2026-10-04', line(3), 100)
    expect(readFileSync(path.join(dir, usageFileName('2026-10-04')), 'utf8')).toHaveLength(before)
  })

  it('still works after a write that failed', async () => {
    // A FILE where the folder should be: the first write cannot succeed.
    mkdirSync(path.dirname(dir), { recursive: true })
    writeFileSync(dir, 'in the way')
    await expect(appendUsage(dir, '2026-10-04', line(1))).rejects.toThrow()
    rmSync(dir)
    await appendUsage(dir, '2026-10-04', line(2))
    expect(names()).toEqual(['usage-2026-10-04.jsonl'])
  })
})

describe('the rotation', () => {
  const touch = (name: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, name), 'x\n')
  }

  it('does the day arithmetic on the calendar, across months, years and a leap day', () => {
    expect(cutoffDay('2026-10-04', 90)).toBe('2026-07-06')
    expect(cutoffDay('2026-01-10', 90)).toBe('2025-10-12')
    expect(cutoffDay('2024-03-01', 1)).toBe('2024-02-29')
    expect(cutoffDay('2025-03-01', 1)).toBe('2025-02-28')
    expect(cutoffDay('2026-10-04', 0)).toBe('2026-10-04')
    expect(KEEP_DAYS).toBe(90)
  })

  it('deletes a day older than the rotation and keeps the day exactly on it', async () => {
    touch(usageFileName('2026-07-05')) // 91 days before 2026-10-04: gone
    touch(usageFileName('2026-07-06')) // 90 days: kept
    touch(usageFileName('2026-10-04'))
    expect(await pruneUsage(dir, '2026-10-04')).toEqual(['usage-2026-07-05.jsonl'])
    expect(names()).toEqual(['usage-2026-07-06.jsonl', 'usage-2026-10-04.jsonl'])
  })

  it('touches only files named like ours, so a note he leaves in the folder is safe', async () => {
    touch('usage-2020-01-01.jsonl')
    touch('notes.txt')
    touch('usage-2020-01-01.jsonl.bak')
    touch('usage-old.jsonl')
    touch('report-2020-01-01.txt')
    await pruneUsage(dir, '2026-10-04')
    expect(names()).toEqual(['notes.txt', 'report-2020-01-01.txt', 'usage-2020-01-01.jsonl.bak', 'usage-old.jsonl'])
  })

  it('is nothing when there is no folder yet', async () => {
    expect(await pruneUsage(dir, '2026-10-04')).toEqual([])
  })

  it('runs by itself on the first write of a day, against the clock of this machine', async () => {
    touch(usageFileName('2020-01-01'))
    touch(usageFileName(localDay(new Date())))
    // A wrong date inside a batch must not be able to age the whole log out.
    await appendUsage(dir, '2099-12-31', line(1))
    for (let i = 0; i < 50 && names().includes(usageFileName('2020-01-01')); i++) await new Promise((r) => setTimeout(r, 20))
    expect(names()).toEqual([usageFileName(localDay(new Date())), usageFileName('2099-12-31')].sort())
  })
})

describe('the day key', () => {
  it('is the date on the wall, with the zeros', () => {
    expect(localDay(new Date(2026, 0, 5, 9, 30))).toBe('2026-01-05')
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})
