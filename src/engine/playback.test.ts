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
type StopAudio = import('./playback').StopAudio

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

  // PB-9, 2026-10-06: every pass after the first ran the picture ahead of the
  // sound by its scheduling latency and build time.
  it('after a loop wrap the picture is exactly on the new sound', async () => {
    world.t = 5
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      getLoopRange: () => ({ startS: 0, endS: 1 }),
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.07 })),
    })
    await t.play(0)
    world.t = 6.1 // past the loop's end: this frame wraps
    runFrame()
    await Promise.resolve()
    await Promise.resolve()
    const startsAt = 6.1 + 0.07
    world.t = startsAt
    expect(t.currentTime()).toBeCloseTo(0, 6)
    world.t = startsAt + 0.5
    expect(t.currentTime()).toBeCloseTo(0.5, 6)
    t.pause()
  })

  it('a looped shuttle stays silent after the wrap', async () => {
    world.t = 5
    let builds = 0
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      getLoopRange: () => ({ startS: 0, endS: 1 }),
      schedule: () => {
        builds += 1
        return Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 }))
      },
    })
    await t.play(0, 2)
    world.t = 5.6 // two times speed: past the end of the loop
    runFrame()
    await Promise.resolve()
    expect(builds).toBe(0)
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

// ⛔ AU-9. A mix change mid-play stopped the sound at once and left 50 ms and
// more of nothing, with a click at each end, before the rebuilt graph came in.
describe('a seamless rebuild leaves no hole', () => {
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

  interface Graph {
    stopped: boolean
    handedOverAt: number | null
    mixes: number
    land: () => void
    fail: () => void
  }
  /** Graphs that land when the test says, each saying how it was let go. */
  const graphs = () => {
    const made: Graph[] = []
    const schedule = () =>
      new Promise<StopAudio>((resolve, reject) => {
        const g: Graph = { stopped: false, handedOverAt: null, mixes: 0, land: () => undefined, fail: () => undefined }
        const startsAtCtxS = () => world.t + 0.02
        g.land = () =>
          resolve(
            Object.assign(
              () => {
                g.stopped = true
              },
              {
                startsAtCtxS: startsAtCtxS(),
                stopAt: (at: number) => {
                  g.handedOverAt = at
                },
                setMix: () => {
                  g.mixes += 1
                  return true
                },
              },
            ),
          )
        g.fail = () => reject(new Error('decode failed'))
        made.push(g)
      })
    return { made, schedule }
  }
  const tick = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  beforeEach(() => {
    audioMock.ctx = ctx
    world.t = 5
  })
  afterEach(() => {
    audioMock.ctx = null
  })

  it('the old sound plays on while the new one is built, and hands over where the new one starts', async () => {
    const { made, schedule } = graphs()
    const spans: (number | boolean | null)[][] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule,
      onHeard: (span, end) => spans.push(span ? [span.timelineS, span.heardAtMs, !!span.continues] : [null, end!]),
    })
    const playing = t.play(0)
    made[0]!.land()
    await playing
    world.t = 6.02
    t.rescheduleAudio({ seamless: true })
    // Still sounding while the new graph is built.
    expect(made[0]!.stopped).toBe(false)
    expect(made[0]!.handedOverAt).toBeNull()
    expect(spans).toHaveLength(1)

    world.t = 6.03 // built in 10 ms, sounding at 6.05
    made[1]!.land()
    await tick()
    expect(made[0]!.handedOverAt).toBeCloseTo(6.05, 9)
    expect(made[0]!.stopped).toBe(false)
    // What he heard runs on without a gap: the old stretch ends exactly where
    // the new one, which continues it, begins.
    expect(spans[1]![1]).toBeCloseTo(heardAt(6.05), 6)
    expect(spans[2]![1]).toBeCloseTo(heardAt(6.05), 6)
    expect(spans[2]![2]).toBe(true)
    t.pause()
    expect(made[1]!.stopped).toBe(true)
  })

  it('many changes in a row still leave one voice, handed over once', async () => {
    const { made, schedule } = graphs()
    const t = new Transport({ getEndS: () => 60, onTick: () => undefined, schedule })
    const playing = t.play(0)
    made[0]!.land()
    await playing
    t.rescheduleAudio({ seamless: true })
    t.rescheduleAudio({ seamless: true })
    t.rescheduleAudio({ seamless: true })
    made[2]!.land()
    made[1]!.land()
    await tick()
    // Older builds land and go without touching the sound still playing.
    expect(made[1]!.stopped && made[2]!.stopped).toBe(true)
    expect(made[0]!.handedOverAt).toBeNull()
    made[3]!.land()
    await tick()
    expect(made[0]!.handedOverAt).not.toBeNull()
    t.pause()
    expect(made.filter((g) => !g.stopped && g.handedOverAt === null)).toHaveLength(0)
  })

  it('a pause while the new sound is built stops the old one now, and the new one when it lands', async () => {
    const { made, schedule } = graphs()
    const t = new Transport({ getEndS: () => 60, onTick: () => undefined, schedule })
    const playing = t.play(0)
    made[0]!.land()
    await playing
    t.rescheduleAudio({ seamless: true })
    t.pause()
    expect(made[0]!.stopped).toBe(true)
    made[1]!.land()
    await tick()
    expect(made[1]!.stopped).toBe(true)
  })

  it('a rebuild that fails stops the old sound, and the stretch with it', async () => {
    const { made, schedule } = graphs()
    const ends: number[] = []
    const t = new Transport({
      getEndS: () => 60,
      onTick: () => undefined,
      schedule,
      onHeard: (span, end) => {
        if (!span) ends.push(end!)
      },
    })
    const playing = t.play(0)
    made[0]!.land()
    await playing
    t.rescheduleAudio({ seamless: true })
    world.t = 6
    made[1]!.fail()
    await tick()
    expect(made[0]!.stopped).toBe(true)
    expect(ends).toHaveLength(1)
    t.pause()
  })

  // ⛔ SF-1, review 2026-10-08. A clip edit mid-play rebuilds the sound, and the
  // rebuild waits on every decode and noise pass it needs. The new sound was
  // scheduled from where the playhead was predicted to be a few ms after the
  // edit, but it started seconds later, and the picture was then moved onto it:
  // picture and sound both jumped BACK by the build time and replayed it. And a
  // slow build was learned, so the next quick one skipped AHEAD by half of it.
  describe('a slow rebuild keeps the playhead where he hears it', () => {
    /**
     * Graphs that land when the test says. `places` says whether the scheduler
     * places its own sound from where the picture is when it starts (as
     * scheduleAudio does when it is handed `follow`).
     */
    const slow = (places: boolean) => {
      type Slow = Graph & { asked: number; follow?: (ctxS: number) => number }
      const made: Slow[] = []
      const schedule = (fromS: number, follow?: (ctxS: number) => number) =>
        new Promise<StopAudio>((resolve) => {
          const g: Slow = { stopped: false, handedOverAt: null, mixes: 0, land: () => undefined, fail: () => undefined, asked: fromS, follow }
          g.land = () => {
            const startsAtCtxS = world.t + 0.02
            const placed = places && follow ? { fromS: follow(startsAtCtxS) } : {}
            resolve(
              Object.assign(
                () => {
                  g.stopped = true
                },
                {
                  startsAtCtxS,
                  ...placed,
                  stopAt: (at: number) => {
                    g.handedOverAt = at
                  },
                },
              ),
            )
          }
          made.push(g)
        })
      return { made, schedule }
    }
    /** Where the picture is at context time `c` for a play from 0 heard at 5.02, untouched. */
    const steady = (c: number) => c - 5.02

    for (const places of [true, false]) {
      it(`a build that lands 1.5 s late moves nothing back${places ? '' : ', even from a scheduler that cannot place its sound'}`, async () => {
        const { made, schedule } = slow(places)
        const spans: (number | boolean | null)[][] = []
        const t = new Transport({
          getEndS: () => 60,
          onTick: () => undefined,
          schedule,
          onHeard: (span, end) => spans.push(span ? [span.timelineS, span.heardAtMs, !!span.continues] : [null, end!]),
        })
        const playing = t.play(0)
        made[0]!.land()
        await playing
        world.t = 10.02
        expect(t.currentTime()).toBeCloseTo(steady(10.02), 9)
        // He turns noise reduction on: the rebuild waits 1.5 s on the noise pass.
        t.rescheduleAudio({ seamless: true })
        world.t = 11.52
        made[1]!.land()
        await tick()
        // The picture never went back: it is exactly where it was heading.
        expect(t.currentTime()).toBeCloseTo(steady(11.52), 9)
        world.t = 11.54
        expect(t.currentTime()).toBeCloseTo(steady(11.54), 9)
        if (!places) {
          // A sound that would start 1.5 s behind the picture is not played: it
          // goes, and the old sound plays on while one is built from here.
          expect(made[1]!.stopped).toBe(true)
          expect(made[0]!.stopped || made[0]!.handedOverAt !== null).toBe(false)
          expect(made).toHaveLength(3)
          expect(made[2]!.asked).toBeGreaterThan(steady(11.52))
          expect(made[2]!.asked - steady(11.52)).toBeLessThan(0.1)
          // Warm now, so built in the 10 ms it was expected to take.
          world.t = 11.53
          made[2]!.land()
          await tick()
        }
        // What he hears from the new sound is what the picture shows as it starts.
        const live = made[made.length - 1]!
        expect(live.stopped).toBe(false)
        expect(made[0]!.handedOverAt).not.toBeNull()
        const [timelineS, heardAtMs, continues] = spans[spans.length - 1] as [number, number, boolean]
        expect(continues).toBe(true)
        const startsAt = (heardAtMs - 1040) / 1000
        expect(timelineS).toBeCloseTo(steady(startsAt), 6)
        world.t = startsAt + 2
        expect(t.currentTime()).toBeCloseTo(steady(startsAt + 2), 6)

        // ⛔ And the slow build is not learned: the next quick rebuild asks for
        // the sound from about where the playhead will be, not 0.75 s past it.
        world.t = 14.02
        t.rescheduleAudio({ seamless: true })
        const next = made[made.length - 1]!
        expect(next.asked - steady(14.02)).toBeLessThan(0.05)
        world.t = 14.03
        next.land()
        await tick()
        world.t = 14.05
        expect(t.currentTime()).toBeCloseTo(steady(14.05), 9)
        t.pause()
      })
    }

    it('the transport tells the scheduler where the picture is at any context time', async () => {
      const { made, schedule } = slow(true)
      const t = new Transport({ getEndS: () => 60, onTick: () => undefined, schedule })
      const playing = t.play(0)
      made[0]!.land()
      await playing
      world.t = 8
      t.rescheduleAudio({ seamless: true })
      expect(made[1]!.follow).toBeTypeOf('function')
      expect(made[1]!.follow!(9.5)).toBeCloseTo(steady(9.5), 9)
      t.pause()
    })
  })

  it('a mix change moves the live graph, and only a live graph', async () => {
    const { made, schedule } = graphs()
    const t = new Transport({ getEndS: () => 60, onTick: () => undefined, schedule })
    expect(t.setMix([])).toBe(false) // not playing
    const playing = t.play(0)
    made[0]!.land()
    await playing
    expect(t.setMix([])).toBe(true)
    expect(made[0]!.mixes).toBe(1)
    // A build in the air reads the store when it starts: it has to be built again.
    t.rescheduleAudio({ seamless: true })
    expect(t.setMix([])).toBe(false)
    made[1]!.land()
    await tick()
    expect(t.setMix([])).toBe(true)
    expect(made[1]!.mixes).toBe(1)
    t.pause()
    expect(t.setMix([])).toBe(false)
  })
})

// PB-17, 2026-10-06: play that ran out put the playhead ON the end, where
// nothing resolves, so the monitor went black after every play to the end.
describe('running off the end of the edit', () => {
  it('tells the playhead once, through onPaused, and never puts it on the end itself', async () => {
    let now = 1000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const raf = { cb: null as FrameRequestCallback | null }
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      raf.cb = cb
      return 1
    }) as typeof requestAnimationFrame
    const ticks: number[] = []
    const paused: number[] = []
    const t = new Transport({
      getEndS: () => 2,
      onTick: (s) => ticks.push(s),
      onPaused: (s) => paused.push(s),
      schedule: async () => () => undefined,
    })
    await t.play(1.5)
    now += 300
    raf.cb?.(now)
    now += 300 // past the end
    raf.cb?.(now)
    expect(t.playing).toBe(false)
    expect(paused).toEqual([2])
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.every((s) => s < 2)).toBe(true)
    spy.mockRestore()
  })
})

// 2026-10-07: the monitor's draw ran before the transport's tick in every
// animation frame, so it drew the clock of the frame before. tickFrame lets a
// draw tick the clock first; the clock still ticks once a frame, never twice.
describe('a draw can tick the clock first in its frame', () => {
  it('ticks once for that frame, and the transport only books the next one', async () => {
    let now = 1000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const raf = { cb: null as FrameRequestCallback | null }
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      raf.cb = cb
      return 1
    }) as typeof requestAnimationFrame
    const ticks: number[] = []
    const t = new Transport({ getEndS: () => 10, onTick: (s) => ticks.push(s), schedule: async () => () => undefined })
    await t.play(1)
    now += 100
    t.tickFrame(now) // the monitor, first in the frame
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toBeCloseTo(1.1, 9)
    t.tickFrame(now) // asked again in the same frame: nothing new
    const own = raf.cb
    own?.(now) // the transport's own callback, later in the same frame
    expect(ticks).toHaveLength(1)
    expect(raf.cb).not.toBeNull()
    // A frame with no draw in it: the transport ticks on its own, as before.
    now += 100
    raf.cb?.(now)
    expect(ticks).toHaveLength(2)
    expect(ticks[1]).toBeCloseTo(1.2, 9)
    t.pause() // which tells the playhead once more, where it stopped
    const told = ticks.length
    t.tickFrame(now + 100) // paused: a draw ticks nothing
    expect(ticks).toHaveLength(told)
    spy.mockRestore()
  })
})

// PB-8, 2026-10-07: the picture ran on the sample the audio graph was
// RENDERING, and his ears get it the output latency later: measured on his
// default output that day, 41 ms by the output timestamps (40 ms output plus
// 10 ms base reported), two and a half frames of a 60 fps edit, and five to
// fifteen frames on Bluetooth. Every cut he saw landed before the beat he heard.
describe('the picture shows what is reaching his ears', () => {
  const world = { t: 5 }
  /** A device whose sound reaches his ears 0.2 s after the graph renders it. */
  const ctx = {
    state: 'running',
    get currentTime() {
      return world.t
    },
    resume: () => Promise.resolve(),
    getOutputTimestamp: () => ({ contextTime: world.t - 0.2, performanceTime: 1000 * world.t }),
  }
  let frames: FrameRequestCallback[] = []
  const runFrame = () => frames.splice(0).forEach((f) => f(world.t))
  beforeEach(() => {
    world.t = 5
    frames = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame
    vi.spyOn(performance, 'now').mockImplementation(() => 1000 * world.t)
    audioMock.ctx = ctx
  })
  afterEach(() => {
    vi.restoreAllMocks()
    audioMock.ctx = null
  })

  const transport = (ticks: number[], extra: Partial<ConstructorParameters<typeof Transport>[0]> = {}) =>
    new Transport({
      getEndS: () => 60,
      onTick: (s) => ticks.push(s),
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 })),
      ...extra,
    })

  it('holds the first frame until the first sound reaches him, then runs on what he hears', async () => {
    const ticks: number[] = []
    const t = transport(ticks)
    await t.play(2)
    world.t = 5.12 // the sound has started, and has not reached him yet
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2, 9)
    world.t = 5.22 // it reaches him
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2, 9)
    world.t = 5.72
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2.5, 9)
    // A pause still stops where the SOUND stopped: what he has heard by the
    // time the device plays out, which a dub resumes from (MIC-5).
    expect(t.pause()).toBeCloseTo(2.7, 9)
  })

  it('shows the last frames of the edit before it stops, while their sound plays out', async () => {
    const ticks: number[] = []
    const paused: number[] = []
    const t = transport(ticks, { getEndS: () => 3, onPaused: (s) => paused.push(s) })
    await t.play(2)
    world.t = 6.1 // the sound has rendered past the end; he is hearing 2.88
    runFrame()
    expect(t.playing).toBe(true)
    expect(ticks.at(-1)).toBeCloseTo(2.88, 9)
    world.t = 6.3
    runFrame()
    expect(t.playing).toBe(false)
    expect(paused).toEqual([3])
  })

  // The sound reaches the end of the edit before the picture does. A pause in
  // that stretch is a pause, and the playhead is told so (sweep review S2): only
  // play that runs out says it ran out.
  it('tells onPaused when play ran off the end, and not when he paused in the last stretch', async () => {
    const told: Array<[number, boolean]> = []
    const t = transport([], { getEndS: () => 3, onPaused: (s, ranOut) => told.push([s, ranOut]) })
    await t.play(2)
    world.t = 6.1 // the sound has rendered past the end; he is hearing 2.88
    runFrame()
    expect(t.playing).toBe(true)
    t.pause()
    expect(told).toEqual([[3, false]])

    told.length = 0
    await t.play(2)
    world.t = 12.1
    runFrame() // the picture has reached the end too
    expect(t.playing).toBe(false)
    expect(told).toEqual([[3, true]])
  })

  it('a loop pass is seen to its end, and the next starts when its sound reaches him', async () => {
    const ticks: number[] = []
    const t = transport(ticks, {
      getLoopRange: () => ({ startS: 0, endS: 1 }),
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.07 })),
    })
    await t.play(0) // the first sound starts at 5.07
    world.t = 6.1 // the sound wraps here; he is still hearing 0.83 of the pass
    runFrame()
    await Promise.resolve()
    await Promise.resolve()
    expect(ticks.at(-1)).toBeCloseTo(0.83, 9)
    world.t = 6.29
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(1, 9) // the pass's last frame, never cut short
    world.t = 6.32 // the old pass has played out; the new one has not reached him
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(0, 9)
    world.t = 6.1 + 0.07 + 0.2 + 0.5
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(0.5, 9)
    t.pause()
  })

  // N2 (sweep review): the pass's tail is the pass's own picture, clock less lag
  // from the pass's anchor. For a loop shorter than the lag the clock reaches the
  // wrap before the first sound has reached him, and that sum is NEGATIVE: the
  // picture fell below the in point, to a frame outside his loop.
  describe.each([0.041, 0.3])('a loop shorter than the lag (%s s) never leaves its range', (lag) => {
    it.each([0.05, 0.1, 0.2, 0.5])('loop of %s s', async (len) => {
      audioMock.ctx = {
        state: 'running',
        get currentTime() {
          return world.t
        },
        resume: () => Promise.resolve(),
        getOutputTimestamp: () => ({ contextTime: world.t - lag, performanceTime: 1000 * world.t }),
      }
      const IN = 2
      const ticks: number[] = []
      const t = transport(ticks, { getLoopRange: () => ({ startS: IN, endS: IN + len }) })
      await t.play(IN)
      for (let i = 0; i < 300; i++) {
        world.t += 0.01
        runFrame()
        await Promise.resolve()
        await Promise.resolve()
      }
      t.pause()
      expect(ticks.length).toBeGreaterThan(50)
      expect(Math.min(...ticks)).toBeGreaterThanOrEqual(IN - 1e-9)
      expect(Math.max(...ticks)).toBeLessThanOrEqual(IN + len + 1e-9)
    })
  })

  it('a sound that joins a picture rolling alone starts where the picture will be when he hears it', async () => {
    // The device has not opened at Space: the picture rolls on the performance
    // clock with nothing to wait for, and takes the lag on when the sound joins.
    const w = { ctxT: 0, perfS: 100 }
    audioMock.ctx = {
      state: 'running',
      get currentTime() {
        return w.ctxT
      },
      resume: () => Promise.resolve(),
      getOutputTimestamp: () => ({ contextTime: w.ctxT - 0.2, performanceTime: 1000 * w.perfS }),
    }
    vi.spyOn(performance, 'now').mockImplementation(() => 1000 * w.perfS)
    const ticks: number[] = []
    const joined: number[] = []
    const t = transport(ticks, {
      schedule: () => Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: w.ctxT + 0.02 })),
      onHeard: (span) => {
        if (span?.continues) joined.push(span.timelineS)
      },
    })
    await t.play(4)
    w.perfS = 100.3
    w.ctxT = 3 // the device opened: the sound is rebuilt on its clock
    runFrame()
    await Promise.resolve()
    await Promise.resolve()
    expect(joined).toHaveLength(1)
    for (const c of [3.0, 3.1, 3.22]) {
      w.ctxT = c
      runFrame()
    }
    // When its first sample reaches him (3.02 + 0.2), the picture shows it.
    expect(ticks.at(-1)).toBeCloseTo(joined[0], 9)
    w.ctxT = 3.5
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(joined[0] + 0.28, 9)
    expect(ticks.every((s, i) => i === 0 || s >= ticks[i - 1])).toBe(true) // never a step back
    t.pause()
  })

  it('a late first sound never holds back a cold Space, and the picture takes the lag on when it joins', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let firstBuild: (stop: () => void) => void = () => undefined
    let calls = 0
    const ticks: number[] = []
    const joined: number[] = []
    const t = transport(ticks, {
      schedule: () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => (firstBuild = (stop) => resolve(stop)))
        return Promise.resolve(Object.assign(() => undefined, { startsAtCtxS: world.t + 0.02 }))
      },
      onHeard: (span) => {
        if (span?.continues) joined.push(span.timelineS)
      },
    })
    const playing = t.play(10)
    await vi.advanceTimersByTimeAsync(AUDIO_START_BUDGET_MS + 1)
    await playing
    world.t = 5.1
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(10.1, 9) // the picture rolls at once: nothing to wait for
    world.t = 5.2
    firstBuild(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(joined).toHaveLength(1)
    for (const c of [5.25, 5.3, 5.42]) {
      world.t = c
      runFrame()
    }
    // When the joined sound's first sample reaches him (5.22 + 0.2), the picture shows it.
    expect(ticks.at(-1)).toBeCloseTo(joined[0], 9)
    expect(ticks.every((s, i) => i === 0 || s >= ticks[i - 1])).toBe(true) // never a step back
    t.pause()
    vi.useRealTimers()
  })

  // Merge check (audio x playback): a scheduler that places its own sound from
  // where the picture is when it starts (`follow`, SF-1) must be told where the
  // picture will be when the sound REACHES him, or a sound joining a picture that
  // rolled alone starts a whole output lag early and the picture steps back by it
  // when the lag is taken on.
  it('a late first sound placed by its scheduler still starts where the picture will be when he hears it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let firstBuild: (stop: () => void) => void = () => undefined
    let calls = 0
    const asked: { fromS: number; follow: boolean }[] = []
    const ticks: number[] = []
    const joined: number[] = []
    const t = transport(ticks, {
      schedule: (fromS, follow) => {
        calls += 1
        asked.push({ fromS, follow: follow !== undefined })
        if (calls === 1) return new Promise((resolve) => (firstBuild = (stop) => resolve(stop)))
        const startsAtCtxS = world.t + 0.02
        return Promise.resolve(Object.assign(() => undefined, { startsAtCtxS, ...(follow ? { fromS: follow(startsAtCtxS) } : {}) }))
      },
      onHeard: (span) => {
        if (span?.continues) joined.push(span.timelineS)
      },
    })
    const playing = t.play(10)
    await vi.advanceTimersByTimeAsync(AUDIO_START_BUDGET_MS + 1)
    await playing
    world.t = 5.1
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(10.1, 9)
    world.t = 5.2
    firstBuild(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(asked[1]!.follow).toBe(true)
    expect(joined).toHaveLength(1)
    // The sound starts at 5.22 and reaches him 0.2 s later, when the rolling picture
    // is at 10 + (5.42 - 5) = 10.42: that is where it is placed, not 10.22.
    expect(joined[0]).toBeCloseTo(10.42, 9)
    for (const c of [5.25, 5.3, 5.42]) {
      world.t = c
      runFrame()
    }
    expect(ticks.at(-1)).toBeCloseTo(joined[0]!, 9)
    expect(ticks.every((s, i) => i === 0 || s >= ticks[i - 1]!)).toBe(true) // never a step back
    t.pause()
    vi.useRealTimers()
  })

  // L or J pressed during normal play re-anchors from currentTime(). The sound
  // still on its way is the lag ahead of the frame on screen, and starting the
  // shuttle there jumped the picture that far forward first: 12 frames of a
  // 60 fps edit on Bluetooth, and with J a flick forward before it ran back.
  it('a shuttle from normal play goes on from the frame on screen, not the sound on its way', async () => {
    const ticks: number[] = []
    const t = transport(ticks)
    await t.play(2) // heard from 5.22
    world.t = 5.72
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2.5, 9)
    expect(t.currentTime()).toBeCloseTo(2.5, 9)
    await t.play(t.currentTime(), 2) // L again
    world.t = 5.82
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2.7, 9)
    t.pause()
  })

  it('J from normal play runs back from the frame on screen', async () => {
    const ticks: number[] = []
    const t = transport(ticks)
    await t.play(2)
    world.t = 5.72
    runFrame()
    await t.play(t.currentTime(), -1)
    world.t = 5.82
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(2.4, 9) // never forward of 2.5 first
    t.pause()
  })

  // N1 of the sweep review. The lag is re-measured every second from the output
  // timestamps, which scatter by about 10 ms between readings (they move in steps
  // of the device's buffer). A 4 ms gate on the raw reading moved the picture by
  // up to 10 ms about once a second, and a move across a frame boundary doubled a
  // frame (the never-backward hold) or dropped one. The measurement is smoothed;
  // the sync itself is unchanged.
  describe('a jittery latency reading', () => {
    /** A device whose lag is 0.2 s on average and scatters by +-10 ms from one reading to the next. */
    function jitteryDevice(): void {
      let seed = 12345
      const scatter = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return (seed / 2 ** 32 - 0.5) * 0.02
      }
      audioMock.ctx = {
        state: 'running',
        get currentTime() {
          return world.t
        },
        resume: () => Promise.resolve(),
        getOutputTimestamp: () => ({ contextTime: world.t - 0.2 + scatter(), performanceTime: 1000 * world.t }),
      }
    }

    /** Play 40 s at 60 Hz; the whole frames the picture shows, one per display frame. */
    async function shownFrames(ticks: number[]): Promise<number[]> {
      world.t = 5.004
      const t = transport(ticks)
      await t.play(2)
      const shown: number[] = []
      for (let i = 0; i < 60 * 40; i++) {
        world.t += 1 / 60
        runFrame()
        shown.push(Math.floor(ticks.at(-1)! * 60 + 1e-6))
      }
      t.pause()
      return shown
    }

    it('never doubles or drops a frame of the picture once it has settled', async () => {
      jitteryDevice()
      const shown = await shownFrames([])
      // Past the hold at the start, and the first seconds the estimate takes to settle.
      const settled = shown.slice(60 * 5)
      const bad = settled.map((f, i) => (i === 0 ? 1 : f - settled[i - 1])).filter((step) => step !== 1)
      // Raw, it was 19 in these 35 s (about one a second). A drift of the smoothed
      // lag across the gate can still move one now and then, but not each second.
      expect(bad.length).toBeLessThanOrEqual(1)
    })

    it('still follows a different output device within a second or two', async () => {
      const lag = { s: 0.04 }
      audioMock.ctx = {
        state: 'running',
        get currentTime() {
          return world.t
        },
        resume: () => Promise.resolve(),
        getOutputTimestamp: () => ({ contextTime: world.t - lag.s, performanceTime: 1000 * world.t }),
      }
      world.t = 5.004
      const ticks: number[] = []
      const t = transport(ticks)
      await t.play(2)
      for (let i = 0; i < 60 * 3; i++) {
        world.t += 1 / 60
        runFrame()
      }
      // The sound renders at world.t; the picture is what reached him 0.04 s ago.
      expect(ticks.at(-1)).toBeCloseTo(2 + (world.t - 5.024 - 0.04), 6)
      lag.s = 0.25 // he plugs in Bluetooth
      for (let i = 0; i < 60 * 2; i++) {
        world.t += 1 / 60
        runFrame()
      }
      expect(Math.max(...ticks.slice(-1))).toBeCloseTo(2 + (world.t - 5.024 - 0.25), 2)
      t.pause()
    })
  })

  it('a shuttle has no sound, so its picture is not held back', async () => {
    const ticks: number[] = []
    const t = transport(ticks)
    await t.play(2, 2)
    world.t = 5.5
    runFrame()
    expect(ticks.at(-1)).toBeCloseTo(3, 9)
    t.pause()
  })
})
