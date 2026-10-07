import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Space, as he presses it: togglePlay against the real Transport and the real
// store. There is no AudioContext in node, so the transport plays on the
// performance clock, which this file moves by hand, one animation frame at a time.
vi.mock('../engine/audio', () => ({
  ensureAudioContext: () => {
    throw new Error('no audio context in node')
  },
  SCHEDULE_LATENCY_S: 0.05,
  scheduleAudio: () => Promise.resolve(() => undefined),
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
vi.mock('./voiceRecorder', () => ({
  isTakeInProgress: () => false,
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

  it('and resumes from where it REALLY stopped while the playhead is not moved', async () => {
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

  it('and resumes from where the sound really stopped', async () => {
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
