// When a word is said, tested without the model.
//
// The numbers these rules were set from came off his own takes (wordTiming.ts).
// What is under test here is the decisions: how far a word may move, which
// edge it may move onto, and that no word is ever lost or run into another.

import { describe, expect, it } from 'vitest'
import {
  DIP_DEPTH_DB,
  DIP_ENVELOPE_HOP_S,
  ONSET_QUIET_S,
  ONSET_REACH_S,
  correctWordLag,
  meetAtDips,
  snapOnsetsToVoice,
} from './wordTiming'
import type { VoiceTrack } from './voiceActivity'
import type { TranscribedWord } from './transcribe'

const FRAME_S = 0.01
/** A clip of `totalS` that is quiet everywhere except the given voiced spans. */
const track = (totalS: number, voiced: [number, number][], offsetS = 0): VoiceTrack => {
  const probs = new Float32Array(Math.round(totalS / FRAME_S))
  for (const [fromS, toS] of voiced) {
    for (let f = Math.round((fromS + offsetS) / FRAME_S); f < Math.round((toS + offsetS) / FRAME_S); f++) probs[f] = 1
  }
  return { probs, frameS: FRAME_S, offsetS, clipS: 0 }
}
const w = (text: string, startS: number, endS: number): TranscribedWord => ({ text, startS, endS })
const spans = (words: readonly TranscribedWord[]): [string, number, number][] =>
  words.map((x) => [x.text, Math.round(x.startS * 1000) / 1000, Math.round(x.endS * 1000) / 1000])

describe('correctWordLag', () => {
  it('pulls every word earlier by the lag, keeping its length', () => {
    const out = correctWordLag([w('so', 0.68, 1.0), w('nice', 1.0, 1.5)], 0.18)
    expect(spans(out)).toEqual([
      ['so', 0.5, 0.82],
      ['nice', 0.82, 1.32],
    ])
  })

  it('never moves a word before the clip began, and never loses one there', () => {
    const out = correctWordLag([w('a', 0.05, 0.12), w('b', 0.12, 0.3)], 0.18)
    expect(out[0]!.startS).toBe(0)
    expect(out[1]!.startS).toBe(0)
    for (const x of out) expect(x.endS).toBeGreaterThan(x.startS)
    expect(out[0]!.endS).toBeLessThanOrEqual(out[1]!.endS)
  })

  it('leaves the words alone when the model has no measured lag', () => {
    const words = [w('so', 0.68, 1.0)]
    expect(spans(correctWordLag(words, 0))).toEqual(spans(words))
  })

  it('does not change the words it was given', () => {
    const words = [w('so', 0.68, 1.0)]
    correctWordLag(words, 0.18)
    expect(words[0]!.startS).toBe(0.68)
  })

  // ⛔ The aligner's time comes from the sound, so it has none of the recogniser's
  // lag to take off. Pulling it back 0.18 s again would put it 0.18 s early.
  it('never moves a word the aligner timed, and keeps the flag', () => {
    const aligned: TranscribedWord = { text: 'so', startS: 0.68, endS: 1.0, aligned: true }
    const out = correctWordLag([aligned], 0.18)
    expect(spans(out)).toEqual([['so', 0.68, 1.0]])
    expect(out[0]!.aligned).toBe(true)
  })

  it('still corrects the words around an aligned one', () => {
    const out = correctWordLag(
      [w('a', 0.5, 0.8), { text: 'b', startS: 1.0, endS: 1.4, aligned: true }, w('c', 1.6, 2.0)],
      0.18,
    )
    expect(spans(out)).toEqual([
      ['a', 0.32, 0.62],
      ['b', 1.0, 1.4],
      ['c', 1.42, 1.82],
    ])
    expect(out.map((x) => x.aligned)).toEqual([undefined, true, undefined])
  })

  it('does not pull a late word back past the start of an aligned word before it', () => {
    // 'b' is the recogniser's and would land at 1.02 s, ahead of 'a', which the aligner put at 1.1 s.
    const out = correctWordLag([{ text: 'a', startS: 1.1, endS: 1.3, aligned: true }, w('b', 1.2, 1.5)], 0.18)
    expect(out[0]!.startS).toBe(1.1)
    expect(out[1]!.startS).toBeGreaterThanOrEqual(1.1)
  })
})

describe('snapOnsetsToVoice', () => {
  it('moves a phrase opening word back onto the moment his voice comes on', () => {
    // He starts at 1.0 after a breath; the corrected timestamp still says 1.08.
    const out = snapOnsetsToVoice([w('hi', 0.2, 0.6), w('there', 1.08, 1.5)], track(3, [[0.2, 0.55], [1.0, 1.5]]))
    expect(out[1]!.startS).toBeCloseTo(1.0, 6)
    // and the word before it ends where his voice went off, not where it ran on to
    expect(out[0]!.endS).toBeCloseTo(0.55, 6)
  })

  it('moves a word that starts in the quiet forward onto his voice', () => {
    const out = snapOnsetsToVoice([w('there', 0.9, 1.5)], track(3, [[1.05, 1.5]]))
    expect(out[0]!.startS).toBeCloseTo(1.05, 6)
  })

  it(`does not reach further than ${ONSET_REACH_S} s for it`, () => {
    const out = snapOnsetsToVoice([w('there', 1.4, 1.9)], track(3, [[1.0, 1.9]]))
    expect(out[0]!.startS).toBe(1.4)
  })

  it(`ignores a gap shorter than ${ONSET_QUIET_S} s, which is a consonant inside a word`, () => {
    const out = snapOnsetsToVoice([w('a', 0.2, 0.62), w('stop', 0.62, 1.2)], track(3, [[0.2, 0.6], [0.66, 1.2]]))
    expect(out[1]!.startS).toBe(0.62)
  })

  it('never puts a word before the one ahead of it has begun', () => {
    // the only voice edge near "b" is the one "a" starts on
    const out = snapOnsetsToVoice([w('a', 1.0, 1.1), w('b', 1.1, 1.6)], track(3, [[1.0, 1.6]]))
    expect(out[1]!.startS).toBe(1.1)
    expect(out[0]!.endS).toBe(1.1)
  })

  it('reads the voice at the clip, not at the padding the detector was given', () => {
    const out = snapOnsetsToVoice([w('there', 1.08, 1.5)], track(5, [[1.0, 1.5]], 2))
    expect(out[0]!.startS).toBeCloseTo(1.0, 6)
  })

  it('leaves everything as heard when the detector hears his voice in fewer than half the words', () => {
    const words = [w('a', 0.2, 0.5), w('b', 1.08, 1.5), w('c', 2.0, 2.4)]
    const out = snapOnsetsToVoice(words, track(3, [[1.0, 1.5]]))
    expect(spans(out)).toEqual(spans(words))
  })

  it('keeps the start of a word the aligner timed, and still ends the word before it where his voice went off', () => {
    // The same breath as the first test, but "there" was timed against the sound.
    const out = snapOnsetsToVoice([w('hi', 0.2, 0.6), { ...w('there', 1.08, 1.5), aligned: true }], track(3, [[0.2, 0.55], [1.0, 1.5]]))
    expect(out[1]!.startS).toBe(1.08)
    expect(out[1]!.aligned).toBe(true)
    expect(out[0]!.endS).toBeCloseTo(0.55, 6)
  })

  it('keeps the start of an aligned word that begins in the quiet too', () => {
    const out = snapOnsetsToVoice([{ ...w('there', 0.9, 1.5), aligned: true }], track(3, [[1.05, 1.5]]))
    expect(out[0]!.startS).toBe(0.9)
  })
})

/** Loudness per 10 ms: `level` dB everywhere, with dips to `dipDb` at the given times. */
const envelope = (totalS: number, level: number, dips: [number, number][], dipDb: number): Float32Array => {
  const n = Math.round(totalS / DIP_ENVELOPE_HOP_S)
  const env = new Float32Array(n).fill(10 ** (level / 20))
  for (const [fromS, toS] of dips) {
    for (let k = Math.round(fromS / DIP_ENVELOPE_HOP_S); k < Math.round(toS / DIP_ENVELOPE_HOP_S); k++) env[k] = 10 ** (dipDb / 20)
  }
  return env
}

describe('meetAtDips', () => {
  it('moves the boundary between two words he ran together onto the dip between them', () => {
    const env = envelope(2, -12, [[0.94, 0.97]], -12 - DIP_DEPTH_DB - 5)
    const out = meetAtDips([w('the', 0.5, 1.0), w('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
    expect(out[0]!.endS).toBeCloseTo(0.945, 6)
    expect(out[1]!.startS).toBeCloseTo(0.945, 6)
  })

  it('leaves a boundary with no clear dip where the recogniser put it', () => {
    const env = envelope(2, -12, [[0.94, 0.97]], -12 - DIP_DEPTH_DB + 4)
    const out = meetAtDips([w('the', 0.5, 1.0), w('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
    expect(out[1]!.startS).toBe(1.0)
  })

  it('does not look past its reach, nor move a pause', () => {
    const far = envelope(2, -12, [[0.8, 0.83]], -40)
    expect(meetAtDips([w('a', 0.5, 1.0), w('b', 1.0, 1.5)], far, DIP_ENVELOPE_HOP_S)[1]!.startS).toBe(1.0)
    const near = envelope(2, -12, [[0.94, 0.97]], -40)
    const paused = meetAtDips([w('a', 0.5, 0.9), w('b', 1.0, 1.5)], near, DIP_ENVELOPE_HOP_S)
    expect(spans(paused)).toEqual([
      ['a', 0.5, 0.9],
      ['b', 1.0, 1.5],
    ])
  })

  it('never squeezes a short word to nothing', () => {
    const env = envelope(2, -12, [[0.99, 1.01]], -40)
    const out = meetAtDips([w('a', 0.97, 1.0), w('b', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
    expect(out[0]!.endS - out[0]!.startS).toBeGreaterThanOrEqual(0.03 - 1e-9)
  })

  it('does nothing without loudness to read', () => {
    const words = [w('a', 0.5, 1.0), w('b', 1.0, 1.5)]
    expect(spans(meetAtDips(words, new Float32Array(0), DIP_ENVELOPE_HOP_S))).toEqual(spans(words))
  })

  describe('a boundary next to a word the aligner timed', () => {
    const env = envelope(2, -12, [[0.94, 0.97]], -12 - DIP_DEPTH_DB - 5)
    const aligned = (text: string, startS: number, endS: number): TranscribedWord => ({ text, startS, endS, aligned: true })

    it('stays where the aligner put it, whichever side the aligned word is on', () => {
      const both = meetAtDips([aligned('the', 0.5, 1.0), aligned('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
      expect(spans(both)).toEqual([
        ['the', 0.5, 1.0],
        ['strongest', 1.0, 1.5],
      ])
      const before = meetAtDips([aligned('the', 0.5, 1.0), w('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
      expect(before[1]!.startS).toBe(1.0)
      const after = meetAtDips([w('the', 0.5, 1.0), aligned('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
      expect(after[0]!.endS).toBe(1.0)
    })

    it('still moves a boundary between two words the aligner did not time', () => {
      const out = meetAtDips([aligned('a', 0.1, 0.4), w('the', 0.5, 1.0), w('strongest', 1.0, 1.5)], env, DIP_ENVELOPE_HOP_S)
      expect(out[1]!.endS).toBeCloseTo(0.945, 6)
      expect(out[2]!.startS).toBeCloseTo(0.945, 6)
      expect(out[0]!.aligned).toBe(true)
    })
  })
})
