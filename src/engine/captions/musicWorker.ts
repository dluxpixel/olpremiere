/// <reference lib="webworker" />
// Is this stretch of audio a person talking, or a song?
//
// Runs in its own worker for the same reason the Whisper one does: the model
// download and the inference must never touch the interface thread, and the
// transformers.js bundle is dynamic-imported HERE so the main bundle stays lean.
//
// ⛔ IT ONLY EVER RETURNS SCORES. Every decision about which words survive is
// made by `musicGate.ts`, which is pure and fully tested. A worker that also
// decided would put the rule somewhere no unit test can reach it.
//
// The model and what it measured: `musicGate.ts`, and the table in
// `_verify/ast-music-probe.mjs`.

import { speechScore } from './musicGate'

/** AudioSet, 527 classes, and the export transformers.js publishes for it. */
export const MUSIC_MODEL = 'Xenova/ast-finetuned-audioset-10-10-0.4593'

export interface MusicRequest {
  /** Mono PCM at 16 kHz, one whole clip. Absent on a warm. */
  pcm?: Float32Array
  /** Seconds per window. */
  windowS: number
  sampleRate: number
  /** Load the model and stop, so the first real run does not pay for it. */
  warm?: boolean
}

export type MusicResponse =
  | { ok: true; scores: Float32Array; windowS: number }
  | { ok: true; warmed: true }
  | { ok: false; error: string }

type Classifier = (pcm: Float32Array, opts: { top_k: number }) => Promise<{ label: string; score: number }[]>

let classifier: Classifier | null = null
let loading: Promise<Classifier> | null = null

async function load(): Promise<Classifier> {
  if (classifier) return classifier
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import('@huggingface/transformers')
      // ⛔ q8, NOT the default. The full export is about four times the size for
      // a decision that is separated by a factor of twenty, and he pays the
      // download once on a machine that has already taken 480 MB of Whisper.
      const p = (await pipeline('audio-classification', MUSIC_MODEL, { dtype: 'q8' })) as unknown as Classifier
      classifier = p
      return p
    })()
  }
  return loading
}

/**
 * ⛔ `top_k` HAS TO BE THE WHOLE 527 WHEREVER THIS WORKER CALLS THE MODEL. The
 * default returns the top five, and on a clip where music wins every one of
 * those five, Speech is simply absent from the result and reads as zero. That
 * is a silent vote to delete his words.
 *
 * The scoring itself is `musicGate.speechScore`, imported rather than copied:
 * this file had its own second copy for an afternoon, which is two places to
 * change and one place to forget.
 */

self.onmessage = async (e: MessageEvent<MusicRequest>) => {
  const req = e.data
  try {
    const clf = await load()
    if (req.warm || !req.pcm) {
      ;(self as unknown as Worker).postMessage({ ok: true, warmed: true } satisfies MusicResponse)
      return
    }
    const { pcm, sampleRate, windowS } = req
    const size = Math.round(windowS * sampleRate)
    const whole = size > 0 && pcm.length >= size
    const count = whole ? Math.floor(pcm.length / size) : 1
    const scores = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const slice = whole ? pcm.subarray(i * size, (i + 1) * size) : pcm
      scores[i] = speechScore(await clf(slice, { top_k: 527 }))
    }
    ;(self as unknown as Worker).postMessage(
      { ok: true, scores, windowS: whole ? windowS : pcm.length / sampleRate } satisfies MusicResponse,
      // Transferred, like the Whisper worker's reply: the caller is the only
      // reader and copying a score per five seconds is pointless work.
      [scores.buffer],
    )
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies MusicResponse)
  }
}
