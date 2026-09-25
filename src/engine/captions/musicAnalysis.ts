// Driving the song classifier for one clip: get the audio, ask the worker, hand
// back a score track. The rule that acts on those scores lives in `musicGate.ts`
// and is pure; this file is the half that touches a worker and a decoder.
//
// ⛔ EVERY FAILURE HERE RETURNS NULL, AND NULL KEEPS EVERY WORD. A blocked
// worker, an undecodable clip, a cancelled run and a model that will not load
// all mean the same thing: no opinion. `dropWordsInMusic` treats no opinion as a
// vote for him, which is the only safe direction for a filter that deletes.

import type { Clip, MediaAsset } from '../types'
import { extractClipPcmAt } from './transcribe'
import { WINDOW_S, type SpeechTrack } from './musicGate'
import type { MusicRequest, MusicResponse } from './musicWorker'

/** What the classifier was measured at, and what AudioSet models expect. */
export const MUSIC_SAMPLE_RATE = 16000

/**
 * How long a request may run before it is given up on and the worker torn
 * down. The same shape as transcribe.ts's Whisper watchdog, and for the same
 * reason: this worker runs the identical class of wasm/ML inference, load
 * then repeated classifier calls, and a hung inference does not throw. With
 * no watchdog nothing downstream would ever resolve: `wordsForClip` awaits
 * this AFTER Whisper already finished, so a stuck classifier would leave the
 * progress pill stuck and every later caption run reporting the same clip is
 * still being listened to, recoverable only by reloading the app.
 *
 * Generous on purpose, so it can only ever fire on a genuine fault: model
 * load is the expensive part and is paid at most once per session (the
 * classifier is cached at module scope in musicWorker.ts), and inference
 * itself is windowed at WINDOW_S seconds a call.
 */
const MUSIC_TIMEOUT_FLOOR_MS = 60_000
const MUSIC_TIMEOUT_MS_PER_AUDIO_SECOND = 4_000

let worker: Worker | null = null
/** Ticks once per request, so a reply can be matched to the run that asked for it. */
let nextRequestId = 1

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./musicWorker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

/** Throw the worker away, so a corrupted pipeline is rebuilt on the next run. */
export function killMusicWorker(): void {
  worker?.terminate()
  worker = null
}

/** Load the model without doing any work, so the first caption run is not the one that waits. */
export function warmMusicModel(): void {
  try {
    getWorker().postMessage({
      warm: true,
      windowS: WINDOW_S,
      sampleRate: MUSIC_SAMPLE_RATE,
      id: nextRequestId++,
    } satisfies MusicRequest)
  } catch {
    // A CSP that blocks workers, or no worker support. The gate simply never
    // has an opinion, and every word survives.
  }
}

/**
 * Score one clip's own audio, window by window.
 *
 * ⛔ THE CLIP'S OWN SLICE, WITH NO PADDING AROUND IT, and that is the opposite
 * of what the voice detector next door needs. `voiceActivity` widens its window
 * with the recording either side of the cut because its statistic is meaningless
 * on a short sample. This one does not measure a fraction of anything: it asks a
 * classifier what a window sounds like, and a 1.4 second clip of pure song
 * sounds exactly like a song. Borrowing audio from outside the clip would let
 * the sentence he says NEXT keep the captions on the music before it.
 */
export async function musicTrackForClip(
  asset: MediaAsset,
  clip: Clip,
  signal?: { aborted: boolean },
): Promise<SpeechTrack | null> {
  let pcm: Float32Array
  try {
    pcm = await extractClipPcmAt(asset, clip, MUSIC_SAMPLE_RATE)
  } catch {
    return null
  }
  // Under a second there is not enough audio for the model to say anything, and
  // guessing on a fragment is how a real word gets deleted.
  if (signal?.aborted || pcm.length < MUSIC_SAMPLE_RATE) return null

  let w: Worker
  try {
    w = getWorker()
  } catch {
    return null
  }

  // ONE ID PER RUN, BECAUSE THERE IS ONE WORKER FOR THE WHOLE APP. Every
  // caller listens on the same port, so without an id a reply is handed to every
  // listener alive. A cancelled run keeps its listener until its OWN reply lands,
  // so the run he started next read the cancelled clip's scores: words kept or
  // dropped on the strength of music in a completely different clip.
  const id = nextRequestId++
  return new Promise<SpeechTrack | null>((resolve) => {
    let settled = false
    const done = (value: SpeechTrack | null) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      resolve(value)
    }
    // No opinion is always safe here (see the file header), so a run that
    // stopped making progress gives up the same way the Whisper one does:
    // terminate, which is what actually hands the memory back, and resolve
    // null rather than leave the caller waiting forever.
    const watchdog = setTimeout(
      () => {
        killMusicWorker()
        done(null)
      },
      MUSIC_TIMEOUT_FLOOR_MS + (pcm.length / MUSIC_SAMPLE_RATE) * MUSIC_TIMEOUT_MS_PER_AUDIO_SECOND,
    )
    const onMessage = (e: MessageEvent<MusicResponse>) => {
      const r = e.data
      if (r.id !== id) return // another run's reply, or a warm
      if (!r.ok) {
        // A hard error may have left the pipeline half built.
        killMusicWorker()
        done(null)
        return
      }
      if ('warmed' in r) return // a warm this run did not ask for
      done(signal?.aborted ? null : { scores: r.scores, windowS: r.windowS })
    }
    const onError = () => {
      killMusicWorker()
      done(null)
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    try {
      // Transferred: the caller has no use for this copy afterwards, and a clip
      // of PCM is megabytes.
      w.postMessage({ pcm, windowS: WINDOW_S, sampleRate: MUSIC_SAMPLE_RATE, id } satisfies MusicRequest, [
        pcm.buffer,
      ])
    } catch {
      done(null)
    }
  })
}
