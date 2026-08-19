import { beforeEach, describe, expect, it, vi } from 'vitest'

// The transport reaches for a real AudioContext to pick its clock. There isn't
// one in node, and it already falls back to the performance clock when the call
// throws, so the stub just makes that path deliberate rather than accidental.
vi.mock('./audio', () => ({
  ensureAudioContext: () => {
    throw new Error('no audio context in node')
  },
  SCHEDULE_LATENCY_S: 0.02,
}))

const { Transport } = await import('./playback')

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
