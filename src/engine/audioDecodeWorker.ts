// Reads sound off the main thread. See audioDemux.ts for why.
//
// One request at a time per worker: the client keeps a small pool, and a read is
// mostly waiting on the decoder, so a queue here would only hide the backlog.

import { demuxAudio, demuxPeaks } from './audioDemux'
import type { AudioWorkerRequest, AudioWorkerResponse } from './audioDecodeClient'

const post = (msg: AudioWorkerResponse, transfer: Transferable[] = []): void =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent<AudioWorkerRequest>) => {
  const req = e.data
  try {
    if (req.op === 'peaks') {
      const r = await demuxPeaks(req.blob, req.durationS, req.buckets)
      if (r.kind === 'peaks') post({ id: req.id, ok: true, result: r }, [r.peaks.buffer])
      else post({ id: req.id, ok: true, result: r })
      return
    }
    const r = await demuxAudio(req.blob, { durationS: req.durationS, fromS: req.fromS, toS: req.toS })
    if (r.kind === 'pcm') post({ id: req.id, ok: true, result: r }, r.planes.map((p) => p.buffer))
    else post({ id: req.id, ok: true, result: r })
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
