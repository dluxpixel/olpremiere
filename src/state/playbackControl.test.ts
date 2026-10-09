import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Space, as he presses it: togglePlay against the real Transport and the real
// store. There is no AudioContext in node, so the transport plays on the
// performance clock, which this file moves by hand, one animation frame at a time.
// A test about what he HEARS hands it a device (audio.ctx, see deviceWithLatency).
const audio = vi.hoisted(() => ({ ctx: null as null | { currentTime: number } }))
vi.mock('../engine/audio', () => ({
  ensureAudioContext: () => {
    if (!audio.ctx) throw new Error('no audio context in node')
    return audio.ctx
  },
  SCHEDULE_LATENCY_S: 0.05,
  scheduleAudio: () =>
    Promise.resolve(
      Object.assign(() => undefined, audio.ctx ? { startsAtCtxS: audio.ctx.currentTime + 0.05 } : {}),
    ),
  clipEmitsAudioOn: () => false,
}))
// The frame the monitor last drew while playing (preview.ts lastPlayedFrameS).
// No monitor runs here, so a test that needs one says what it drew.
const monitor = vi.hoisted(() => ({ drewS: null as number | null }))
vi.mock('../engine/preview', () => ({
  pauseAllPreviewVideos: () => {},
  setPreviewTransportRate: () => {},
  lastPlayedFrameS: () => monitor.drewS,
  forgetPlayedFrame: () => {
    monitor.drewS = null
  },
}))
// A voiceover take being recorded against the preview (voiceRecorder).
const take = vi.hoisted(() => ({ on: false }))
vi.mock('./voiceRecorder', () => ({
  isTakeInProgress: () => take.on,
  pauseRecording: () => {},
  resumeRecording: () => {},
  takeHeard: () => {},
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { isPlaying, shuttle, togglePlay } = await import('./playbackControl')
const { updateActiveSequence, useStore } = await import('./store')
const { activeSequence } = await import('../engine/types')

let nowMs = 1000
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

/** Let the clock run `ms`, then draw one frame. */
function frameAfter(ms: number): void {
  nowMs += ms
  const due = [...frames.values()]
  frames.clear()
  for (const cb of due) cb(nowMs)
}

/** play() awaits its sound (or the start budget) before the picture rolls. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const playhead = (): number => useStore.getState().ui.playheadS

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb)
    return nextFrame++
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames.delete(id)
  }) as typeof cancelAnimationFrame
  updateActiveSequence('A 2 second edit', (seq) => ({ ...seq, durationS: 2 }))
  useStore.getState().setUI({ playheadS: 0 })
})

afterEach(() => {
  if (isPlaying()) togglePlay()
  monitor.drewS = null
  audio.ctx = null
  take.on = false
  vi.restoreAllMocks()
})

// The pair e2e/mvp.spec.ts "Space plays, Space pauses" stands on, 2026-10-04.
// That test flaked because its second press landed after the clip had ended,
// where Space is a play and not a pause. Both halves are right, and pinned here.
describe('Space', () => {
  it('mid-play pauses, and the playhead stays where it stopped', async () => {
    togglePlay()
    await settle()
    frameAfter(800)
    expect(playhead()).toBeCloseTo(0.8, 6)

    togglePlay()
    expect(isPlaying()).toBe(false)
    const paused = playhead()
    frameAfter(400)
    expect(playhead()).toBe(paused)
  })

  it('after the edit has run out, plays again from the top', async () => {
    togglePlay()
    await settle()
    frameAfter(2100)
    // The transport stopped itself at the end, and parked on the last frame,
    // not on the end itself where the monitor is black (PB-17).
    expect(isPlaying()).toBe(false)
    expect(playhead()).toBeCloseTo(2 - 1 / activeSequence(useStore.getState().project).fps, 9)

    // So the next Space is a play from 0, not a pause.
    togglePlay()
    await settle()
    expect(isPlaying()).toBe(true)
    frameAfter(300)
    expect(playhead()).toBeCloseTo(0.3, 6)
  })
})

// The timeline audit, 2026-10-06: a pause left the playhead between two frames,
// so the paused picture (nearest frame) could step one on from the last frame
// he saw playing (the frame the playhead is in).
describe('a pause lands on the frame that was on screen', () => {
  beforeEach(() => {
    updateActiveSequence('A 10 second edit at 30', (seq) => ({ ...seq, durationS: 10, fps: 30 }))
  })

  it('puts the playhead on a whole frame, the one the last tick drew', async () => {
    togglePlay()
    await settle()
    frameAfter(3456.7)
    nowMs += 20 // the pause comes a moment after the last drawn frame
    togglePlay()
    const frames = playhead() * 30
    expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6)
    expect(Math.round(frames)).toBe(103) // floor(3.4567 * 30)
  })

  // A dub resumed from the frame would replay a stretch he already heard (MIC-5),
  // so while a take is recording the resume is the exact stop.
  it('and a take in progress resumes from where it REALLY stopped while the playhead is not moved', async () => {
    take.on = true
    togglePlay()
    await settle()
    frameAfter(3456.7)
    nowMs += 20
    togglePlay()
    togglePlay()
    await settle()
    frameAfter(100)
    expect(playhead()).toBeCloseTo(3.4767 + 0.1, 6)
  })

  it('and without a take it resumes on the frame that was on screen', async () => {
    togglePlay()
    await settle()
    frameAfter(3456.7)
    nowMs += 20
    togglePlay()
    togglePlay()
    await settle()
    frameAfter(100)
    expect(playhead()).toBeCloseTo(103 / 30 + 0.1, 6)
  })

  it('a playhead moved after the pause plays from where it was put', async () => {
    togglePlay()
    await settle()
    frameAfter(3456.7)
    togglePlay()
    useStore.getState().setUI({ playheadS: 5 })
    togglePlay()
    await settle()
    frameAfter(100)
    expect(playhead()).toBeCloseTo(5.1, 6)
  })
})

// The monitor's animation frame loop ran BEFORE the transport's in every
// frame, so what it drew was the playhead of the tick before the last one. It
// ticks the clock first now (programCanvas.test.tsx), and a tick it does not
// draw (its redraw cap, a frame still decoding) still leaves the store ahead.
describe('a pause lands on the frame the monitor drew, not on the last tick', () => {
  beforeEach(() => {
    updateActiveSequence('A 10 second edit at 60', (seq) => ({ ...seq, durationS: 10, fps: 60 }))
  })

  it('stops on what he saw when the last tick had already moved to the next frame', async () => {
    togglePlay()
    await settle()
    frameAfter(1000)
    // The next frame: the monitor draws the playhead it finds (frame 60), then
    // the transport ticks on to frame 61, which nobody has seen yet.
    monitor.drewS = Math.floor(playhead() * 60 + 1e-6) / 60
    frameAfter(1000 / 60)
    expect(Math.floor(playhead() * 60 + 1e-6)).toBe(61)
    togglePlay()
    expect(playhead()).toBe(1)
  })

  it('and a take in progress resumes from where the sound really stopped', async () => {
    take.on = true
    togglePlay()
    await settle()
    frameAfter(1000)
    monitor.drewS = 1
    frameAfter(1000 / 60)
    togglePlay()
    togglePlay()
    await settle()
    frameAfter(100)
    expect(playhead()).toBeCloseTo(1 + 1 / 60 + 0.1, 6)
  })

  it('and without a take it resumes from the frame he saw, not the sound', async () => {
    togglePlay()
    await settle()
    frameAfter(1000)
    monitor.drewS = 1
    frameAfter(1000 / 60)
    togglePlay()
    togglePlay()
    await settle()
    frameAfter(100)
    expect(playhead()).toBeCloseTo(1 + 0.1, 6)
  })

  it('never uses a frame drawn by an earlier run of play', async () => {
    monitor.drewS = 5
    togglePlay()
    await settle()
    frameAfter(500)
    togglePlay()
    expect(playhead()).toBe(0.5)
  })
})

// PB-17: play to the end and the monitor went black, parked on the end itself.
describe('play that runs out parks on the last frame', () => {
  beforeEach(() => {
    updateActiveSequence('A 10 second edit at 30', (seq) => ({ ...seq, durationS: 10, fps: 30 }))
  })

  it('lands on the last real frame, whatever the monitor last drew', async () => {
    useStore.getState().setUI({ playheadS: 9 })
    togglePlay()
    await settle()
    frameAfter(900)
    monitor.drewS = 9.9
    frameAfter(200)
    expect(isPlaying()).toBe(false)
    expect(playhead()).toBeCloseTo(299 / 30, 9)
  })

  it('and Space from there starts over from the top', async () => {
    useStore.getState().setUI({ playheadS: 9.5 })
    togglePlay()
    await settle()
    frameAfter(700)
    togglePlay()
    await settle()
    frameAfter(300)
    expect(playhead()).toBeCloseTo(0.3, 6)
  })

  it('so does Space on the last frame End puts him on', async () => {
    useStore.getState().setUI({ playheadS: 299 / 30 })
    togglePlay()
    await settle()
    frameAfter(300)
    expect(isPlaying()).toBe(true)
    expect(playhead()).toBeCloseTo(0.3, 6)
  })
})

describe('J that runs back to the start parks on the start', () => {
  beforeEach(() => {
    updateActiveSequence('A 10 second edit at 30', (seq) => ({ ...seq, durationS: 10, fps: 30 }))
  })

  it('and a playhead stepped on from there plays from where it was put', async () => {
    useStore.getState().setUI({ playheadS: 0.5 })
    shuttle(-1)
    await settle()
    monitor.drewS = 1 / 30
    frameAfter(600)
    expect(isPlaying()).toBe(false)
    expect(playhead()).toBe(0)
    // One frame on (the arrow key), then Space.
    useStore.getState().setUI({ playheadS: 1 / 30 })
    togglePlay()
    await settle()
    frameAfter(300)
    expect(playhead()).toBeCloseTo(1 / 30 + 0.3, 6)
  })
})

// ⛔ EVERY RESUME AFTER A PAUSE SKIPPED THE PICTURE FORWARD (sweep review B1).
// Pausing keeps the SOUND clock, and the frame on screen is that time less the
// output latency (PB-8), so Space and J/L from a pause started from a time the
// picture had never shown: 2 to 3 frames at 60 fps on his default output (41 ms),
// 12 to 21 on Bluetooth, and Space-Space crept forward by that every tap. The
// tests before this ran without a device, where the sound and the picture are the
// same time, which is why none of them could see it.
/** A device whose sound reaches his ears `lagS` after the graph renders it, on the test's own clock. */
function deviceWithLatency(lagS: number): { currentTime: number } {
  return {
    state: 'running',
    get currentTime() {
      return nowMs / 1000
    },
    resume: () => Promise.resolve(),
    getOutputTimestamp: () => ({ contextTime: nowMs / 1000 - lagS, performanceTime: nowMs }),
  } as unknown as { currentTime: number }
}

describe.each([
  ['his wired output, 41 ms', 0.041],
  ['Bluetooth, 0.3 s', 0.3],
])('resuming after a pause on %s', (_name, lagS) => {
  const FPS = 60
  beforeEach(() => {
    updateActiveSequence('A 10 second edit at 60', (seq) => ({ ...seq, durationS: 10, fps: FPS }))
    audio.ctx = deviceWithLatency(lagS)
  })

  /** One animation frame `ms` on, and the monitor draws the frame the playhead is in. */
  function run(ms: number): void {
    frameAfter(ms)
    monitor.drewS = Math.floor(playhead() * FPS + 1e-6) / FPS
  }

  /** Play from 0, let a second go by, and pause: the sound is `lagS` ahead of the frame he is on. */
  async function playAndPause(): Promise<number> {
    togglePlay()
    await settle()
    run(1000)
    togglePlay()
    expect(isPlaying()).toBe(false)
    return playhead()
  }

  it('the sound is really ahead of the picture when it pauses (the premise)', async () => {
    const parked = await playAndPause()
    // The sound had rendered 0.95 s of the edit; the picture shows that less the lag.
    expect(parked).toBeLessThanOrEqual(0.95 - lagS + 1e-9)
    expect(parked).toBeGreaterThan(0.95 - lagS - 1 / FPS - 1e-9)
  })

  it('Space starts on the frame that was on screen, so the picture does not skip', async () => {
    const parked = await playAndPause()
    togglePlay()
    await settle()
    run(10)
    expect(playhead()).toBeCloseTo(parked, 9)
    // And runs on from it at the speed of the sound, once the sound has reached him.
    run(0.05 * 1000 + lagS * 1000 + 500 - 10)
    expect(playhead()).toBeCloseTo(parked + 0.5, 6)
  })

  it('Space, Space, Space in quick taps never creeps the picture on', async () => {
    const parked = await playAndPause()
    for (let i = 0; i < 6; i++) {
      togglePlay()
      await settle()
      run(20)
      togglePlay()
      expect(playhead()).toBeCloseTo(parked, 9)
    }
  })

  it('L from a pause goes on from the frame on screen', async () => {
    const parked = await playAndPause()
    shuttle(1)
    await settle()
    run(10)
    expect(playhead()).toBeCloseTo(parked, 9)
  })

  it('J from a pause runs back from the frame on screen, not from the sound ahead of it', async () => {
    const parked = await playAndPause()
    shuttle(-1)
    await settle()
    run(100)
    // A shuttle is silent, so its picture has no lag to wait out.
    expect(playhead()).toBeCloseTo(parked - 0.1, 6)
  })

  it('a take in progress still resumes from where the SOUND stopped, so no heard stretch is replayed', async () => {
    take.on = true
    await playAndPause()
    togglePlay()
    await settle()
    run(10)
    expect(playhead()).toBeCloseTo(0.95, 9)
  })

  it('a playhead moved after the pause plays from where it was put', async () => {
    await playAndPause()
    useStore.getState().setUI({ playheadS: 5 })
    togglePlay()
    await settle()
    run(10)
    expect(playhead()).toBeCloseTo(5, 9)
  })

  // S2 of the same review. The sound reaches the end of the edit `lagS` before the
  // picture does, and a pause in that last stretch read the sound's end as play
  // that ran off it: the playhead jumped to the last frame and the next Space
  // started over from 0, though he had paused with the end still to come.
  describe('a pause in the last stretch of the edit', () => {
    beforeEach(() => {
      updateActiveSequence('A 2 second edit at 60', (seq) => ({ ...seq, durationS: 2, fps: FPS }))
      useStore.getState().setUI({ playheadS: 1.5 })
    })

    /** Play from 1.5 until the sound has rendered the end and the picture is `lagS` / 2 short of it. */
    async function playToTheLastStretch(): Promise<number> {
      togglePlay()
      await settle()
      run(50 + 500 + lagS * 500)
      expect(isPlaying()).toBe(true) // the picture has not run out
      return monitor.drewS as number
    }

    it('parks on the frame on screen, not on the last frame', async () => {
      const shown = await playToTheLastStretch()
      expect(shown).toBeLessThan(2 - 1 / FPS - 1e-6)
      togglePlay()
      expect(playhead()).toBeCloseTo(shown, 9)
    })

    it('and the next Space resumes from it, not from the top', async () => {
      const shown = await playToTheLastStretch()
      togglePlay()
      togglePlay()
      await settle()
      run(10)
      expect(isPlaying()).toBe(true)
      expect(playhead()).toBeCloseTo(shown, 9)
    })

    it('play that really runs out still parks on the last frame, and Space starts over', async () => {
      togglePlay()
      await settle()
      run(50 + 500 + lagS * 1000 + 100)
      expect(isPlaying()).toBe(false)
      expect(playhead()).toBeCloseTo(2 - 1 / FPS, 9)
      togglePlay()
      await settle()
      run(300)
      expect(isPlaying()).toBe(true)
      expect(playhead()).toBeLessThan(1)
    })
  })
})
