// A page that dies is loaded again and the reason is written down; a page that keeps
// dying stops and says so. Until 2026-10-06 a crashed editor stayed a blank window.

import { describe, expect, it } from 'vitest'
import { CRASH_WINDOW_MS, crashLogLine, crashPlan, MAX_RELOADS } from './crashPlan'

const NOW = 1_000_000_000

describe('crashPlan', () => {
  it('does nothing for a page that ended on purpose', () => {
    expect(crashPlan('clean-exit', [], NOW)).toBe('nothing')
    expect(crashPlan('clean-exit', [NOW - 1000, NOW - 2000], NOW)).toBe('nothing')
  })

  it.each(['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'memory-eviction', 'something new'])(
    'reloads a page that died with %s',
    (reason) => {
      expect(crashPlan(reason, [], NOW)).toBe('reload')
    },
  )

  it('reloads twice inside five minutes, and stops on the third', () => {
    expect(MAX_RELOADS).toBe(2)
    expect(CRASH_WINDOW_MS).toBe(5 * 60_000)
    expect(crashPlan('crashed', [NOW - 60_000], NOW)).toBe('reload')
    expect(crashPlan('oom', [NOW - 120_000, NOW - 60_000], NOW)).toBe('stop')
  })

  it('forgets deaths older than five minutes', () => {
    expect(crashPlan('crashed', [NOW - CRASH_WINDOW_MS, NOW - CRASH_WINDOW_MS - 1], NOW)).toBe('reload')
    expect(crashPlan('crashed', [NOW - CRASH_WINDOW_MS, NOW - 1000], NOW)).toBe('reload')
  })
})

describe('crashLogLine', () => {
  const at = new Date('2026-10-06T12:00:00.000Z')

  it('says when, why, and which version, on one line', () => {
    const line = crashLogLine(at, 'editor page gone', { reason: 'oom', exitCode: -536870904 }, '3.22.0', 'reload')
    expect(line).toBe('2026-10-06T12:00:00.000Z editor page gone reason=oom exitCode=-536870904 version=3.22.0 then=reload\n')
  })

  it('names a child process by its type', () => {
    expect(crashLogLine(at, 'child process gone', { reason: 'crashed', exitCode: 1, type: 'GPU' }, '3.22.0')).toContain(
      'type=GPU',
    )
  })

  it('stays one line whatever it is handed', () => {
    const line = crashLogLine(at, 'x', { reason: 'a\nb', name: 'c\r\nd' }, '1')
    expect(line.split('\n')).toHaveLength(2)
    expect(line.endsWith('\n')).toBe(true)
  })
})
