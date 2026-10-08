/**
 * @vitest-environment jsdom
 *
 * THE DESKTOP FRAME RELAY, the riskiest code in the export, with a stand-in worker and a
 * stand-in main process.
 *
 * Every other test that reaches the export mocks exportNative away, so nothing held this to its
 * promises (export audit, 2026-10-06). It writes into a raw RGBA pipe with no framing, where two
 * writes in flight at once would interleave into garbage, and it owns cancel, error latching and
 * progress. What is proven here is exactly that: frames reach the pipe one at a time and in order,
 * a failed write stops the export with its reason, a cancel is a cancel and never an error, the
 * file is closed only after the last frame, and the sound reaches main sample for sample.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type Project } from '../types'
import { planExport } from './exportPlan'
import type { ExportProgress, ExportRequest, ExportResponse } from './messages'
import type { AudioMixPlan } from './audioRender'

const h = vi.hoisted(() => ({
  api: undefined as unknown,
  audioPlan: null as unknown,
  audioOpts: [] as unknown[],
}))

vi.mock('../../platform', () => ({
  get olApi() {
    return h.api
  },
  isElectron: true,
}))
vi.mock('../../state/mediaMirror', () => ({
  blobForExport: () => Promise.resolve(new Blob([new Uint8Array(8)])),
}))
vi.mock('./audioRender', () => ({
  planAudioMix: (...args: unknown[]) => {
    h.audioOpts.push(args[5])
    return Promise.resolve(h.audioPlan)
  },
}))

const { exportNative, interleaveF32 } = await import('./nativeExport')

/** The export worker, standing still until the test speaks for it. */
class FakeWorker {
  static last: FakeWorker
  /** How many the code under test made since the test began. */
  static made = 0
  onmessage: ((e: MessageEvent<ExportResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: ExportRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
    FakeWorker.made++
  }
  postMessage(m: ExportRequest): void {
    this.posted.push(m)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(msg: ExportResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<ExportResponse>)
  }
}

interface PendingWrite {
  bytes: number[]
  settle: (r: { ok: boolean; error?: string }) => void
}

/** Main, standing still: every frame write waits until the test settles it. */
function fakeMain() {
  const log: string[] = []
  const writes: PendingWrite[] = []
  let progress: ((p: { frame: number; totalFrames: number }) => void) | null = null
  /** What main was handed for the WAV: the begin's arguments, then every segment's bytes in order. */
  const audio = { begun: [] as [number, number][], chunks: [] as ArrayBuffer[], finished: 0 }
  const starts: Record<string, unknown>[] = []
  const finish = {
    hold: false,
    release: () => {},
    fail: null as Error | null,
    result: { ok: true, outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1234 } as Record<string, unknown>,
  }
  const startGate = { hold: false, release: () => {} }
  // What the save dialog answers: a path, or null when he dismisses it.
  const picker = { answer: 'C:\\Videos\\Holiday.mp4' as string | null }
  // What start answers. Main takes back only the path its own dialog gave; for any other it asks
  // him itself, and dismissing THAT dialog answers { started: false, cancelled: true }.
  const startAnswer = { result: { started: true, outPath: 'C:\\Videos\\Holiday.mp4' } as Record<string, unknown> }
  const api = {
    isElectron: true,
    nativePickOutput: () => {
      log.push('pick')
      return Promise.resolve(picker.answer)
    },
    nativeAudioBegin: (sampleRate: number, channels: number) => {
      log.push('audioBegin')
      audio.begun.push([sampleRate, channels])
      return Promise.resolve()
    },
    nativeAudioChunk: (interleaved: ArrayBuffer) => {
      log.push('audioChunk')
      audio.chunks.push(interleaved)
      return Promise.resolve()
    },
    nativeAudioFinish: () => {
      log.push('audioFinish')
      audio.finished++
      return Promise.resolve()
    },
    nativeStart: (config: Record<string, unknown>) => {
      log.push('start')
      starts.push(config)
      const result = startAnswer.result
      // Held open when asked: the real start waits on the Windows save dialog.
      if (!startGate.hold) return Promise.resolve(result)
      return new Promise((r) => (startGate.release = () => r(result)))
    },
    nativeWriteFrame: (frame: ArrayBuffer) =>
      new Promise<{ ok: boolean; error?: string }>((settle) => {
        const bytes = [...new Uint8Array(frame)]
        log.push(`write ${bytes[0]}`)
        writes.push({ bytes, settle })
      }),
    nativeFinish: () => {
      log.push('finish')
      if (finish.fail) return Promise.reject(finish.fail)
      const result = finish.result
      // Held open when asked: the real finish waits for ffmpeg to drain its lookahead.
      if (!finish.hold) return Promise.resolve(result)
      return new Promise((r) => (finish.release = () => r(result)))
    },
    nativeCancel: () => {
      log.push('cancel')
      // A round trip to main, so a write failing BECAUSE of the stop can land first.
      return new Promise<void>((r) => setTimeout(r, 0))
    },
    onNativeProgress: (fn: (p: { frame: number; totalFrames: number }) => void) => {
      progress = fn
      return () => {
        progress = null
      }
    },
  }
  return {
    api,
    log,
    writes,
    audio,
    starts,
    finish,
    startGate,
    picker,
    startAnswer,
    ffmpegSays: (frame: number) => progress?.({ frame, totalFrames: 0 }),
  }
}

function project(): Project {
  const p = newProject('Holiday')
  const seq = activeSequence(p)
  p.assets = { a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'asset/a1', durationS: 5 } as Project['assets'][string] }
  seq.durationS = 5
  seq.tracks[0].clips = [{ id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 5, speed: 1, enabled: true } as unknown as Clip]
  return p
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A frame whose first byte names it. */
const frame = (n: number): ArrayBuffer => new Uint8Array([n, 0, 0, 0]).buffer

let main: ReturnType<typeof fakeMain>
let progress: ExportProgress[]

function start(signal = new AbortController().signal, opts: { outPath?: string; onOutPath?: (path: string) => void } = {}) {
  const p = project()
  const settings = planExport(activeSequence(p)).settings
  const run = exportNative(p, settings, { encoder: 'x264', quality: 14, suggestedName: 'Holiday.mp4', ...opts }, (pr) => progress.push(pr), signal)
  // Whatever it ends as, nothing may be left unhandled.
  run.catch(() => undefined)
  return run
}

beforeEach(() => {
  main = fakeMain()
  h.api = main.api
  h.audioPlan = null
  h.audioOpts.length = 0
  progress = []
  FakeWorker.made = 0
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('frames reach ffmpeg one at a time, in order', () => {
  it('a second write never starts before the first is taken, however far ahead the worker renders', async () => {
    start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(2) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(3) } as ExportResponse)
    await flush()
    // Only the first is in the pipe.
    expect(main.writes.map((x) => x.bytes[0])).toEqual([1])

    main.writes[0].settle({ ok: true })
    await flush()
    expect(main.writes.map((x) => x.bytes[0])).toEqual([1, 2])
    main.writes[1].settle({ ok: true })
    await flush()
    main.writes[2].settle({ ok: true })
    await flush()
    expect(main.writes.map((x) => x.bytes[0])).toEqual([1, 2, 3])
    // One render credit back per frame taken.
    expect(w.posted.filter((m) => m.type === 'frameAck')).toHaveLength(3)
  })

  it('the file is closed only after the last frame is in', async () => {
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(2) } as ExportResponse)
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    expect(main.log).not.toContain('finish')
    main.writes[0].settle({ ok: true })
    await flush()
    expect(main.log).not.toContain('finish')
    main.writes[1].settle({ ok: true })
    await expect(run).resolves.toEqual({ outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1234 })
    expect(main.log.slice(-3)).toEqual(['write 1', 'write 2', 'finish'])
    expect(w.terminated).toBe(true)
  })
})

describe('how fast it went, for the usage log', () => {
  it("the result carries the frames per second of the whole run and the worker's split of the time", async () => {
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(2) } as ExportResponse)
    w.emit({ type: 'done', buffer: null, times: { frames: 2, read: 40, draw: 10, pixels: 20, wait: 30 } })
    await flush()
    main.writes[0].settle({ ok: true })
    await flush()
    main.writes[1].settle({ ok: true })
    const res = await run
    expect(res).toMatchObject({ outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1234, speed: { read: 40, draw: 10, pixels: 20, wait: 30 } })
    expect(res!.speed!.fps).toBeGreaterThan(0)
  })

  it('a worker that sent no times leaves the speed out rather than making one up', async () => {
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    main.writes[0].settle({ ok: true })
    expect(await run).not.toHaveProperty('speed')
  })
})

describe('⛔ the progress never goes backward at the end', () => {
  it('after the last frame, ffmpeg catching up is the finishing step, and the percent only rises', async () => {
    main.finish.hold = true
    const run = start()
    await flush()
    const w = FakeWorker.last
    main.ffmpegSays(0)
    main.ffmpegSays(60)
    // Every frame is in: x264 still holds a lookahead's worth (105 of 240 on his gym frames).
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    main.ffmpegSays(70)
    main.ffmpegSays(65)
    main.ffmpegSays(140)
    const ffmpegPart = progress.filter((p) => p.phase === 'video' || p.phase === 'finalizing')
    expect(ffmpegPart.map((p) => [p.phase, p.framesDone])).toEqual([
      ['video', 0],
      ['video', 60],
      ['finalizing', 60],
      ['finalizing', 70],
      ['finalizing', 70],
      ['finalizing', 140],
    ])
    // Never 100 and then back to less.
    for (let i = 1; i < ffmpegPart.length; i++) expect(ffmpegPart[i].framesDone).toBeGreaterThanOrEqual(ffmpegPart[i - 1].framesDone)
    main.finish.release()
    await expect(run).resolves.toMatchObject({ sizeBytes: 1234 })
  })
})

describe('a write that fails stops the export with its reason', () => {
  it('rejects with what main said, stops ffmpeg, and writes nothing more', async () => {
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(2) } as ExportResponse)
    await flush()
    main.writes[0].settle({ ok: false, error: 'ffmpeg exited during export (exit code -28): No space left on device' })
    await expect(run).rejects.toThrow('No space left on device')
    await flush()
    expect(main.writes).toHaveLength(1)
    expect(main.log).toContain('cancel')
    expect(main.log).not.toContain('finish')
  })

  it('⛔ after the worker is done too: the file is stopped, never closed as if it were whole', async () => {
    // The worker renders ahead, so its "done" lands while the last frames still wait for the pipe.
    // A write failing then used to be followed by finish, a second order to main racing the stop.
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'frame', data: frame(2) } as ExportResponse)
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    main.writes[0].settle({ ok: false, error: 'ffmpeg exited during export (exit code -28): No space left on device' })
    await expect(run).rejects.toThrow('No space left on device')
    await flush()
    expect(main.writes).toHaveLength(1)
    expect(main.log).toContain('cancel')
    expect(main.log).not.toContain('finish')
  })
})

describe('the end of the file', () => {
  it('⛔ a finish that main never answers properly still ends the export, with the reason', async () => {
    // Nothing caught it: the export sat at "Finishing the file" for good.
    main.finish.fail = new Error("Error invoking remote method 'native:finish': reply was never sent")
    const run = start()
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    main.writes[0].settle({ ok: true })
    await expect(run).rejects.toThrow('reply was never sent')
    expect(w.terminated).toBe(true)
  })
})

describe('a cancel is a cancel', () => {
  it('during a write: AbortError, never the write error that the stop itself caused', async () => {
    const ctrl = new AbortController()
    const run = start(ctrl.signal)
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    await flush()
    ctrl.abort()
    // Killing ffmpeg fails the write in flight; that must not latch over the cancel.
    main.writes[0].settle({ ok: false, error: 'ffmpeg is not running' })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(w.posted.some((m) => m.type === 'cancel')).toBe(true)
    expect(main.log).toContain('cancel')
  })

  it('⛔ while ffmpeg is being started: it is stopped again, and no frame is rendered for it', async () => {
    // The abort listener only went on after start answered, so a stop in that gap was never heard
    // and the whole video was rendered and encoded anyway.
    main.startGate.hold = true
    const ctrl = new AbortController()
    const run = start(ctrl.signal)
    await flush()
    expect(main.log).toContain('start')
    ctrl.abort()
    main.startGate.release()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(main.log.slice(-1)).toEqual(['cancel'])
    expect(FakeWorker.made).toBe(0)
  })
})

describe('⛔ a cancel while the file is being finished', () => {
  // Main's finish was already waiting on ffmpeg when the cancel killed it, so its reply ("ffmpeg
  // exited with code null") came back before the cancel's and the export ended as a failure: "The
  // export stopped. Try again.", a red chip and a red taskbar button (export review S3, 2026-10-08).
  async function finishing(ctrl: AbortController) {
    main.finish.hold = true
    const run = start(ctrl.signal)
    await flush()
    const w = FakeWorker.last
    w.emit({ type: 'frame', data: frame(1) } as ExportResponse)
    w.emit({ type: 'done' } as ExportResponse)
    await flush()
    main.writes[0].settle({ ok: true })
    await flush()
    expect(main.log.at(-1)).toBe('finish')
    // Wrapped, or the async function would wait for the export itself.
    return { run }
  }

  it('is a cancel, even when the finish reply the stop caused arrives first', async () => {
    main.finish.result = { ok: false, error: 'ffmpeg exited with code null' }
    const ctrl = new AbortController()
    const { run } = await finishing(ctrl)
    ctrl.abort()
    main.finish.release()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(main.log).toContain('cancel')
  })

  it('is a cancel when ffmpeg had just ended well too: pressed Cancel means no Done', async () => {
    const ctrl = new AbortController()
    const { run } = await finishing(ctrl)
    ctrl.abort()
    main.finish.release()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a finish main answers as cancelled is a cancel, not "ffmpeg failed"', async () => {
    main.finish.result = { ok: false, cancelled: true }
    const { run } = await finishing(new AbortController())
    main.finish.release()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the sound', () => {
  it('reaches main as interleaved little-endian float samples that read back sample for sample', () => {
    // The header around them is main's (electron/nativeExport.test.ts decodes the whole file with ffmpeg).
    const left = new Float32Array([0, 0.5, -0.25, 1, -1, 0.123456789])
    const right = new Float32Array([0.1, -0.5, 0.25, -1, 1, -0.987654321])
    const data = interleaveF32([left, right])
    expect(data.byteLength).toBe(6 * 2 * 4)
    const dv = new DataView(data)
    for (let i = 0; i < 6; i++) {
      expect(dv.getFloat32(i * 8, true)).toBe(left[i])
      expect(dv.getFloat32(i * 8 + 4, true)).toBe(right[i])
    }
  })

  it('goes to main before ffmpeg starts, since ffmpeg reads it as an input', async () => {
    const segment = [new Float32Array([0.25, 0.5]), new Float32Array([-0.25, -0.5])]
    h.audioPlan = {
      info: { sampleRate: 48000, numberOfChannels: 2, totalFrames: 2 },
      render: async (onSegment) => {
        await onSegment(segment as Float32Array<ArrayBuffer>[])
      },
    } satisfies AudioMixPlan
    start()
    await flush()
    // (The save dialog comes before both since 2026-10-07: see "where it goes is asked first". The
    // mix goes a segment at a time since the same day: see "no message holds the whole mix".)
    expect(main.log.slice(0, 5)).toEqual(['pick', 'audioBegin', 'audioChunk', 'audioFinish', 'start'])
    expect(main.starts[0].hasAudio).toBe(true)
    expect(main.audio.begun).toEqual([[48000, 2]])
    const dv = new DataView(main.audio.chunks[0])
    expect([0, 1, 2, 3].map((i) => dv.getFloat32(i * 4, true))).toEqual([0.25, -0.25, 0.5, -0.5])
  })
})

describe('a timeline above 60 fps', () => {
  it('⛔ plans the sound at the rate the picture is made at, not the timeline rate', async () => {
    const p = project()
    activeSequence(p).fps = 240
    const settings = planExport(activeSequence(p)).settings
    expect(settings.fps).toBe(60)
    exportNative(p, settings, { encoder: 'x264', quality: 14, suggestedName: 'x.mp4' }, () => undefined, new AbortController().signal).catch(
      () => undefined,
    )
    await flush()
    expect(h.audioOpts[0]).toMatchObject({ fps: 60 })
  })
})

/**
 * A mix of `n` segments of `frames` each that counts how many were rendered, one tick apart like
 * the real render. Every sample is its own frame number, so order and loss both show.
 */
function countedMix(n: number, frames = 2) {
  const made = { segments: 0 }
  const plan = {
    info: { sampleRate: 48000, numberOfChannels: 2, totalFrames: n * frames },
    render: async (onSegment) => {
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 0))
        made.segments++
        const l = Float32Array.from({ length: frames }, (_, f) => i * frames + f)
        const r = Float32Array.from({ length: frames }, (_, f) => -(i * frames + f))
        await onSegment([l, r] as Float32Array<ArrayBuffer>[])
      }
    },
  } satisfies AudioMixPlan
  return { plan, made }
}

describe('⛔ where it goes is asked before the sound is made', () => {
  // The dialog used to come up inside start, after the whole mix had been rendered (twice with
  // Platform loudness on), so dismissing it threw all of that away (export audit, 2026-10-06).
  it('the save dialog comes first; dismissing it renders no sound and starts nothing', async () => {
    const { plan, made } = countedMix(3)
    h.audioPlan = plan
    main.picker.answer = null
    await expect(start()).resolves.toBeNull()
    expect(main.log).toEqual(['pick'])
    expect(made.segments).toBe(0)
  })

  it('ffmpeg writes where he chose, and the job is told so it can use it again', async () => {
    const told: string[] = []
    start(undefined, { onOutPath: (path) => told.push(path) })
    await flush()
    expect(told).toEqual(['C:\\Videos\\Holiday.mp4'])
    expect(main.starts[0].outPath).toBe('C:\\Videos\\Holiday.mp4')
  })

  it('a restart or Try again that already has the path asks nothing', async () => {
    start(undefined, { outPath: 'D:\\Shorts\\Gym.mp4' })
    await flush()
    expect(main.log).not.toContain('pick')
    expect(main.starts[0].outPath).toBe('D:\\Shorts\\Gym.mp4')
  })

  it('one dialog per export, and start is handed exactly the string it answered', async () => {
    // Main takes back only the path its own dialog gave (electron/exportChoice.ts on the electron
    // branch), compared as a string: a page that tidied it up would make main ask a second time.
    main.picker.answer = 'C:\\Users\\david\\Videos\\Gym Day  (2).mp4'
    start()
    await flush()
    expect(main.log.filter((x) => x === 'pick')).toHaveLength(1)
    expect(main.starts).toHaveLength(1)
    expect(main.starts[0].outPath).toBe('C:\\Users\\david\\Videos\\Gym Day  (2).mp4')
  })

  it('⛔ main asking him itself, and him dismissing that, ends quietly as a cancel', async () => {
    // This branch had lost `if (startRes.cancelled) return null`: the dismissed dialog threw "could
    // not start ffmpeg", which the plain words turn into "Reinstall OL Premiere", with a red chip
    // and a red taskbar button (export review S1, 2026-10-08).
    const { plan } = countedMix(2)
    h.audioPlan = plan
    main.startAnswer.result = { started: false, cancelled: true }
    await expect(start()).resolves.toBeNull()
    expect(FakeWorker.made).toBe(0)
  })

  it('a start that really failed still says why', async () => {
    main.startAnswer.result = { started: false, error: 'could not start ffmpeg: spawn EPERM' }
    await expect(start()).rejects.toThrow('spawn EPERM')
  })

  it('when main had to ask him itself, a restart and Try again go where it really wrote', async () => {
    const told: string[] = []
    main.startAnswer.result = { started: true, outPath: 'E:\\Elsewhere.mp4' }
    start(undefined, { onOutPath: (path) => told.push(path) })
    await flush()
    expect(told).toEqual(['C:\\Videos\\Holiday.mp4', 'E:\\Elsewhere.mp4'])
  })
})

describe('⛔ a cancel while the sound is being made', () => {
  // Nothing listened: Cancel during the sound of a long video did nothing until all of it was rendered.
  it('stops at the next segment, and the half made mix is taken away again', async () => {
    const { plan, made } = countedMix(10)
    h.audioPlan = plan
    const ctrl = new AbortController()
    const run = start(ctrl.signal)
    while (made.segments < 1) await new Promise((r) => setTimeout(r, 0))
    ctrl.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(made.segments).toBeLessThanOrEqual(2)
    // Begun, then dropped by the same cancel that drops a running export; ffmpeg never asked for.
    expect(main.log[0]).toBe('pick')
    expect(main.log.slice(-1)).toEqual(['cancel'])
    expect(main.log).not.toContain('start')
    expect(main.log).not.toContain('audioFinish')
  })

  it("the mix is handed the export's cancel, so Platform loudness's measuring pass hears it too", async () => {
    // Only the segments reaching the page were checked, and the measuring pass sends none
    // (export review N1, 2026-10-08; audioRender.test.ts holds the pass to it).
    const ctrl = new AbortController()
    start(ctrl.signal)
    await flush()
    expect(h.audioOpts[0]).toMatchObject({ signal: ctrl.signal })
  })
})

describe('⛔ no message holds the whole mix', () => {
  // It went to main as ONE WAV after three copies in memory: 384 KB a second, so a 12 minute video
  // was about 276 MB in a single message, past Chromium's default cap (export audit, 2026-10-06).
  it('a long video goes a segment per message, every sample in order', async () => {
    const SEG = 4800
    const { plan } = countedMix(30, SEG)
    h.audioPlan = plan
    start()
    while (!main.log.includes('start')) await new Promise((r) => setTimeout(r, 0))
    expect(main.audio.chunks).toHaveLength(30)
    expect(Math.max(...main.audio.chunks.map((c) => c.byteLength))).toBe(SEG * 2 * 4)
    expect(main.audio.finished).toBe(1)
    // Read back: frame k is k on the left and -k on the right, across every seam.
    const all = main.audio.chunks.flatMap((c) => [...new Float32Array(c)])
    expect(all).toHaveLength(30 * SEG * 2)
    for (let k = 0; k < 30 * SEG; k += 997) expect([all[2 * k], all[2 * k + 1]]).toEqual([k, -k])
  })
})
