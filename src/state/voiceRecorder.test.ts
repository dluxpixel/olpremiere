import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Recording must coexist with playback: starting/stopping a take never touches
// the transport. voiceRecorder has NO import of playbackControl — this mock
// intercepts any future coupling so the spy assertion below would catch it.
const { importFilesSpy, pausePlaybackSpy, showSpy } = vi.hoisted(() => ({
  importFilesSpy: vi.fn(() => Promise.resolve()),
  pausePlaybackSpy: vi.fn(),
  showSpy: vi.fn(),
}))
vi.mock('./mediaActions', () => ({ importFiles: importFilesSpy }))
vi.mock('./playbackControl', () => ({ pausePlayback: pausePlaybackSpy }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: showSpy }) } }))

import {
  audioConstraintFor,
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

  it('noise-reduce toggles ONLY noise suppression (echo + auto-gain stay off)', () => {
    expect(audioConstraintFor(null, true)).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    })
  })
})

/** Real browser onstop is async — tests fire rec.onstop manually to model it. */
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

describe('recording state guards (coexistence with playback)', () => {
  const mics: { stream: MediaStream; stop: ReturnType<typeof vi.fn> }[] = []
  const getUserMedia = vi.fn(async () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    mics.push({ stream, stop })
    return stream
  })

  beforeEach(() => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
    FakeMediaRecorder.instances.length = 0
    mics.length = 0
    getUserMedia.mockClear()
    importFilesSpy.mockClear()
    pausePlaybackSpy.mockClear()
    showSpy.mockClear()
    useRecorder.setState({ recording: false, startedAt: null, selectedInputId: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a full take never reaches into the transport, and Stop responds before the async flush', async () => {
    await startRecording()
    expect(useRecorder.getState().recording).toBe(true)
    expect(typeof useRecorder.getState().startedAt).toBe('number')

    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    // UI state flips immediately — the async onstop flush must not gate it.
    expect(useRecorder.getState().recording).toBe(false)
    expect(useRecorder.getState().startedAt).toBeNull()

    rec.onstop?.()
    expect(mics[0].stop).toHaveBeenCalled()
    expect(importFilesSpy).toHaveBeenCalledTimes(1)
    // The recorder never pauses/stops playback — not on start, stop, or flush.
    expect(pausePlaybackSpy).not.toHaveBeenCalled()
  })

  it('concurrent and repeat starts are one take (acquiring + recording guards)', async () => {
    await Promise.all([startRecording(), startRecording()])
    await startRecording()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    stopRecording()
    FakeMediaRecorder.instances[0].onstop?.()
  })

  it('stopRecording with no active take is a no-op', () => {
    expect(() => stopRecording()).not.toThrow()
    expect(useRecorder.getState().recording).toBe(false)
    expect(pausePlaybackSpy).not.toHaveBeenCalled()
  })

  it('a recorder that stops on its own (mic unplugged) resets the flag — no stuck Stop button', async () => {
    await startRecording()
    // Browser-initiated stop: onstop fires with stopRecording() never called.
    FakeMediaRecorder.instances[0].onstop?.()
    expect(useRecorder.getState().recording).toBe(false)
    expect(useRecorder.getState().startedAt).toBeNull()
    expect(mics[0].stop).toHaveBeenCalled()
  })

  it("a stale take's late flush never tears down the newer take", async () => {
    await startRecording()
    const rec1 = FakeMediaRecorder.instances[0]
    rec1.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording() // take 1 onstop still pending
    await startRecording() // take 2 live
    expect(useRecorder.getState().recording).toBe(true)

    rec1.onstop?.() // take 1's late flush
    expect(useRecorder.getState().recording).toBe(true)
    expect(mics[1].stop).not.toHaveBeenCalled() // take 2's mic untouched
    expect(importFilesSpy).toHaveBeenCalledTimes(1) // take 1 still imported

    FakeMediaRecorder.instances[1].ondataavailable?.({ data: new Blob(['y']) })
    stopRecording()
    FakeMediaRecorder.instances[1].onstop?.()
    expect(importFilesSpy).toHaveBeenCalledTimes(2)
  })
})
