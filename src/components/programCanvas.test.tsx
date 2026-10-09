/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The monitor's draw loop against the real transport and the real store, one
// animation frame at a time, the way the browser runs them: every callback of a
// frame gets that frame's timestamp, in the order they were asked for. The
// monitor asks first, at mount, long before any play.
vi.mock('../engine/audio', () => ({
  ensureAudioContext: () => {
    throw new Error('no audio context in node')
  },
  SCHEDULE_LATENCY_S: 0.05,
  scheduleAudio: () => Promise.resolve(() => undefined),
  clipEmitsAudioOn: () => false,
  prewarmAudio: () => {},
}))
// What the monitor drew, and when it drew it. The real lastPlayedFrameS is the
// same rule: the last time handed to a playing draw.
const drawn = vi.hoisted(() => ({ list: [] as { tS: number; playing: boolean }[], played: null as number | null }))
vi.mock('../engine/preview', () => ({
  renderPreview: (_c: unknown, _s: unknown, _a: unknown, tS: number, playing: boolean) => {
    drawn.list.push({ tS, playing })
    if (playing) drawn.played = tS
    return true
  },
  noPictureReason: () => null,
  previewEpoch: () => 0,
  prewarmPreview: () => {},
  pauseAllPreviewVideos: () => {},
  setPreviewTransportRate: () => {},
  lastPlayedFrameS: () => drawn.played,
  forgetPlayedFrame: () => {
    drawn.played = null
  },
}))
vi.mock('../state/voiceRecorder', () => ({
  isTakeInProgress: () => false,
  pauseRecording: () => {},
  resumeRecording: () => {},
  takeHeard: () => {},
}))

const { useProgramCanvas } = await import('./Monitor')
const { isPlaying, togglePlay } = await import('../state/playbackControl')
const { updateActiveSequence, useStore } = await import('../state/store')

let nowMs = 1000
let nextId = 1
const queue = new Map<number, FrameRequestCallback>()

/** Let the clock run `ms`, then run one animation frame. */
function frameAfter(ms: number): void {
  nowMs += ms
  const due = [...queue.values()]
  queue.clear()
  for (const cb of due) cb(nowMs)
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const playheadFrame = (): number => Math.floor(useStore.getState().ui.playheadS * 30 + 1e-6)
const lastDrawnFrame = (): number => Math.round(drawn.list[drawn.list.length - 1].tS * 30)

function Probe() {
  const { canvasRef } = useProgramCanvas(1)
  return (
    <div>
      <canvas ref={canvasRef} />
    </div>
  )
}

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.set(nextId, cb)
    return nextId++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  updateActiveSequence('A 10 second edit at 30', (seq) => ({ ...seq, durationS: 10, fps: 30 }))
  useStore.getState().setUI({ playheadS: 0 })
  drawn.list = []
  drawn.played = null
})

afterEach(() => {
  if (isPlaying()) togglePlay()
  cleanup()
  queue.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ⛔ THE ROOT OF "A PAUSE STEPS THE PICTURE ON" (2026-10-07). The monitor's loop
// was asked for at mount, so in every frame it ran BEFORE the transport's and
// drew the playhead of the frame before: the picture a tick behind the clock,
// the sound and the readout, and a pause landing a frame past what he saw.
describe('while playing, the monitor draws the frame the clock is on in that same frame', () => {
  it('not the frame the clock was on one animation frame earlier', async () => {
    render(<Probe />)
    frameAfter(16) // the monitor's first draw, paused, at 0
    togglePlay()
    await settle()
    for (const ms of [100, 1000 / 30, 1000 / 30, 50, 1000 / 30]) {
      frameAfter(ms)
      expect(drawn.list[drawn.list.length - 1].playing).toBe(true)
      expect(lastDrawnFrame()).toBe(playheadFrame())
    }
  })

  it('so a pause lands on the frame that is on screen, and the readout agrees with it', async () => {
    render(<Probe />)
    frameAfter(16)
    togglePlay()
    await settle()
    frameAfter(500)
    frameAfter(1000 / 30)
    const onScreen = lastDrawnFrame()
    expect(onScreen).toBe(playheadFrame())
    nowMs += 20 // the key press comes between two frames
    togglePlay()
    expect(isPlaying()).toBe(false)
    expect(useStore.getState().ui.playheadS * 30).toBeCloseTo(onScreen, 6)
  })
})
