// Runs RNNoise off the main thread. See denoiseClient.ts for why.
//
// The model's whole pass over a take is one long loop with nothing to wait on,
// so it is the one thing here that must never run where the picture is drawn.

import { denoiseAtRate, ensureRnnoise } from './denoise'

export interface DenoiseRequest {
  id: number
  /** One array per channel. Transferred in, so they are this worker's now. */
  channels: Float32Array[]
  sampleRate: number
}

export type DenoiseResponse = { id: number; ok: true; channels: Float32Array[] } | { id: number; ok: false; error: string }

const post = (msg: DenoiseResponse, transfer: Transferable[] = []): void =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent<DenoiseRequest>) => {
  const req = e.data
  try {
    const engine = await ensureRnnoise()
    const channels = req.channels.map((c) => denoiseAtRate(engine, c, req.sampleRate))
    post({ id: req.id, ok: true, channels }, channels.map((c) => c.buffer))
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
