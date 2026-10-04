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
vi.mock('../engine/preview', () => ({ pauseAllPreviewVideos: () => {}, setPreviewTransportRate: () => {} }))
vi.mock('./voiceRecorder', () => ({
  isTakeInProgress: () => false,
  pauseRecording: () => {},
  resumeRecording: () => {},
  takeHeard: () => {},
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { isPlaying, togglePlay } = await import('./playbackControl')
const { updateActiveSequence, useStore } = await import('./store')

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
    // The transport stopped itself at the end.
    expect(isPlaying()).toBe(false)
    expect(playhead()).toBe(2)

    // So the next Space is a play from 0, not a pause.
    togglePlay()
    await settle()
    expect(isPlaying()).toBe(true)
    frameAfter(300)
    expect(playhead()).toBeCloseTo(0.3, 6)
  })
})
