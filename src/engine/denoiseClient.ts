// The main thread's side of denoiseWorker.ts.
//
// ⛔ NOISE REDUCTION FROZE THE WHOLE APP, EVERY LAUNCH. The model ran over the
// whole take on the main thread: 77 ms of work per second of audio per channel,
// measured in chromium, so a 2 minute voiceover with noise reduction on stopped
// the picture, the meter and the mouse for about 9 s at the first Play, and
// again after every restart. The same pass runs here in a worker now.
//
// Where there is no Worker (unit tests, an old engine) or the worker cannot
// start, this says so (null) and the caller does the pass itself, so the toggle
// never stops working because a thread could not be started.

import type { DenoiseRequest, DenoiseResponse } from './denoiseWorker'

let worker: Worker | null = null
let broken = false
let nextId = 1
const jobs = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }>()

function getWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  if (typeof Worker === 'undefined') {
    broken = true
    return null
  }
  try {
    const w = new Worker(new URL('./denoiseWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<DenoiseResponse>) => {
      const job = jobs.get(e.data.id)
      if (!job) return
      jobs.delete(e.data.id)
      if (e.data.ok) job.resolve(e.data.channels)
      else job.reject(new Error(e.data.error))
    }
    w.onerror = (e) => {
      // A worker that cannot even load takes every later pass back to the
      // caller, and every pass it was holding is handed back to be done there.
      e.preventDefault()
      broken = true
      worker = null
      w.terminate()
      for (const job of jobs.values()) job.reject(new Error('noise reduction worker failed'))
      jobs.clear()
    }
    worker = w
    return w
  } catch {
    broken = true
    return null
  }
}

/**
 * RNNoise over every channel, in the worker. Null when no worker can run here.
 *
 * The channels are COPIED in: they are the decoded buffer the mixers play the
 * dry sound from, and transferring them would empty it.
 */
export function denoiseOffThread(channels: readonly Float32Array[], sampleRate: number): Promise<Float32Array[]> | null {
  const w = getWorker()
  if (!w) return null
  const id = nextId++
  const copies = channels.map((c) => c.slice())
  return new Promise<Float32Array[]>((resolve, reject) => {
    jobs.set(id, { resolve, reject })
    w.postMessage({ id, channels: copies, sampleRate } satisfies DenoiseRequest, copies.map((c) => c.buffer))
  })
}
