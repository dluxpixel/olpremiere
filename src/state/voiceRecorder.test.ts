import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Recording must coexist with playback: starting/stopping a take never touches
// the transport. voiceRecorder has NO import of playbackControl. This mock
// intercepts any future coupling so the spy assertion below would catch it.
const { importFilesSpy, pausePlaybackSpy, showSpy, monitorStop, makeMonitor } = vi.hoisted(() => {
  const monitorStop = vi.fn()
  return {
    importFilesSpy: vi.fn(() => Promise.resolve()),
    pausePlaybackSpy: vi.fn(),
    showSpy: vi.fn(),
    monitorStop,
    // A fake MonitorGraph: a stream whose one track's stop() is the spy, plus
    // the level/monitor/output/dispose surface the studio drives.
    makeMonitor: () => ({
      stream: { getTracks: () => [{ stop: monitorStop }] } as unknown as MediaStream,
      level: () => 0,
      setMonitoring: vi.fn(),
      setOutput: vi.fn(async () => {}),
      dispose: monitorStop,
    }),
  }
})
vi.mock('./mediaActions', () => ({ importFiles: importFilesSpy }))
vi.mock('./playbackControl', () => ({ pausePlayback: pausePlaybackSpy }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: showSpy }) } }))
vi.mock('./recordingMonitor', () => ({
  createMonitorGraph: vi.fn(async () => makeMonitor()),
  listAudioOutputs: vi.fn(async () => []),
  canPickOutput: () => true,
}))

import {
  audioConstraintFor,
  closeStudio,
  discardTake,
  keepTake,
  recordingFileName,
  startRecording,
  stopRecording,
  useRecorder,
} from './voiceRecorder'

describe('recordingFileName', () => {
  it('numbers takes and picks the extension from the mime', () => {
    expect(recordingFileName(1, 'audio/webm;codecs=opus')).toBe('Voice recording 1.webm')
    expect(recordingFileName(2, 'audio/webm')).toBe('Voice recording 2.webm')
    expect(recordingFileName(3, 'audio/ogg;codecs=opus')).toBe('Voice recording 3.ogg')
    expect(recordingFileName(4, 'audio/mp4')).toBe('Voice recording 4.m4a')
  })

  it('defaults to webm when the mime is unknown or empty', () => {
    expect(recordingFileName(5, '')).toBe('Voice recording 5.webm')
    expect(recordingFileName(6, 'audio/weird')).toBe('Voice recording 6.webm')
  })
})

describe('audioConstraintFor', () => {
  it('defaults to clean capture: processing off, 48k mono, no device pinned', () => {
    expect(audioConstraintFor(null)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    })
  })

  it('pins an explicitly chosen device with an exact constraint', () => {
    expect(audioConstraintFor('mic-abc123')).toMatchObject({ deviceId: { exact: 'mic-abc123' } })
  })
})

/** Real browser onstop is async, so tests fire rec.onstop manually to model it. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = (): boolean => true
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this)
  }
  start(): void {}
  stop(): void {}
}

describe('studio capture: review-then-keep, and coexistence with playback', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:take', revokeObjectURL: vi.fn() })
    FakeMediaRecorder.instances.length = 0
    importFilesSpy.mockClear()
    pausePlaybackSpy.mockClear()
    showSpy.mockClear()
    monitorStop.mockClear()
    useRecorder.setState({
      studioOpen: false,
      recording: false,
      startedAt: null,
      pendingTake: null,
      selectedInputId: null,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a finished take is HELD for review, not imported; the mic stays live', async () => {
    await startRecording()
    expect(useRecorder.getState().recording).toBe(true)
    expect(useRecorder.getState().studioOpen).toBe(true) // record brought the studio up

    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    // UI flips immediately; the async onstop flush must not gate it.
    expect(useRecorder.getState().recording).toBe(false)
    rec.onstop?.()

    // The take is waiting for a decision, NOT in the bin, and the shared mic is
    // still open for the next take.
    expect(useRecorder.getState().pendingTake).not.toBeNull()
    expect(importFilesSpy).not.toHaveBeenCalled()
    expect(monitorStop).not.toHaveBeenCalled()
    // The recorder never touches the transport, on start, stop, or flush.
    expect(pausePlaybackSpy).not.toHaveBeenCalled()
  })

  it('keeping a take imports it once and clears the review slot', async () => {
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()

    await keepTake()
    expect(importFilesSpy).toHaveBeenCalledTimes(1)
    expect(useRecorder.getState().pendingTake).toBeNull()
  })

  it('discarding a take drops it without importing', async () => {
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()

    discardTake()
    expect(useRecorder.getState().pendingTake).toBeNull()
    expect(importFilesSpy).not.toHaveBeenCalled()
  })

  it('a new take replaces an unreviewed one (review is per-take, not a queue)', async () => {
    await startRecording()
    let rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    const first = useRecorder.getState().pendingTake

    await startRecording() // did not keep the first
    rec = FakeMediaRecorder.instances[1]
    rec.ondataavailable?.({ data: new Blob(['y']) })
    stopRecording()
    rec.onstop?.()
    expect(useRecorder.getState().pendingTake).not.toBe(first)
    expect(importFilesSpy).not.toHaveBeenCalled()
  })

  it('closing the studio releases the mic and drops an unreviewed take', async () => {
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    expect(useRecorder.getState().pendingTake).not.toBeNull()

    closeStudio()
    expect(useRecorder.getState().studioOpen).toBe(false)
    expect(useRecorder.getState().pendingTake).toBeNull() // unreviewed take gone
    expect(monitorStop).toHaveBeenCalled() // mic released
  })

  it('concurrent and repeat record clicks are one take (guards hold)', async () => {
    await Promise.all([startRecording(), startRecording()])
    await startRecording()
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    stopRecording()
    FakeMediaRecorder.instances[0].onstop?.()
  })

  it('stopRecording with no active take is a no-op', () => {
    expect(() => stopRecording()).not.toThrow()
    expect(useRecorder.getState().recording).toBe(false)
    expect(pausePlaybackSpy).not.toHaveBeenCalled()
  })
})
