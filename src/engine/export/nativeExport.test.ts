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
  planAudioMix: () => Promise.resolve(h.audioPlan),
}))

const { exportNative, buildWavF32 } = await import('./nativeExport')

/** The export worker, standing still until the test speaks for it. */
class FakeWorker {
  static last: FakeWorker
  onmessage: ((e: MessageEvent<ExportResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: ExportRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
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
  const wavs: ArrayBuffer[] = []
  const starts: Record<string, unknown>[] = []
  const finish = { hold: false, release: () => {} }
  const api = {
    isElectron: true,
    nativePrepareAudio: (wav: ArrayBuffer) => {
      log.push('prepareAudio')
      wavs.push(wav)
      return Promise.resolve({ ok: true })
    },
    nativeStart: (config: Record<string, unknown>) => {
      log.push('start')
      starts.push(config)
      return Promise.resolve({ started: true, outPath: 'C:\\Videos\\Holiday.mp4' })
    },
    nativeWriteFrame: (frame: ArrayBuffer) =>
      new Promise<{ ok: boolean; error?: string }>((settle) => {
        const bytes = [...new Uint8Array(frame)]
        log.push(`write ${bytes[0]}`)
        writes.push({ bytes, settle })
      }),
    nativeFinish: () => {
      log.push('finish')
      const result = { ok: true, outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1234 }
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
  return { api, log, writes, wavs, starts, finish, ffmpegSays: (frame: number) => progress?.({ frame, totalFrames: 0 }) }
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

function start(signal = new AbortController().signal) {
  const p = project()
  const settings = planExport(activeSequence(p)).settings
  const run = exportNative(p, settings, { encoder: 'x264', quality: 14, suggestedName: 'Holiday.mp4' }, (pr) => progress.push(pr), signal)
  // Whatever it ends as, nothing may be left unhandled.
  run.catch(() => undefined)
  return run
}

beforeEach(() => {
  main = fakeMain()
  h.api = main.api
  h.audioPlan = null
  progress = []
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
})

describe('the sound', () => {
  it('reaches main as a float WAV that reads back sample for sample', () => {
    const left = new Float32Array([0, 0.5, -0.25, 1, -1, 0.123456789])
    const right = new Float32Array([0.1, -0.5, 0.25, -1, 1, -0.987654321])
    const wav = buildWavF32([left, right], 48000)
    const dv = new DataView(wav)
    const text = (o: number, n: number) => String.fromCharCode(...new Uint8Array(wav, o, n))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(dv.getUint16(20, true)).toBe(3) // IEEE float
    expect(dv.getUint16(22, true)).toBe(2)
    expect(dv.getUint32(24, true)).toBe(48000)
    expect(dv.getUint16(34, true)).toBe(32)
    expect(text(36, 4)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(6 * 2 * 4)
    for (let i = 0; i < 6; i++) {
      expect(dv.getFloat32(44 + i * 8, true)).toBe(left[i])
      expect(dv.getFloat32(44 + i * 8 + 4, true)).toBe(right[i])
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
    expect(main.log.slice(0, 2)).toEqual(['prepareAudio', 'start'])
    expect(main.starts[0].hasAudio).toBe(true)
    const dv = new DataView(main.wavs[0])
    expect([0, 1, 2, 3].map((i) => dv.getFloat32(44 + i * 4, true))).toEqual([0.25, -0.25, 0.5, -0.5])
  })
})
