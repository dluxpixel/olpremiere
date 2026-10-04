// The usage log's recorder: that recording costs nothing on the spot, that the batch
// goes out later and in one piece, that a day's file is the day he lived, that a sink
// which fails loses nothing and grows nothing, and that no detail can be a path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanDetails,
  cleanString,
  createUsageRecorder,
  extensionOf,
  FLUSH_AT_EVENTS,
  FLUSH_EVERY_MS,
  usageDay,
  type UsageEvent,
  type UsageSink,
} from './usageLog'

/** A sink that remembers what it was handed, parsed back into events. */
function memorySink(): { sink: UsageSink; batches: { day: string; events: UsageEvent[]; text: string }[] } {
  const batches: { day: string; events: UsageEvent[]; text: string }[] = []
  return {
    batches,
    sink: async (day, text) => {
      batches.push({ day, text, events: text.trim().split('\n').map((l) => JSON.parse(l) as UsageEvent) })
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('recording', () => {
  it('writes nothing on the spot: record is a push, the sink hears of it later', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink })
    log.record('key', 'mod+z', { cmd: 'Undo' })
    expect(batches).toHaveLength(0)
    expect(log.stats().pending).toBe(1)
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    expect(batches).toHaveLength(1)
    expect(log.stats().pending).toBe(0)
  })

  it('writes one JSON object per line with when, launch, project, kind, name and details', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink, projectId: () => 'proj-1', now: () => 1_759_570_000_000 })
    log.record('key', 'c', { cmd: 'Split at playhead' })
    log.record('play', 'playback', { sec: 4.2, loop: false }, 3_500.4)
    await log.flush()
    const [first, second] = batches[0]!.events
    expect(first).toMatchObject({ t: 1_759_570_000_000, p: 'proj-1', k: 'key', a: 'c', d: { cmd: 'Split at playhead' } })
    expect(first!.s).toMatch(/^[a-z0-9]{4}$/)
    expect(second).toMatchObject({ k: 'play', a: 'playback', d: { sec: 4.2, loop: false }, ms: 3500 })
    // Every line stands alone, so a file cut off half way loses one line and no more.
    expect(batches[0]!.text.endsWith('\n')).toBe(true)
    expect(batches[0]!.text.trim().split('\n')).toHaveLength(2)
  })

  it('leaves the project out until there is one, and drops empty and missing details', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink, projectId: () => undefined })
    log.record('ui', 'tab-media', { panel: 'left', on: undefined, x: null })
    await log.flush()
    const e = batches[0]!.events[0]!
    expect('p' in e).toBe(false)
    expect(e.d).toEqual({ panel: 'left' })
  })

  it('does nothing while it is off, and is back the moment it is on', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink })
    await log.setEnabled(false)
    log.record('key', 'a')
    expect(log.stats().recorded).toBe(0)
    await log.setEnabled(true)
    log.record('key', 'b')
    await log.flush()
    expect(batches.flatMap((b) => b.events.map((e) => e.a))).toEqual(['b'])
  })

  it('writes what he did while it was on before it switches off, unless told to throw it away', async () => {
    const kept = memorySink()
    const a = createUsageRecorder({ sink: kept.sink })
    a.record('key', 'before')
    await a.setEnabled(false)
    expect(kept.batches.flatMap((b) => b.events.map((e) => e.a))).toEqual(['before'])

    const gone = memorySink()
    const b = createUsageRecorder({ sink: gone.sink })
    b.record('key', 'before')
    await b.setEnabled(false, { discard: true })
    await b.flush()
    expect(gone.batches).toHaveLength(0)
  })

  it('keeps events that arrive before any sink is attached, and writes them once one is', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder()
    log.record('session', 'start')
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 2)
    expect(log.stats().pending).toBe(1)
    log.attach(sink)
    await vi.advanceTimersByTimeAsync(10)
    expect(batches.flatMap((b) => b.events.map((e) => e.a))).toEqual(['start'])
  })

  it('times something that lasts, once', async () => {
    let t = 1_000
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink, now: () => t })
    const end = log.span('export', 'export', { w: 1080 })
    t += 42_000
    end({ outcome: 'done' })
    t += 5_000
    end({ outcome: 'again' })
    await log.flush()
    expect(batches[0]!.events).toHaveLength(1)
    expect(batches[0]!.events[0]).toMatchObject({ k: 'export', ms: 42_000, d: { w: 1080, outcome: 'done' } })
  })

  it('folds a held key into one line with a count', async () => {
    let t = 0
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink, now: () => t })
    log.record('key', 'arrowright', { cmd: 'Step 1 frame forward' })
    for (let i = 0; i < 30; i++) {
      t += 33
      expect(log.repeat('key', 'arrowright', 400)).toBe(true)
    }
    // A different key ends the run, and so does a long pause.
    log.record('key', 'arrowleft')
    t += 5_000
    expect(log.repeat('key', 'arrowleft', 400)).toBe(false)
    await log.flush()
    expect(batches[0]!.events.map((e) => [e.a, e.d?.rep])).toEqual([
      ['arrowright', 30],
      ['arrowleft', undefined],
    ])
  })
})

describe('batching', () => {
  it('writes a burst before the timer, but never inside record', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink })
    for (let i = 0; i < FLUSH_AT_EVENTS; i++) log.record('ui', 'click')
    expect(batches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.events).toHaveLength(FLUSH_AT_EVENTS)
  })

  it('groups a batch into the days it covers, each to its own file', async () => {
    const late = new Date(2026, 9, 4, 23, 59, 58).getTime()
    const early = new Date(2026, 9, 5, 0, 0, 3).getTime()
    let t = late
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink, now: () => t })
    log.record('key', 'a')
    t = early
    log.record('key', 'b')
    await log.flush()
    expect(batches.map((b) => [b.day, b.events.map((e) => e.a)])).toEqual([
      ['2026-10-04', ['a']],
      ['2026-10-05', ['b']],
    ])
  })

  it('names a day by the clock on his wall, with the zeros', () => {
    expect(usageDay(new Date(2026, 0, 5, 9, 0).getTime())).toBe('2026-01-05')
    expect(usageDay(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31')
  })

  it('starts the writes in the same breath when it is flushed as the window closes', () => {
    const calls: string[] = []
    const log = createUsageRecorder({
      sink: (day) => {
        calls.push(day)
        return new Promise(() => undefined)
      },
    })
    log.record('session', 'end')
    void log.flush()
    // Nothing was awaited: the write was already handed over.
    expect(calls).toHaveLength(1)
  })

  it('keeps writing in order when a flush is asked for while one is running', async () => {
    const seen: string[] = []
    let release: () => void = () => undefined
    const log = createUsageRecorder({
      sink: async (_day, text) => {
        seen.push(...text.trim().split('\n').map((l) => (JSON.parse(l) as UsageEvent).a))
        await new Promise<void>((r) => (release = r))
      },
    })
    log.record('key', 'one')
    const first = log.flush()
    log.record('key', 'two')
    const second = log.flush()
    release()
    await first
    await vi.advanceTimersByTimeAsync(0)
    release()
    await second
    expect(seen).toEqual(['one', 'two'])
  })
})

describe('a sink that fails', () => {
  it('puts the batch back and tries again later, in order, losing nothing', async () => {
    let fail = true
    const written: string[] = []
    const log = createUsageRecorder({
      sink: async (_day, text) => {
        if (fail) throw new Error('disk full')
        written.push(...text.trim().split('\n').map((l) => (JSON.parse(l) as UsageEvent).a))
      },
    })
    log.record('key', 'a')
    log.record('key', 'b')
    await log.flush()
    expect(log.stats()).toMatchObject({ pending: 2, failedBatches: 1, written: 0 })
    log.record('key', 'c')
    fail = false
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS * 4)
    expect(written).toEqual(['a', 'b', 'c'])
    expect(log.stats().pending).toBe(0)
  })

  it('never holds more than its bound, and says how many it let go', async () => {
    const log = createUsageRecorder({
      sink: async () => {
        throw new Error('gone')
      },
      maxBuffered: 50,
      flushAtEvents: 10_000,
    })
    for (let i = 0; i < 500; i++) log.record('ui', `n${i}`)
    await log.flush()
    for (let i = 0; i < 500; i++) log.record('ui', `m${i}`)
    const s = log.stats()
    // A quarter over the bound at most: it lets go in one copy per quarter, not one per event.
    expect(s.pending).toBeLessThanOrEqual(62)
    expect(s.dropped).toBeGreaterThan(900)
  })
})

describe('what a detail may be', () => {
  it('turns a path into its extension, whoever passed it', () => {
    expect(cleanString('C:\\Users\\skyle\\Videos\\my private film.MP4')).toBe('mp4')
    expect(cleanString('/home/skyle/clips/take 1.mov')).toBe('mov')
    expect(cleanString('\\\\server\\share\\a.wav')).toBe('wav')
    expect(cleanString('C:\\no-extension')).toBe('?')
    expect(cleanString('~/Movies/Clips/a.mkv')).toBe('mkv')
  })

  it('keeps words that only happen to hold a slash', () => {
    expect(cleanString('Play / Pause')).toBe('Play / Pause')
    expect(cleanString('Loop playback (In/Out range)')).toBe('Loop playback (In/Out range)')
    expect(cleanString('Clear in/out')).toBe('Clear in/out')
  })

  it('flattens lines and cuts what is long', () => {
    expect(cleanString('a\nb\r\nc')).toBe('a b c')
    expect(cleanString('x'.repeat(500))).toHaveLength(96)
  })

  it('keeps small primitives, rounds numbers, and drops everything else', () => {
    const d = cleanDetails({ n: 3.14159265, ok: true, s: 'tool', bad: Number.NaN, inf: Infinity, nothing: undefined, none: null })
    expect(d).toEqual({ n: 3.142, ok: true, s: 'tool' })
    expect(cleanDetails(undefined)).toBeUndefined()
    expect(cleanDetails({ a: undefined })).toBeUndefined()
  })

  it('takes at most a handful of details, under short plain keys', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < 30; i++) many[`key${i}`] = i
    expect(Object.keys(cleanDetails(many)!)).toHaveLength(14)
    expect(Object.keys(cleanDetails({ 'a b/c\\d!': 1, ['k'.repeat(40)]: 2 })!)).toEqual(['abcd', 'k'.repeat(16)])
  })

  it('reads an extension and nothing else', () => {
    expect(extensionOf('Intro.Final.MP4')).toBe('mp4')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('weird.' + 'x'.repeat(20))).toBe('')
  })

  it('applies the same lock inside record, so a path handed to it never reaches the file', async () => {
    const { sink, batches } = memorySink()
    const log = createUsageRecorder({ sink })
    log.record('import', 'Import files', { exts: 'C:\\Users\\skyle\\Desktop\\secret film.mov' })
    await log.flush()
    expect(batches[0]!.text).not.toContain('skyle')
    expect(batches[0]!.text).not.toContain('secret')
    expect(batches[0]!.events[0]!.d).toEqual({ exts: 'mov' })
  })
})
