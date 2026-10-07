/**
 * The browser export tells him when the video will have no sound.
 *
 * ⛔ IT USED TO WRITE A SILENT VIDEO WITHOUT A WORD (export audit, 2026-10-06), two ways: a browser
 * with no AudioEncoder at all, and one whose encoder takes neither AAC nor Opus. He only found out
 * after uploading. Here the orchestrator runs with a stand-in worker and a stand-in mix plan, and
 * the toast is what he would see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type Project } from '../types'
import { planExport } from './exportPlan'
import { NO_SOUND_IN_THIS_BROWSER, type ExportRequest, type ExportResponse } from './messages'

const h = vi.hoisted(() => ({
  toasts: [] as { message: string; kind: string }[],
  noEncoder: false,
}))

vi.mock('../../state/toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string, kind = 'info') => h.toasts.push({ message, kind }) }) },
}))
vi.mock('../../state/mediaMirror', () => ({
  blobForExport: () => Promise.resolve(new Blob([new Uint8Array(8)])),
}))
vi.mock('./audioRender', () => ({
  // The mix plan as a browser with no AudioEncoder answers it: sound on the timeline, no way to encode it.
  planAudioMix: (...args: unknown[]) => {
    const opts = args[5] as { onCannotEncode?: () => void } | undefined
    if (h.noEncoder) opts?.onCannotEncode?.()
    return Promise.resolve(null)
  },
}))

const { exportSequence } = await import('./index')

class FakeWorker {
  static last: FakeWorker
  onmessage: ((e: MessageEvent<ExportResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  posted: ExportRequest[] = []
  constructor() {
    FakeWorker.last = this
  }
  postMessage(m: ExportRequest): void {
    this.posted.push(m)
  }
  terminate(): void {}
  emit(msg: ExportResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<ExportResponse>)
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

function start() {
  const p = project()
  const run = exportSequence(p, planExport(activeSequence(p)).settings, () => undefined, new AbortController().signal)
  run.catch(() => undefined)
  return run
}

beforeEach(() => {
  h.toasts.length = 0
  h.noEncoder = false
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('⛔ the browser export says when the video will have no sound', () => {
  it('a browser with no sound encoder at all: told before a frame is made', async () => {
    h.noEncoder = true
    const run = start()
    await flush()
    expect(h.toasts).toEqual([{ message: NO_SOUND_IN_THIS_BROWSER, kind: 'danger' }])
    FakeWorker.last.emit({ type: 'done', buffer: new ArrayBuffer(4) })
    await expect(run).resolves.toBeInstanceOf(Blob)
  })

  it('a worker that finds no codec it can use for the sound: told, and the export carries on', async () => {
    const run = start()
    await flush()
    expect(h.toasts).toEqual([])
    FakeWorker.last.emit({ type: 'warning', message: NO_SOUND_IN_THIS_BROWSER })
    expect(h.toasts).toEqual([{ message: NO_SOUND_IN_THIS_BROWSER, kind: 'danger' }])
    FakeWorker.last.emit({ type: 'done', buffer: new ArrayBuffer(4) })
    await expect(run).resolves.toBeInstanceOf(Blob)
  })
})
