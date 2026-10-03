import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The transport reaches for a real AudioContext to pick its clock. There isn't
// one in node, and it already falls back to the performance clock when the call
// throws, so the stub just makes that path deliberate rather than accidental.
// A test may hand it a fake context (audioMock.ctx) to check what he HEARS.
const audioMock = vi.hoisted(() => ({ ctx: null as unknown }))
vi.mock('./audio', () => ({
  ensureAudioContext: () => {
    if (!audioMock.ctx) throw new Error('no audio context in node')
    return audioMock.ctx
  },
  SCHEDULE_LATENCY_S: 0.02,
}))

const { AUDIO_START_BUDGET_MS, Transport } = await import('./playback')

interface Build {
  /** Hands the stop function back to the transport. */
  land: () => void
  landed: boolean
  stopped: boolean
}

/**
 * A schedule function whose builds finish only when the test says so, which is
 * the whole point: real ones take as long as decoding takes, and the bug lives
 * in what happens while two of them are still in the air.
 */
class FakeScheduler {
  readonly builds: Build[] = []

  readonly schedule = (): Promise<() => void> =>
    new Promise<() => void>((resolve) => {
      const build: Build = { landed: false, stopped: false, land: () => undefined }
      build.land = () => {
        build.landed = true
        resolve(() => {
          build.stopped = true
        })
      }
      this.builds.push(build)
    })

  /** How many builds were started. */
  get started(): number {
    return this.builds.length
  }

  /** Builds that finished and were NOT stopped: the graphs making sound. */
  get live(): number {
    return this.builds.filter((b) => b.landed && !b.stopped).length
  }

  /** Let one build finish, and let the transport's handlers run. */
  async finish(i: number): Promise<void> {
    this.builds[i].land()
    await Promise.resolve()
    await Promise.resolve()
  }

  async finishAll(): Promise<void> {
    for (let i = 0; i < this.builds.length; i++) if (!this.builds[i].landed) await this.finish(i)
  }
}

beforeEach(() => {
  // rAF is not a node global. The callback never runs on purpose: these tests
  // are about the audio graph, and a live loop would move the clock under them.
  globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => undefined) as unknown as typeof cancelAnimationFrame
})

describe('only one audio graph is ever making sound', () => {
  // ⛔ The scar: nudging a volume slider during playback stacked another copy of
  // the whole timeline on top of the one already playing, a few milliseconds out
  // of step, and nothing short of stopping could clear it.

  const start = async (sched: FakeScheduler) => {
    const t = new Transport({ getEndS: () => 60, onTick: () => undefined, schedule: sched.schedule })
    const playing = t.play(0)
    // The first build wins the start race, so playback is audio-clocked.
    await sched.finish(0)
    await playing
    return t
  }

  it('three mix changes in a row leave one voice, whatever order they land in', async () => {
    const sched = new FakeScheduler()
    const t = await start(sched)
    expect(sched.live).toBe(1)

    t.rescheduleAudio()
    t.rescheduleAudio()
    t.rescheduleAudio()
    expect(sched.started).toBe(4)

    // Out of order, which is exactly what decoding does.
    await sched.finish(2)
    await sched.finish(1)
    await sched.finish(3)

    expect(sched.live).toBe(1)
    t.pause()
    expect(sched.live).toBe(0)
  })

  it('stopping while a build is in the air silences it when it lands', async () => {
    const sched = new FakeScheduler()
    const t = await start(sched)
    t.rescheduleAudio()
    t.pause()
    await sched.finishAll()
    expect(sched.live).toBe(0)
  })

  it('a mix change is ignored once playback has stopped', async () => {
    const sched = new FakeScheduler()
    const t = await start(sched)
    t.pause()
    const before = sched.started
    t.rescheduleAudio()
    expect(sched.started).toBe(before)
  })
})

// ⛔ MIC-5, 2026-09-30. pause() handed back the last animation frame's tick,
// not where the transport really was: up to a frame stale on screen, and 151 to
// 792 ms stale in a throttled window. Every Space pause while dubbing resumed
// from there, a stretch he had already heard, and pushed the rest of his take
// later against the picture.
describe('pause stops where the transport really is', () => {
  it('reports the live position, and tells the playhead, not the last frame', async () => {
    let now = 1000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const ticks: number[] = []
    const t = new Transport({ getEndS: () => 60, onTick: (s) => ticks.push(s), schedule: async () => () => undefined })
    await t.play(3)
    // rAF never runs here, so no frame ever ticked: exactly the stale case.
    now += 2500
    expect(t.pause()).toBeCloseTo(5.5, 6)
    expect(ticks.at(-1)).toBeCloseTo(5.5, 6)
    spy.mockRestore()
  })
})

// ⛔ MIC-4, 2026-09-30. A take is placed where he PERFORMED it, and he performs
// to what he hears. So the transport says when each stretch of the timeline
// reaches his ears, measured with getOutputTimestamp, which carries the output
// latency inside it instead of a guess.
describe('what he hears, and when', () => {
  // A context that started at performance 1000 ms, 40 ms of output latency: the
  // sample at context time c comes out of the speakers at 1040 + 1000c.
  const world = { t: 5 }
  const ctx = {
    state: 'running',
    get currentTime() {
      return world.t
    },
    resume: () => Promise.resolve(),
    getOutputTimestamp: () => ({ contextTime: world.t - 0.04, performanceTime: 1000 + 1000 * world.t }),
  }
  const heardAt = (c: number) => 1040 + 1000 * c
  // A scheduler that says when its sound starts, like scheduleAudio does.
  const schedule = () =>
    Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 }))

  it('a play is heard from its first scheduled sample, and a pause ends it where the playhead stops', async () => {
    audioMock.ctx = ctx
    world.t = 5
    const events: [number | null, number | undefined][] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule,
      onHeard: (span, end) => events.push([span ? span.timelineS : null, span ? span.heardAtMs : end]),
    })
    await t.play(2)
    expect(events).toEqual([[2, heardAt(5.02)]])
    expect(t.heardSpan).toEqual({ timelineS: 2, heardAtMs: heardAt(5.02) })

    world.t = 8.02 // three seconds of sound
    const stoppedAt = t.pause()
    expect(stoppedAt).toBeCloseTo(5, 9)
    const [, end] = events[1]!
    expect(end).toBeCloseTo(heardAt(8.02), 6)
    // The stretch he heard ends at exactly the timeline spot the playhead stops
    // on, so the next stretch starts where this one ended: no gap, no overlap.
    expect(2 + (end! - heardAt(5.02)) / 1000).toBeCloseTo(stoppedAt, 9)
    expect(t.heardSpan).toBeNull()
    audioMock.ctx = null
  })

  it('a mix change mid-play CONTINUES the stretch, and the rebuilt sound sits on the picture', async () => {
    audioMock.ctx = ctx
    world.t = 5
    const spans: (number | boolean | null)[][] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule,
      onHeard: (span, end) => spans.push(span ? [span.timelineS, span.heardAtMs, !!span.continues] : [null, end!]),
    })
    await t.play(0)
    world.t = 6.02
    t.rescheduleAudio()
    await Promise.resolve()
    await Promise.resolve()
    // The old sound stopped at 6.02 (one second in); the new one is heard from
    // 6.04, the moment it was scheduled for, and it carries the stretch on.
    expect(spans[1]![1]).toBeCloseTo(heardAt(6.02), 6)
    const [timelineS, heardAtMs, continues] = spans[2] as [number, number, boolean]
    expect(continues).toBe(true)
    expect(heardAtMs).toBeCloseTo(heardAt(6.04), 6)
    // The picture shows exactly what that sound plays when it starts.
    world.t = 6.04
    expect(t.currentTime()).toBeCloseTo(timelineS, 9)
    t.pause()
    audioMock.ctx = null
  })
})

// ⛔ MIC-5, measured 2026-10-01 in the real app: the playhead's clock was read
// again after the sound had been scheduled, so it could start a render quantum
// later than the sound did. Dubbing stretches then met 0.6 to 1.3 ms apart
// instead of exactly. The clock now starts on the sound's own scheduled time.
describe('the playhead runs on the sound’s own clock', () => {
  it('a pause stops the playhead exactly where the sound he heard stopped, even when the clock moved during scheduling', async () => {
    const world = { t: 5 }
    audioMock.ctx = {
      state: 'running',
      get currentTime() {
        return world.t
      },
      resume: () => Promise.resolve(),
      getOutputTimestamp: () => ({ contextTime: world.t - 0.04, performanceTime: 1000 + 1000 * world.t }),
    }
    const spans: [number | null, number][] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      // The sound is scheduled for 5.02, and the clock has moved on a quantum
      // (2.67 ms) by the time the transport reads it.
      schedule: () => {
        const stop = Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })
        world.t += 128 / 48_000
        return Promise.resolve(stop)
      },
      onHeard: (span, end) => spans.push(span ? [span.timelineS, span.heardAtMs] : [null, end!]),
    })
    await t.play(1)
    world.t = 7.02
    const stoppedAt = t.pause()
    const [, heardFrom] = spans[0]!
    const [, heardTo] = spans[1]!
    expect(1 + (heardTo - heardFrom) / 1000).toBeCloseTo(stoppedAt, 9)
    audioMock.ctx = null
  })
})

describe('a stretch ends on the playhead even when the output timestamps wobble', () => {
  it('counts its length on the context clock, not by a second timestamp reading', async () => {
    // Two getOutputTimestamp readings seconds apart disagree by a fraction of a
    // millisecond in the real app (0.2 to 1.3 ms). This one is 0.7 ms off on
    // every reading after the first.
    const world = { t: 5, calls: 0 }
    audioMock.ctx = {
      state: 'running',
      get currentTime() {
        return world.t
      },
      resume: () => Promise.resolve(),
      getOutputTimestamp: () => ({
        contextTime: world.t - 0.04,
        performanceTime: 1000 + 1000 * world.t + (world.calls++ > 0 ? 0.7 : 0),
      }),
    }
    const spans: [number | null, number][] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })),
      onHeard: (span, end) => spans.push(span ? [span.timelineS, span.heardAtMs] : [null, end!]),
    })
    await t.play(0)
    world.t = 7.52
    const stoppedAt = t.pause()
    expect((spans[1]![1] - spans[0]![1]) / 1000).toBeCloseTo(stoppedAt, 9)
    audioMock.ctx = null
  })
})

// ⛔ MIC-4, found by review 2026-10-01 and reproduced in the real app on Green
// and GYM: the first take after opening a project came out on two lines with
// about 85 ms of his voice twice. The first sound of a play is not ready inside
// the start budget, the picture rolls alone, and the sound joins later through
// a rebuild. That rebuild was scheduled from where the picture was when it was
// asked for, so it played 50 ms and more BEHIND the picture for the rest of the
// play, and the take saw two stretches that disagreed. Now a rebuilt sound is
// scheduled from where the picture will be when it starts, the picture is put
// exactly on it, and the stretch it opens says it continues the one before.
describe('a sound rebuilt while play goes on continues the stretch, on the picture', () => {
  const world = { t: 5, perf: 50_000 }
  const ctx = {
    state: 'running',
    get currentTime() {
      return world.t
    },
    resume: () => Promise.resolve(),
    getOutputTimestamp: () => ({ contextTime: world.t - 0.04, performanceTime: 1000 + 1000 * world.t }),
  }
  const heardAt = (c: number) => 1040 + 1000 * c
  type Ev = [number | null, number, boolean | string | undefined]
  const record = (events: Ev[]) => (span: HeardSpanLike | null, end?: number, why?: string) =>
    events.push(span ? [span.timelineS, span.heardAtMs, !!span.continues] : [null, end!, why])
  interface HeardSpanLike {
    timelineS: number
    heardAtMs: number
    continues?: boolean
  }
  let frames: FrameRequestCallback[] = []
  const runFrame = () => frames.splice(0).forEach((f) => f(0))
  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame
    vi.spyOn(performance, 'now').mockImplementation(() => world.perf)
    audioMock.ctx = ctx
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    audioMock.ctx = null
  })

  it('the first sound misses the start budget: one continuing stretch, the picture on the sound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    world.t = 5
    let firstBuild: (stop: () => void) => void = () => undefined
    let calls = 0
    const events: Ev[] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule: () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => (firstBuild = (stop) => resolve(stop)))
        // A warm rebuild: built in 4 ms, sounding a scheduling latency later.
        return Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.004 + 0.02 }))
      },
      onHeard: record(events),
    })
    const playing = t.play(10)
    await vi.advanceTimersByTimeAsync(AUDIO_START_BUDGET_MS + 1)
    await playing
    // The picture rolled alone, from 10, on the context clock.
    expect(events).toEqual([[10, heardAt(5), false]])
    world.t = 5.2
    firstBuild(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    const [, ended] = events[1]!
    const [fromS, soundAt, continues] = events[2] as [number, number, boolean]
    expect(continues).toBe(true)
    expect(soundAt).toBeCloseTo(heardAt(5.224), 6)
    expect(ended).toBeCloseTo(soundAt, 6) // the picture-only stretch ends where the sound begins
    // At the sound's first sample the picture shows exactly what it plays, and
    // that is within a few ms of where the picture alone was heading.
    world.t = 5.224
    expect(t.currentTime()).toBeCloseTo(fromS, 9)
    expect(Math.abs(fromS - (10 + 0.224))).toBeLessThan(0.01)
    t.pause()
  })

  it('a clock that had not started joins the sound as a continuing stretch, and the picture moves onto it', async () => {
    world.t = 0 // the device has not opened yet: the context clock sits at 0
    world.perf = 50_000
    const events: Ev[] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })),
      onHeard: record(events),
    })
    await t.play(4)
    expect(events).toEqual([[4, 50_000, false]]) // the picture alone, on the performance clock
    world.t = 3 // the device opened
    world.perf = 50_300
    runFrame()
    await Promise.resolve()
    await Promise.resolve()
    const [fromS, soundAt, continues] = events[2] as [number, number, boolean]
    expect(continues).toBe(true)
    expect(soundAt).toBeCloseTo(heardAt(3.02), 6)
    world.t = 3.02
    expect(t.currentTime()).toBeCloseTo(fromS, 9) // the picture now runs on the sound's clock
    t.pause()
  })

  it('a loop wrap is a new pass, NOT a continuation', async () => {
    world.t = 5
    const events: Ev[] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      getLoopRange: () => ({ startS: 0, endS: 1 }),
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })),
      onHeard: record(events),
    })
    await t.play(0)
    world.t = 6.1
    runFrame()
    await Promise.resolve()
    await Promise.resolve()
    const last = events[events.length - 1]!
    expect(last[0]).toBe(0)
    expect(last[2]).toBe(false)
    t.pause()
  })

  it('running off the end of the edit says so, and a Space pause does not', async () => {
    world.t = 5
    const events: Ev[] = []
    const t = new Transport({
      getEndS: () => 2,
      onTick: () => undefined,
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })),
      onHeard: record(events),
    })
    await t.play(1)
    world.t = 5.5
    t.pause()
    expect(events[1]![2]).toBeUndefined()
    await t.play(1.48)
    world.t = 6.2
    runFrame()
    expect(events[3]).toEqual([null, expect.any(Number), 'end'])
  })
})
