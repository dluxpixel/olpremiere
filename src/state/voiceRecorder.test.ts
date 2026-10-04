import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Recording DRIVES the transport now, at his ask on 2026-08-12: starting a take
// rolls the preview so he can perform against his own edit, stopping it stops
// what the take started, and discarding puts him back where he began. This file
// used to assert the exact opposite, that the recorder never touched playback,
// and that assertion was correct until he asked for the coupling. The spies stay
// so the coupling that exists is the coupling that was asked for and no more.
const { importFilesSpy, pausePlaybackSpy, ensurePlayingSpy, showSpy, monitorStop, makeMonitor, readTakeSpy, mic, frames } =
  vi.hoisted(() => {
    const monitorStop = vi.fn()
    // What the fake mic is doing: its level right now, and whether the chosen
    // device was missing so the default had to be opened.
    const mic = { level: 0, fellBack: false, label: 'USB Microphone', latencyS: 0.01 }
    // The meter loop runs on animation frames; these are run by hand.
    const frames: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
    return {
      // A kept take becomes a real asset in the real store, like the import does.
      importFilesSpy: vi.fn(async (files: File[]) => {
        const { useStore } = await import('./store')
        const id = `asset-${files[0]!.name}`
        useStore.getState().dispatch(`Import 1 file(s)`, (p) => ({
          ...p,
          assets: { ...p.assets, [id]: { id, kind: 'audio', name: files[0]!.name, durationS: 30 } as never },
        }))
        return [id]
      }),
      pausePlaybackSpy: vi.fn(),
      ensurePlayingSpy: vi.fn(),
      showSpy: vi.fn(),
      readTakeSpy: vi.fn(async (): Promise<{ peak: number; mono: Blob | null } | null> => null),
      monitorStop,
      mic,
      frames,
      // A fake MonitorGraph: a stream whose one track's stop() is the spy, plus
      // the level/monitor/output/dispose surface the studio drives.
      makeMonitor: () => ({
        stream: { getTracks: () => [{ stop: monitorStop }] } as unknown as MediaStream,
        inputLabel: mic.label,
        fellBack: mic.fellBack,
        inputLatencyS: mic.latencyS,
        level: () => mic.level,
        setMonitoring: vi.fn(),
        setOutput: vi.fn(async () => {}),
        dispose: monitorStop,
      }),
    }
  })
vi.mock('./mediaActions', () => ({ importFiles: importFilesSpy }))
vi.mock('./playbackControl', () => ({
  pausePlayback: pausePlaybackSpy,
  ensurePlaying: ensurePlayingSpy,
  currentHeardSpan: () => null,
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: showSpy }) } }))
vi.mock('./recordingMonitor', () => ({
  createMonitorGraph: vi.fn(async () => makeMonitor()),
  listAudioOutputs: vi.fn(async () => []),
  canPickOutput: () => true,
}))
vi.mock('./takeAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./takeAudio')>()),
  readTake: readTakeSpy,
}))

import {
  audioConstraintFor,
  clearClip,
  closeStudio,
  discardTake,
  keepTake,
  openStudio,
  pauseRecording,
  pickRecorderMime,
  recordingFileName,
  resumeRecording,
  startRecording,
  stopRecording,
  takeHeard,
  useRecorder,
} from './voiceRecorder'

describe('recordingFileName', () => {
  it('numbers takes and picks the extension from the mime', () => {
    expect(recordingFileName(1, 'audio/webm;codecs=opus')).toBe('Voice recording 1.webm')
    expect(recordingFileName(2, 'audio/webm')).toBe('Voice recording 2.webm')
    expect(recordingFileName(3, 'audio/ogg;codecs=opus')).toBe('Voice recording 3.ogg')
    expect(recordingFileName(4, 'audio/mp4')).toBe('Voice recording 4.m4a')
    expect(recordingFileName(7, 'audio/webm;codecs=pcm')).toBe('Voice recording 7.webm')
    expect(recordingFileName(8, 'audio/wav')).toBe('Voice recording 8.wav')
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
  static isTypeSupported: (mime?: string) => boolean = () => true
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
  pause = vi.fn()
  resume = vi.fn()
}

describe('studio capture: review-then-keep, and coexistence with playback', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:take', revokeObjectURL: vi.fn() })
    // Whatever the last test left open goes first, before the spies are reset.
    closeStudio()
    FakeMediaRecorder.instances.length = 0
    FakeMediaRecorder.isTypeSupported = () => true
    importFilesSpy.mockClear()
    pausePlaybackSpy.mockClear()
    showSpy.mockClear()
    monitorStop.mockClear()
    readTakeSpy.mockReset()
    readTakeSpy.mockResolvedValue(null)
    Object.assign(mic, { level: 0, fellBack: false, label: 'USB Microphone', latencyS: 0.01 })
    frames.length = 0
    useRecorder.setState({
      studioOpen: false,
      recording: false,
      startedAt: null,
      pendingTake: null,
      selectedInputId: null,
      selectedInputLabel: null,
      clipped: false,
      keeping: false,
      inputLabel: '',
      inputMissing: false,
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
    // The take rolled the preview, and stopping it stopped what it started.
    expect(ensurePlayingSpy).toHaveBeenCalled()
    expect(pausePlaybackSpy).toHaveBeenCalled()
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

  // ⛔ HIS ASK, 2026-08-12: "when you stop the recording and you discard it, you
  // see it's not good enough. Make it go back to the start of the preview."
  it('discarding puts the playhead back where the take began', async () => {
    const { useStore } = await import('./store')
    useStore.getState().setUI({ playheadS: 7 })
    await startRecording()
    // The take rolled on; pretend it ran.
    useStore.getState().setUI({ playheadS: 11.5 })
    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()

    discardTake()
    expect(useStore.getState().ui.playheadS).toBe(7)
  })

  // And keeping it does NOT drag him backwards: he kept that take on purpose.
  it('keeping a take leaves the playhead alone', async () => {
    const { useStore } = await import('./store')
    useStore.getState().setUI({ playheadS: 3 })
    await startRecording()
    useStore.getState().setUI({ playheadS: 9 })
    const rec = FakeMediaRecorder.instances[0]
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()

    await keepTake()
    expect(useStore.getState().ui.playheadS).toBe(9)
  })

  // ⛔ MIC-6, 2026-09-30. Takes were Opus at 128 kbps and AAC again at export,
  // two lossy codecs on his voice, although this Electron records lossless PCM.
  it('records lossless first, and Opus with its bitrate only as the fallback', async () => {
    expect(pickRecorderMime()).toBe('audio/webm;codecs=pcm')
    await startRecording()
    expect(FakeMediaRecorder.instances[0]!.options).toEqual({ mimeType: 'audio/webm;codecs=pcm' })
    stopRecording()
    FakeMediaRecorder.instances[0]!.onstop?.()
    discardTake()

    FakeMediaRecorder.isTypeSupported = (m?: string) => m === 'audio/webm;codecs=opus'
    expect(pickRecorderMime()).toBe('audio/webm;codecs=opus')
    await startRecording()
    expect(FakeMediaRecorder.instances[1]!.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128_000 })
    stopRecording()
  })

  // ⛔ MIC-3. 5 of his 65 takes touched full scale and nothing ever said so.
  it('a take whose peak reached -1 dBFS says so once, in plain words, and lights the clip light', async () => {
    readTakeSpy.mockResolvedValue({ peak: 10 ** (-0.5 / 20), mono: null })
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]!
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    await keepTake()
    const said = showSpy.mock.calls.filter(([m]) => /clipped/i.test(String(m)))
    expect(said).toEqual([['This take clipped. Turn your mic gain down.', 'danger']])
    expect(useRecorder.getState().clipped).toBe(true)
  })

  it('a take that stayed under -1 dBFS says nothing', async () => {
    readTakeSpy.mockResolvedValue({ peak: 10 ** (-1.5 / 20), mono: null })
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]!
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    await keepTake()
    expect(showSpy.mock.calls.some(([m]) => /clipped/i.test(String(m)))).toBe(false)
  })

  it('the live clip light latches at -1 dBFS and stays until clicked or the next take', async () => {
    await openStudio()
    mic.level = 10 ** (-0.9 / 20)
    frames.splice(0).forEach((f) => f(0))
    mic.level = 0.1
    frames.splice(0).forEach((f) => f(0))
    expect(useRecorder.getState().clipped).toBe(true) // still lit with the input back down
    clearClip()
    expect(useRecorder.getState().clipped).toBe(false)
    mic.level = 1
    frames.splice(0).forEach((f) => f(0))
    expect(useRecorder.getState().clipped).toBe(true)
    mic.level = 0
    await startRecording()
    expect(useRecorder.getState().clipped).toBe(false) // a new take starts clean
    stopRecording()
  })

  // ⛔ MIC-7. Every take he has is the same voice on both sides.
  it('a lossless take that is one voice twice is kept as the mono take, under a .wav name', async () => {
    const mono = new Blob(['RIFF'], { type: 'audio/wav' })
    readTakeSpy.mockResolvedValue({ peak: 0.5, mono })
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]!
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    expect(readTakeSpy).toHaveBeenCalledWith(expect.any(Blob), true)
    await keepTake()
    const kept = (importFilesSpy.mock.calls[0] as unknown as [File[]])[0][0]!
    expect(kept.name).toMatch(/^Voice recording \d+\.wav$/)
    expect(kept.type).toBe('audio/wav')
  })

  // ⛔ MIC-8. A missing pinned mic used to fall back to the default in silence.
  it('a chosen mic that is not connected says so by name, and the studio shows what is recording', async () => {
    useRecorder.setState({ selectedInputId: 'usb-yeti', selectedInputLabel: 'Blue Yeti' })
    Object.assign(mic, { fellBack: true, label: 'Microphone (Realtek Audio)' })
    await openStudio()
    expect(showSpy).toHaveBeenCalledWith(
      '“Blue Yeti” is not connected. Recording from “Microphone (Realtek Audio)” instead.',
      'danger',
    )
    expect(useRecorder.getState()).toMatchObject({ inputMissing: true, inputLabel: 'Microphone (Realtek Audio)' })
  })

  it('the right mic says nothing, and its name is still shown', async () => {
    await openStudio()
    expect(showSpy).not.toHaveBeenCalled()
    expect(useRecorder.getState()).toMatchObject({ inputMissing: false, inputLabel: 'USB Microphone' })
  })

  // ⛔ MIC-4 and MIC-5. His answer, 2026-09-30: "Yes, place it for me."
  it('a kept take lands where he performed it, each Space pause on its own spot, and one undo lifts it off', async () => {
    const { useStore } = await import('./store')
    const { activeSequence, newProject } = await import('../engine/types')
    useStore.getState().setProject(newProject())
    useStore.getState().setUI({ playheadS: 2 })
    const now = vi.spyOn(performance, 'now').mockReturnValue(10_000)
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]!
    // What the transport reported: timeline 2.0 heard 135 ms after the recorder
    // started, paused 2.5 s later, resumed from 4.5 heard at 13,521 ms.
    takeHeard({ timelineS: 2, heardAtMs: 10_135 })
    takeHeard(null, 12_635)
    pauseRecording()
    resumeRecording()
    takeHeard({ timelineS: 4.5, heardAtMs: 13_521 })
    // The mic never paused: the file runs on in real time.
    expect(rec.pause).not.toHaveBeenCalled()
    expect(rec.resume).not.toHaveBeenCalled()
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    await keepTake()
    now.mockRestore()

    const placed = () =>
      activeSequence(useStore.getState().project)
        .tracks.flatMap((t) => t.clips)
        .map((c) => ({ startS: c.startS, inS: +c.inS.toFixed(6), outS: +c.outS.toFixed(6) }))
    // The voice for timeline 2.0 went into the mic 135 ms after the recorder
    // started and reached the recorder 10 ms later (the mic's own delay).
    // The second stretch ran to the end of the file at timeline 30.969, between
    // two frames: its clip ends on frame 929 (30.9667), the voice still exactly
    // where it was placed (spanOnFrames, 2026-10-03).
    expect(placed()).toEqual([
      { startS: 2, inS: 0.145, outS: 2.645 },
      { startS: 4.5, inS: 3.531, outS: 29.997667 },
    ])
    const assetId = Object.keys(useStore.getState().project.assets)[0]!
    useStore.getState().undo()
    expect(placed()).toEqual([])
    expect(useStore.getState().project.assets[assetId]).toBeDefined() // still in the library
  })

  // ⛔ FOUND BY REVIEW, 2026-10-01: Keep waited for the take's read BEFORE it
  // claimed the take, so closing the studio or pressing Record in that wait threw
  // away the take he had just chosen to keep. In the real app: gone with the X
  // pressed 2 ms after "Add". Now Keep claims it at once.
  const takeBeingRead = async () => {
    let finishRead: (r: { peak: number; mono: Blob | null }) => void = () => undefined
    readTakeSpy.mockImplementation(() => new Promise((r) => (finishRead = r)))
    await startRecording()
    const rec = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]!
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    return (r = { peak: 0.5, mono: null as Blob | null }) => finishRead(r)
  }

  it('Keep, then the studio closed in the same moment: the take is still kept, once', async () => {
    const finishRead = await takeBeingRead()
    const kept = keepTake()
    closeStudio()
    expect(useRecorder.getState().keeping).toBe(true)
    finishRead()
    await kept
    expect(importFilesSpy).toHaveBeenCalledTimes(1)
    expect(useRecorder.getState().keeping).toBe(false)
  })

  it('Keep, then Record straight away: the kept take is still kept', async () => {
    const finishRead = await takeBeingRead()
    const kept = keepTake()
    await startRecording()
    finishRead()
    await kept
    expect(importFilesSpy).toHaveBeenCalledTimes(1)
    stopRecording()
  })

  it('Keep pressed twice is one take kept', async () => {
    const finishRead = await takeBeingRead()
    const a = keepTake()
    const b = keepTake()
    finishRead()
    await Promise.all([a, b])
    expect(importFilesSpy).toHaveBeenCalledTimes(1)
  })

  it('the transport says a stretch continues, or ran off the end of the edit, and the take keeps both', async () => {
    const { useStore } = await import('./store')
    const { activeSequence, newProject } = await import('../engine/types')
    useStore.getState().setProject(newProject())
    const now = vi.spyOn(performance, 'now').mockReturnValue(10_000)
    await startRecording()
    const rec = FakeMediaRecorder.instances[0]!
    // The picture alone from 0, then the late sound continuing it, then the
    // preview running off the end of a 2 s edit while he keeps talking.
    takeHeard({ timelineS: 0, heardAtMs: 10_100 })
    takeHeard({ timelineS: 0.2, heardAtMs: 10_300, continues: true })
    takeHeard(null, 11_900, 'end')
    rec.ondataavailable?.({ data: new Blob(['x']) })
    stopRecording()
    rec.onstop?.()
    await keepTake()
    now.mockRestore()
    const clips = activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)
    // One clip from 0, running on to the end of the 30 s take, less the part of
    // a frame past the last whole one (timeline 29.89 is frame 896.7, and the
    // file has nothing for frame 897 to show).
    expect(clips.map((c) => [c.startS, +c.inS.toFixed(6), +c.outS.toFixed(6)])).toEqual([[0, 0.11, 29.976667]])
  })
})
