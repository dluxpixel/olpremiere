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
  PAUSE_MIN_S,
  VOICE_SAMPLE_RATE,
  dropWordsWithoutVoice,
  trimWordsToVoice,
  voiceTrackFromPcm,
  type VoiceTrack,
} from './voiceActivity'
import { AUTO_CAPTION_OPTIONS, chunkWords } from './captions'
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

// ⛔ HIS PAUSES SPLIT HIS CAPTIONS, 2026-09-28. His words: "sometimes I just
// take a big pause between the words, and it still groups them together."
// The chunker already breaks on any gap, but the recogniser runs a word's end
// through the silence after it, so the gap it saw was 0.00 s. Every case here
// is the recogniser's timings plus a voice track that shows the silence.
describe('trimWordsToVoice: a pause the recogniser swallowed becomes a real gap', () => {
  const spans = (words: readonly TranscribedWord[]): [number, number][] =>
    words.map((x) => [Number(x.startS.toFixed(3)), Number(x.endS.toFixed(3))])
  const captions = (words: readonly TranscribedWord[]): string[] =>
    chunkWords([...words], AUTO_CAPTION_OPTIONS).map((c) => c.text)

  it('a 0.6 s pause inside a word\'s end splits "i | found", which used to be one caption', () => {
    // He says "i", stops for 0.6 s, then "found it." The recogniser ran "i" to 0.75.
    const heard = [w('i', 0, 0.75), w('found', 0.75, 1.0), w('it.', 1.0, 1.3)]
    const voice = track(3, [
      [0, 0.15],
      [0.75, 1.3],
    ])
    // The bug, pinned so this test cannot pass by accident: as the recogniser
    // timed it, the chunker saw no pause and welded the two.
    expect(captions(heard)[0]).toBe('i found')

    const trimmed = trimWordsToVoice(heard, voice)
    expect(spans(trimmed)).toEqual([
      [0, 0.15],
      [0.75, 1.0],
      [1.0, 1.3],
    ])
    const chunks = chunkWords(trimmed, AUTO_CAPTION_OPTIONS)
    expect(chunks.map((c) => c.text)).toEqual(['i', 'found', 'it.'])
    // And "i" gets off the screen when he stops, not when he starts again.
    expect(chunks[0]!.endS).toBeLessThan(0.75 - 0.4)
  })

  it('a 1.5 s pause inside a word\'s end: separate captions, and the first one does not sit through it', () => {
    const heard = [w('so', 0, 1.8), w('good', 1.8, 2.1), w('right?', 2.1, 2.4)]
    const voice = track(3, [
      [0, 0.3],
      [1.8, 2.4],
    ])
    const trimmed = trimWordsToVoice(heard, voice)
    expect(spans(trimmed)[0]).toEqual([0, 0.3])
    const chunks = chunkWords(trimmed, AUTO_CAPTION_OPTIONS)
    expect(chunks[0]!.text).toBe('so')
    expect(chunks[1]!.text.startsWith('good')).toBe(true)
    // Held only holdS past his voice. As heard, "so" stayed up for 1.3 s of silence.
    expect(chunks[0]!.endS).toBeCloseTo(0.3 + AUTO_CAPTION_OPTIONS.holdS, 6)
    expect(chunkWords(heard, AUTO_CAPTION_OPTIONS)[0]!.endS).toBeGreaterThan(1.2)
  })

  it('a 1.5 s pause the recogniser split between two words: the second waits for his voice', () => {
    // "and" runs into the silence, and "then" starts early inside it.
    const heard = [w('and', 0, 0.9), w('then', 0.9, 2.1), w('boom.', 2.1, 2.5)]
    const voice = track(3, [
      [0, 0.3],
      [1.8, 2.5],
    ])
    const trimmed = trimWordsToVoice(heard, voice)
    expect(spans(trimmed).slice(0, 2)).toEqual([
      [0, 0.3],
      [1.8, 2.1],
    ])
    const chunks = chunkWords(trimmed, AUTO_CAPTION_OPTIONS)
    expect(chunks[0]!.text).toBe('and')
    // As heard, "then" was on screen from 0.9 s, most of a second before he said it.
    const then = chunks.find((c) => c.text.startsWith('then'))!
    expect(then.startS).toBeCloseTo(1.8, 6)
  })

  it('words said with no pause between them are untouched and still pair up exactly as before', () => {
    const heard = [w('go', 0, 0.25), w('now', 0.25, 0.5), w('okay.', 0.5, 1.0)]
    const trimmed = trimWordsToVoice(heard, track(3, [[0, 1.0]]))
    expect(trimmed).toEqual(heard)
    expect(captions(trimmed)).toEqual(['go now', 'okay.'])
  })

  it("keeps his 'and like' pair and still cuts the pause 'like' swallowed (his take 13)", () => {
    // Measured: "like" came back 1.5 s long, running through his pause before "for more".
    const heard = [w('subscribe', 34.34, 34.76), w('and', 34.76, 35.0), w('like', 35.0, 36.5), w('for', 36.5, 36.66), w('more', 36.66, 37.14)]
    const voice = track(38, [
      [34.34, 35.3],
      [36.5, 37.14],
    ])
    const trimmed = trimWordsToVoice(heard, voice)
    expect(spans(trimmed)[2]).toEqual([35.0, 35.3])
    // Only the word that swallowed the pause changed.
    expect(spans(trimmed).filter((_, i) => i !== 2)).toEqual(spans(heard).filter((_, i) => i !== 2))
    expect(captions(trimmed).slice(0, 2)).toEqual(['subscribe', 'and like'])
  })

  it('a word whose voice never stops is left alone, however long the recogniser made it', () => {
    const heard = [w('invisibility', 0, 1.3), w('potion', 1.3, 1.7)]
    expect(trimWordsToVoice(heard, track(3, [[0, 1.7]]))).toEqual(heard)
  })

  it('a quiet dip shorter than a pause is not a pause', () => {
    const dip = PAUSE_MIN_S - 0.05
    const heard = [w('cats', 0, 0.5), w('sit', 0.5, 0.9)]
    const voice = track(3, [
      [0, 0.4],
      [0.4 + dip, 0.9],
    ])
    expect(trimWordsToVoice(heard, voice)).toEqual(heard)
  })

  it('never cuts a word short when the next word shows no voice, because then nobody knows where it starts', () => {
    const heard = [w('so', 0, 0.8), w('um', 0.8, 1.1), w('yeah', 1.1, 1.4)]
    const voice = track(3, [
      [0, 0.2],
      [1.1, 1.4],
    ])
    expect(spans(trimWordsToVoice(heard, voice))[0]).toEqual([0, 0.8])
  })

  it('the first word waits for his voice, and the last word leaves with it', () => {
    const heard = [w('hey', 0, 0.8), w('there', 0.8, 1.1), w('bye', 1.1, 2.5)]
    const voice = track(3, [[0.5, 1.4]])
    expect(spans(trimWordsToVoice(heard, voice))).toEqual([
      [0.5, 0.8],
      [0.8, 1.1],
      [1.1, 1.4],
    ])
  })

  it('changes nothing when the detector cannot hear this voice in most of the words', () => {
    // A dry voice the model is nearly deaf to (see dropWordsWithoutVoice): two
    // blips in five words. Without this guard the blips would be read as a pause
    // between "a" and "b" in the middle of continuous speech.
    const heard = [w('a', 0, 0.5), w('b', 0.5, 1.0), w('c', 1.0, 1.5), w('d', 1.5, 2.0), w('e', 2.0, 2.5)]
    const voice = track(3, [
      [0, 0.05],
      [0.9, 0.95],
    ])
    expect(trimWordsToVoice(heard, voice)).toEqual(heard)
  })

  it('reads the recording around the cut at the right moment (offsetS)', () => {
    // The same 0.6 s pause as above, analysed with 5.6 s of recording before the clip.
    const heard = [w('i', 0, 0.75), w('found', 0.75, 1.0), w('it.', 1.0, 1.3)]
    const voice: VoiceTrack = {
      ...track(9, [
        [5.6, 5.75],
        [6.35, 6.9],
      ]),
      offsetS: 5.6,
    }
    expect(spans(trimWordsToVoice(heard, voice))[0]).toEqual([0, 0.15])
  })

  it('leaves the words alone with no track, and never touches the text or the order', () => {
    const empty: VoiceTrack = { probs: new Float32Array(0), frameS: FRAME_S, offsetS: 0, clipS: 0 }
    const heard = [w('found', 0.75, 1.0), w('i', 0, 0.75)]
    expect(trimWordsToVoice(heard, empty)).toEqual(heard)
    expect(trimWordsToVoice([], track(3, [[0, 3]]))).toEqual([])
    // Out of time order, as the recogniser emits at a seam: trimmed in time order, returned in its own.
    const out = trimWordsToVoice(heard, track(3, [
      [0, 0.15],
      [0.75, 1.0],
    ]))
    expect(texts(out)).toEqual(['found', 'i'])
    expect(spans(out)).toEqual([
      [0.75, 1.0],
      [0, 0.15],
    ])
  })

  it('over 2000 random takes it only ever shortens a word: no word lost, emptied, reordered, or pulled closer', () => {
    let seed = 7
    const r = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const timeOrder = (ws: readonly TranscribedWord[]): number[] =>
      ws.map((_, i) => i).sort((a, b) => ws[a]!.startS - ws[b]!.startS)
    for (let take = 0; take < 2000; take++) {
      const heard: TranscribedWord[] = []
      let t = r() * 0.5
      const count = 1 + Math.floor(r() * 12)
      for (let k = 0; k < count; k++) {
        const dur = 0.05 + r() * r() * 1.8
        heard.push(w(`w${k}`, t, t + dur))
        // Mostly tiling like his real audio, some pauses, and now and then an
        // OVERLAP, which the recogniser really does hand back at a chunk seam.
        const step = r()
        t += step < 0.6 ? dur : step < 0.9 ? dur + r() * 0.8 : dur * r()
      }
      const voiced: [number, number][] = []
      for (let v = r() * 0.3; v < t + 1; ) {
        const on = r() * 0.8
        voiced.push([v, v + on])
        v += on + r() * r() * 1.5
      }
      const out = trimWordsToVoice(heard, track(t + 2, voiced))
      expect(texts(out)).toEqual(texts(heard))
      // The highlight picker and the chunker read the words in time order, so it must not change.
      expect(timeOrder(out)).toEqual(timeOrder(heard))
      for (let k = 0; k < out.length; k++) {
        expect(out[k]!.startS).toBeGreaterThanOrEqual(heard[k]!.startS - 1e-9)
        expect(out[k]!.endS).toBeLessThanOrEqual(heard[k]!.endS + 1e-9)
        expect(out[k]!.endS).toBeGreaterThan(out[k]!.startS)
        // A gap can only widen, so a pair the recogniser split stays split.
        if (k > 0) {
          expect(out[k]!.startS - out[k - 1]!.endS).toBeGreaterThanOrEqual(heard[k]!.startS - heard[k - 1]!.endS - 1e-9)
        }
      }
    }
  })
})
