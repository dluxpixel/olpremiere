// The stall watch: an export that stops moving ends with a plain message, a busy or sleeping page
// never fails a healthy one. A clock moved by hand, so none of this waits.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plainExportError } from './plainError'
import { setStallLimitMs, STALLED_MESSAGE, stallLimits, startStallWatch } from './stallWatch'

function rig(limit = 120_000, extra: { frozenMs?: number } = {}) {
  let t = 1_000_000
  const stalls: number[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const watch = startStallWatch({
    limitMs: () => limit,
    onStall: (q) => stalls.push(q),
    tickMs: 5_000,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false })
      return timers.length - 1
    },
    clearTimer: (id) => {
      timers[id as number].cleared = true
    },
    ...extra,
  })
  /** Let `ms` pass, looking every 5 s the way the timer does. */
  const pass = (ms: number): void => {
    for (let spent = 0; spent < ms; spent += 5_000) {
      t += Math.min(5_000, ms - spent)
      watch.check()
    }
  }
  return { watch, stalls, timers, pass, jump: (ms: number) => (t += ms) }
}

afterEach(() => setStallLimitMs(null))

describe('a quiet export is ended', () => {
  it('after the limit with no sign of life, on the second look that finds it quiet', () => {
    const r = rig()
    r.pass(120_000)
    expect(r.stalls).toEqual([])
    // Past the limit: the first look only suspects.
    r.pass(5_000)
    expect(r.stalls).toEqual([])
    r.pass(5_000)
    expect(r.stalls).toHaveLength(1)
    expect(r.stalls[0]).toBeGreaterThan(120_000)
  })

  it('once, however long it stays quiet, and the timer is cleared', () => {
    const r = rig()
    r.pass(400_000)
    expect(r.stalls).toHaveLength(1)
    expect(r.timers[0].cleared).toBe(true)
  })

  it('looks every 5 seconds', () => {
    expect(rig().timers[0].ms).toBe(5_000)
  })
})

describe('a sign of life keeps it going', () => {
  it('a poke every minute never stalls, however long it runs', () => {
    const r = rig()
    for (let i = 0; i < 60; i++) {
      r.pass(60_000)
      r.watch.poke()
    }
    expect(r.stalls).toEqual([])
  })

  it('a poke between the first sighting and the second clears the doubt', () => {
    const r = rig()
    r.pass(125_000)
    expect(r.stalls).toEqual([])
    r.watch.poke()
    r.pass(120_000)
    expect(r.stalls).toEqual([])
    r.pass(10_000)
    expect(r.stalls).toHaveLength(1)
  })
})

describe('a machine that slept or froze is not a stalled export', () => {
  it('a look far later than the last one starts the count again', () => {
    const r = rig()
    r.pass(60_000)
    r.jump(10 * 60_000)
    r.watch.check()
    r.pass(110_000)
    expect(r.stalls).toEqual([])
    r.pass(20_000)
    expect(r.stalls).toHaveLength(1)
  })

  it('a page slowed to a look a minute still finds a real stall', () => {
    const r = rig()
    let spent = 0
    while (!r.stalls.length && spent < 600_000) {
      r.jump(60_000)
      r.watch.check()
      spent += 60_000
    }
    expect(r.stalls).toHaveLength(1)
    expect(spent).toBeLessThanOrEqual(240_000)
  })
})

describe('the limit follows the phase', () => {
  it('a longer limit holds off the stall, a shorter one is asked for at every look', () => {
    let limit = 600_000
    let t = 0
    const stalls: number[] = []
    const w = startStallWatch({
      limitMs: () => limit,
      onStall: (q) => stalls.push(q),
      now: () => t,
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    for (let i = 0; i < 100; i++) {
      t += 5_000
      w.check()
    }
    expect(stalls).toEqual([])
    limit = 120_000
    t += 5_000
    w.check()
    t += 5_000
    w.check()
    expect(stalls).toHaveLength(1)
  })
})

describe('stop', () => {
  it('ends the watch for good, and pokes and looks after it do nothing', () => {
    const r = rig()
    r.watch.stop()
    r.watch.stop()
    r.pass(500_000)
    r.watch.poke()
    expect(r.stalls).toEqual([])
    expect(r.timers[0].cleared).toBe(true)
  })
})

describe('the real timer', () => {
  it('fires through setInterval, and stop clears it', () => {
    vi.useFakeTimers()
    try {
      const stalls: number[] = []
      const w = startStallWatch({ limitMs: () => 20_000, onStall: (q) => stalls.push(q), tickMs: 5_000 })
      vi.advanceTimersByTime(60_000)
      expect(stalls).toHaveLength(1)
      const stalls2: number[] = []
      const w2 = startStallWatch({ limitMs: () => 20_000, onStall: (q) => stalls2.push(q), tickMs: 5_000 })
      w2.stop()
      vi.advanceTimersByTime(60_000)
      expect(stalls2).toEqual([])
      w.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the limits', () => {
  it('are 2 minutes while frames flow and 10 around them, looked at every 5 seconds', () => {
    expect(stallLimits()).toEqual({ runMs: 120_000, slowMs: 600_000, tickMs: 5_000 })
  })

  it('the test seam shortens them, looks more often, and null puts the real ones back', () => {
    setStallLimitMs(8_000)
    expect(stallLimits()).toEqual({ runMs: 8_000, slowMs: 40_000, tickMs: 2_000 })
    setStallLimitMs(null)
    expect(stallLimits().runMs).toBe(120_000)
    setStallLimitMs(-5)
    expect(stallLimits().runMs).toBe(120_000)
  })
})

describe('what he reads', () => {
  it('is shown exactly as written, not folded into the generic "stopped" line', () => {
    const plain = plainExportError(STALLED_MESSAGE)
    expect(plain).toEqual({ line: STALLED_MESSAGE, details: null, generic: false })
  })

  it('has no dashes', () => {
    expect(STALLED_MESSAGE).not.toContain(String.fromCharCode(0x2013))
    expect(STALLED_MESSAGE).not.toContain(String.fromCharCode(0x2014))
  })
})
