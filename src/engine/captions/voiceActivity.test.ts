// The DELETION RULE, tested without the model.
//
// Every case here feeds a synthesised probability track, so what is under test
// is the decision, not RNNoise. That matters: the decision is the part that can
// cost him work. A junk caption over his intro music is annoying, a missing
// caption over a sentence he really said is the app losing his edit, so most of
// these tests are about REFUSING to delete.

import { describe, expect, it, vi } from 'vitest'
import {
  MIN_ANALYSED_CLIP_S,
  VOICE_SAMPLE_RATE,
  dropWordsWithoutVoice,
  voiceTrackFromPcm,
  type VoiceTrack,
} from './voiceActivity'
import { PCM_SCALE, type DenoiseEngine } from '../denoise'
import type { TranscribedWord } from './transcribe'

/** RNNoise's real frame: 480 samples at 48 kHz, so 10 ms. */
const FRAME_S = 480 / VOICE_SAMPLE_RATE

/** A clip of `totalS` that is quiet everywhere except the given voiced spans. */
const track = (totalS: number, voiced: [number, number][]): VoiceTrack => {
  const probs = new Float32Array(Math.round(totalS / FRAME_S))
  for (const [fromS, toS] of voiced) {
    for (let f = Math.round(fromS / FRAME_S); f < Math.round(toS / FRAME_S); f++) probs[f] = 1
  }
  return { probs, frameS: FRAME_S, offsetS: 0, clipS: 0 }
}

const w = (text: string, startS: number, endS: number): TranscribedWord => ({ text, startS, endS })
const texts = (words: readonly TranscribedWord[]): string[] => words.map((x) => x.text)

describe('dropWordsWithoutVoice, the 1.0 s rule', () => {
  // Same clip, same words, same intro junk. The ONLY difference is 20 ms of
  // quiet, either side of the one second the rule asks for.
  const words = [w('yeah', 0.2, 0.5), w('so', 1.2, 1.5), w('anyway', 2.0, 2.3)]

  it('keeps a word sitting in a quiet run just UNDER a second', () => {
    const out = dropWordsWithoutVoice(words, track(6, [[0.99, 6]]))
    expect(texts(out)).toEqual(['yeah', 'so', 'anyway'])
  })

  it('drops one sitting in a quiet run just OVER a second', () => {
    const out = dropWordsWithoutVoice(words, track(6, [[1.01, 6]]))
    expect(texts(out)).toEqual(['so', 'anyway'])
  })
})

describe('dropWordsWithoutVoice, the 300 ms margins', () => {
  it('keeps a word straddling the edge of the quiet, where the model cannot be sure', () => {
    // Quiet to 2.0 s. "half" starts inside it and runs out the other side, so
    // the run never reaches 300 ms past its end and the word is untouchable.
    const out = dropWordsWithoutVoice(
      [w('junk', 0.4, 0.7), w('half', 1.8, 2.1), w('mine', 2.5, 2.8)],
      track(6, [[2, 6]]),
    )
    expect(texts(out)).toEqual(['half', 'mine'])
  })

  it('keeps a word with a surviving neighbour within 300 ms, and only that one', () => {
    const bed = track(8, [[2.5, 8]])
    // "edge" survives on its own (the quiet stops before its 300 ms margin), so
    // it is a live neighbour for whatever sits just before it.
    const close = dropWordsWithoutVoice([w('close', 2.0, 2.15), w('edge', 2.3, 2.6), w('mine', 3, 3.3)], bed)
    expect(texts(close)).toEqual(['close', 'edge', 'mine'])

    // The same word a second earlier has nothing near it and goes.
    const far = dropWordsWithoutVoice([w('far', 1.0, 1.3), w('edge', 2.3, 2.6), w('mine', 3, 3.3)], bed)
    expect(texts(far)).toEqual(['edge', 'mine'])
  })
})

describe('dropWordsWithoutVoice, what it refuses to do', () => {
  // Two seconds of quiet in the middle of a clip he is talking over.
  const bed = track(10, [
    [0, 3],
    [5, 10],
  ])

  it('never drops a lone word in the middle of a sentence, whatever the audio says', () => {
    const out = dropWordsWithoutVoice([w('and', 2.0, 2.5), w('then', 3.8, 4.1), w('boom', 5.5, 6.0)], bed)
    expect(texts(out)).toEqual(['and', 'then', 'boom'])
  })

  it('does drop a RUN of words in the same silence, which is what junk looks like', () => {
    const out = dropWordsWithoutVoice(
      [w('and', 2.0, 2.5), w('la', 3.5, 3.8), w('la', 4.0, 4.3), w('boom', 5.5, 6.0)],
      bed,
    )
    expect(texts(out)).toEqual(['and', 'boom'])
  })

  it('leaves a clip too short to judge completely alone', () => {
    const short = track(MIN_ANALYSED_CLIP_S - 1, [[1.9, 2]])
    expect(texts(dropWordsWithoutVoice([w('hey', 0.3, 0.6)], short))).toEqual(['hey'])
  })

  it('refuses to act when the model heard no voice ANYWHERE, because that is a broken model', () => {
    // Real instrumental music still clears 0.9 on about 4% of its frames. A flat
    // zero means the analysis is wrong, and a wrong analysis would otherwise
    // delete the whole transcript in one pass.
    const dead = track(6, [])
    const said = [w('so', 1.0, 1.3), w('I', 1.4, 1.5), w('mined', 3.0, 3.4)]
    expect(texts(dropWordsWithoutVoice(said, dead))).toEqual(['so', 'I', 'mined'])
  })

  it('refuses to take the MAJORITY of a transcript, however sure the model is', () => {
    // The measurement that forced this guard: dry synthetic speech, talking from
    // end to end, reported one unbroken 18.7 s stretch of "no voice" out of 20 s.
    // Every word here is deletable on the audio and there is nothing to rescue
    // them, so only the trim-only rule stands between him and an empty caption
    // track. Note the blip of voice: this is NOT the broken-model guard firing.
    const wrong = track(20, [[10, 10.05]])
    const said = [w('so', 1, 1.3), w('I', 3, 3.3), w('went', 5, 5.3), w('mining', 15, 15.3)]
    expect(texts(dropWordsWithoutVoice(said, wrong))).toEqual(['so', 'I', 'went', 'mining'])
  })

  it('returns the words untouched when there is no track at all', () => {
    const empty: VoiceTrack = { probs: new Float32Array(0), frameS: FRAME_S, offsetS: 0, clipS: 0 }
    expect(texts(dropWordsWithoutVoice([w('hey', 0, 0.4)], empty))).toEqual(['hey'])
    expect(dropWordsWithoutVoice([], track(6, [[0, 6]]))).toEqual([])
  })
})

describe('voiceTrackFromPcm', () => {
  /** Reports the frame's first sample as its probability, so scaling is visible. */
  const fakeEngine = (destroyed: { yes: boolean }): DenoiseEngine => ({
    frameSize: 4,
    createDenoiseState: () => ({
      processFrame: (frame: Float32Array) => frame[0]! / PCM_SCALE,
      destroy: () => {
        destroyed.yes = true
      },
    }),
  })

  it('reads one probability per WHOLE frame and scales the PCM the way RNNoise expects', async () => {
    const destroyed = { yes: false }
    const pcm = Float32Array.from([0.1, 0, 0, 0, 0.9, 0, 0, 0, 0.5, 0]) // 2 whole frames + a stub
    const out = await voiceTrackFromPcm(fakeEngine(destroyed), pcm, 8000)
    expect(Array.from(out!.probs).map((p) => Number(p.toFixed(3)))).toEqual([0.1, 0.9])
    expect(out!.frameS).toBeCloseTo(4 / 8000, 9)
    expect(destroyed.yes).toBe(true)
  })

  it('lets the browser paint between slices instead of locking the UI for seconds', async () => {
    const onSlice = vi.fn(() => Promise.resolve())
    await voiceTrackFromPcm(fakeEngine({ yes: false }), new Float32Array(12), 8000, { sliceMs: 0, onSlice })
    expect(onSlice).toHaveBeenCalled()
  })

  it('gives up mid-analysis when the caption run is cancelled', async () => {
    const signal = { aborted: false }
    const out = await voiceTrackFromPcm(fakeEngine({ yes: false }), new Float32Array(400), 8000, {
      sliceMs: 0,
      signal,
      onSlice: () => {
        signal.aborted = true
        return Promise.resolve()
      },
    })
    expect(out).toBeNull()
  })
})

// ⛔ THE FIX FOR HIS IMAGINARY WORDS, 2026-08-12. Measured on his own project:
// 30 of 44 clips under three seconds, median 1.43 s, so `MIN_ANALYSED_CLIP_S`
// handed every word straight back on two thirds of his timeline and whatever the
// recogniser invented over the music stayed in. The window is widened with the
// recording either side of the cut instead of the floor being lowered.
describe('a clip judged on the recording around it', () => {
  // 12s analysed: a music bed everywhere except 7.0-9.0 where he speaks. The
  // clip starts 5.6s into that window, so clip time t is window time t + 5.6.
  const padded = (offsetS: number): VoiceTrack => ({ ...track(12, [[7, 9]]), offsetS })
  const line = [w('imagined', 0, 0.3), w('i', 1.5, 1.8), w('am', 2.0, 2.3), w('here', 2.6, 2.9)]

  it('a short clip is now long enough to judge, and the junk over the music goes', () => {
    expect(texts(dropWordsWithoutVoice(line, padded(5.6)))).toEqual(['i', 'am', 'here'])
  })

  // ⛔ Throw the offset away and every word is compared against the wrong moment.
  // Here that puts the whole line in the bed, more than half of it wants
  // deleting, and the never-gut-a-clip guard hands it all back: the filter goes
  // silently useless rather than loudly wrong. That is what offsetS prevents.
  it('the offset is applied, not ignored', () => {
    expect(texts(dropWordsWithoutVoice(line, padded(0)))).toEqual(['imagined', 'i', 'am', 'here'])
  })

  it('an unpadded track still behaves exactly as it did', () => {
    const plain = track(6, [[0, 6]])
    expect(plain.offsetS).toBe(0)
    expect(texts(dropWordsWithoutVoice([w('hey', 1, 1.4)], plain))).toEqual(['hey'])
  })
})
