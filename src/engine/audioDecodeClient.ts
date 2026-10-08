// The main thread's side of audioDecodeWorker.ts: a small pool of workers and a
// promise per request. Where there is no Worker (unit tests, an old engine) or a
// worker dies, the same read runs here instead, so sound never goes missing
// because a thread could not be started.

import { demuxAudio, demuxPeaks, type DemuxResult, type PeaksResult } from './audioDemux'

export type AudioWorkerRequest =
  | { id: number; op: 'pcm'; blob: Blob; durationS: number; fromS?: number; toS?: number }
  | { id: number; op: 'peaks'; blob: Blob; durationS: number; buckets: number }

export type AudioWorkerResponse =
  | { id: number; ok: true; result: DemuxResult | PeaksResult }
  | { id: number; ok: false; error: string }

/** Two reads at once, the same bound the main thread read always had. */
const POOL_SIZE = 2

interface Slot {
  worker: Worker
  busy: boolean
}

let pool: Slot[] | null = null
let broken = false
let nextId = 1
const waiting: {
  req: AudioWorkerRequest
  priority: boolean
  resolve: (r: DemuxResult | PeaksResult) => void
  reject: (e: Error) => void
}[] = []
const inFlight = new Map<number, { slot: Slot; resolve: (r: DemuxResult | PeaksResult) => void; reject: (e: Error) => void }>()

function startPool(): Slot[] | null {
  if (broken) return null
  if (pool) return pool
  if (typeof Worker === 'undefined') {
    broken = true
    return null
  }
  try {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('./audioDecodeWorker.ts', import.meta.url), { type: 'module' })
      const slot: Slot = { worker, busy: false }
      worker.onmessage = (e: MessageEvent<AudioWorkerResponse>) => {
        const job = inFlight.get(e.data.id)
        if (!job) return
        inFlight.delete(e.data.id)
        slot.busy = false
        if (e.data.ok) job.resolve(e.data.result)
        else job.reject(new Error(e.data.error))
        pump()
      }
      worker.onerror = (e) => {
        // A worker that cannot even load (a blocked script, a bad build) takes the
        // whole pool down to the main thread path rather than failing every read.
        e.preventDefault()
        broken = true
        for (const [id, job] of inFlight) {
          if (job.slot !== slot) continue
          inFlight.delete(id)
          job.reject(new Error('audio worker failed'))
        }
        for (const w of waiting.splice(0)) runHere(w.req).then(w.resolve, w.reject)
      }
      return slot
    })
    return pool
  } catch {
    broken = true
    return null
  }
}

function pump(): void {
  const slots = startPool()
  if (!slots) return
  for (const slot of slots) {
    if (slot.busy) continue
    const next = waiting.shift()
    if (!next) return
    slot.busy = true
    inFlight.set(next.req.id, { slot, resolve: next.resolve, reject: next.reject })
    slot.worker.postMessage(next.req)
  }
}

function runHere(req: AudioWorkerRequest): Promise<DemuxResult | PeaksResult> {
  return req.op === 'peaks'
    ? demuxPeaks(req.blob, req.durationS, req.buckets)
    : demuxAudio(req.blob, { durationS: req.durationS, fromS: req.fromS, toS: req.toS })
}

/**
 * Which line a read waits in. A read starts in the background and can be moved
 * to the front later, when Play comes to wait on it (see promoteLane).
 */
export interface DecodeLane {
  priority: boolean
  /** Set while the read is queued: moves it to the front. */
  promote?: () => void
}

export const decodeLane = (priority = false): DecodeLane => ({ priority })

/**
 * Play is waiting on this read now. A read still queued moves ahead of every
 * background read; one not queued yet goes in at the front when it is; one
 * already running or done is left alone.
 */
export function promoteLane(lane: DecodeLane | undefined): void {
  if (!lane || lane.priority) return
  lane.priority = true
  lane.promote?.()
}

type Job = (typeof waiting)[number]

/** Into the queue: a front-lane read goes after the other front-lane ones, ahead of the background. */
function enqueue(job: Job): void {
  const at = job.priority ? waiting.findIndex((w) => !w.priority) : -1
  if (at >= 0) waiting.splice(at, 0, job)
  else waiting.push(job)
}

function run(req: AudioWorkerRequest, lane: DecodeLane = decodeLane()): Promise<DemuxResult | PeaksResult> {
  if (!startPool()) return runHere(req)
  return new Promise((resolve, reject) => {
    // ⛔ PLAYBACK GOES TO THE FRONT. Two workers, first come first served, meant a
    // press of Space waited behind every waveform, beat scan and loudness read
    // queued before it. A read the transport is waiting on now jumps every
    // background read that has not started (never one already running).
    const job: Job = { req, priority: lane.priority, resolve, reject }
    // ⛔ AND SO DOES A BACKGROUND READ PLAY COMES TO WAIT ON (SF-2, review
    // 2026-10-08). Selecting a clip queues a read of exactly the range Play then
    // asks for, and Play got that same read back, still behind every waveform.
    lane.promote = () => {
      const i = waiting.indexOf(job)
      if (i < 0 || job.priority) return
      waiting.splice(i, 1)
      job.priority = true
      enqueue(job)
    }
    enqueue(job)
    pump()
  }).then(
    (r) => r as DemuxResult | PeaksResult,
    // A read that failed in the worker is tried once here, so a worker specific
    // failure can never be the reason a clip is silent.
    () => runHere(req),
  )
}

/**
 * Decode source seconds [fromS, toS) (or the whole file) off the main thread.
 * `priority` is for a read the transport is waiting on, or a lane it can be
 * moved to the front with later.
 */
export function decodeAudioOffThread(
  blob: Blob,
  durationS: number,
  fromS?: number,
  toS?: number,
  priority: boolean | DecodeLane = false,
): Promise<DemuxResult> {
  const lane = typeof priority === 'boolean' ? decodeLane(priority) : priority
  return run({ id: nextId++, op: 'pcm', blob, durationS, fromS, toS }, lane) as Promise<DemuxResult>
}

/** Whole file peaks, computed off the main thread without holding the sound. */
export function peaksOffThread(blob: Blob, durationS: number, buckets: number): Promise<PeaksResult> {
  return run({ id: nextId++, op: 'peaks', blob, durationS, buckets }) as Promise<PeaksResult>
}
