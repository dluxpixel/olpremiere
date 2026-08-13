// His words, 2026-08-12: "it still sometimes even adds imaginary words, maybe
// even from the music."
//
// ⛔ MEASURED FIRST. His project is 44 clips, 30 of them under three seconds,
// median 1.43 s. `dropWordsWithoutVoice` hands every word back untouched when the
// analysed audio is shorter than MIN_ANALYSED_CLIP_S, so **the filter that
// removes imagined words did nothing on two thirds of his timeline.**
//
// The floor is right and stays: a short window gives a meaningless statistic, and
// every guard in voiceActivity.ts points one way on purpose, it may only TRIM,
// never delete a real sentence. The fix is to give it MORE AUDIO instead of a
// lower bar: a 1.4 s clip is cut out of a 278 s recording, and the audio either
// side of the cut is right there.

import { describe, expect, it } from 'vitest'
import { contextWindowFor, VOICE_CONTEXT_TARGET_S } from './voiceContext'

describe('contextWindowFor', () => {
  const src = 278

  it('pads a short clip out to something worth measuring', () => {
    const w = contextWindowFor(10, 11.4, src)
    expect(w.toS - w.fromS).toBeCloseTo(VOICE_CONTEXT_TARGET_S, 6)
    // The clip sits in the middle of what gets analysed.
    expect(w.fromS).toBeLessThan(10)
    expect(w.toS).toBeGreaterThan(11.4)
    // And the offset says where the clip starts inside that window, which is what
    // maps a word's time onto the right frame.
    expect(w.offsetS).toBeCloseTo(10 - w.fromS, 6)
  })

  it('leaves a clip that is already long enough completely alone', () => {
    const w = contextWindowFor(30, 54, src)
    expect(w).toEqual({ fromS: 30, toS: 54, offsetS: 0, clipS: 24 })
  })

  // ⛔ There is no audio before zero, and asking for some would shift every word
  // by an amount that does not exist.
  it('cannot reach back past the start of the recording', () => {
    const w = contextWindowFor(0.2, 1.6, src)
    expect(w.fromS).toBe(0)
    expect(w.offsetS).toBeCloseTo(0.2, 6)
    // It takes what it could not get on the left from the right instead.
    expect(w.toS - w.fromS).toBeCloseTo(VOICE_CONTEXT_TARGET_S, 6)
  })

  it('cannot reach past the end of the recording either', () => {
    const w = contextWindowFor(src - 1, src, src)
    expect(w.toS).toBe(src)
    expect(w.toS - w.fromS).toBeCloseTo(VOICE_CONTEXT_TARGET_S, 6)
  })

  // A recording SHORTER than the target: take all of it and no more.
  it('never invents audio a short recording does not have', () => {
    const w = contextWindowFor(1, 2, 4)
    expect(w).toEqual({ fromS: 0, toS: 4, offsetS: 1, clipS: 1 })
  })

  it('is a no-op when the clip already spans the whole recording', () => {
    expect(contextWindowFor(0, 4, 4)).toEqual({ fromS: 0, toS: 4, offsetS: 0, clipS: 4 })
  })

  // The window is BOUNDED, so a caption sweep cannot get slower per clip as the
  // source gets longer: voice analysis costs about 77 ms per second of audio.
  it('never analyses more than the target for a short clip', () => {
    for (const [a, b] of [
      [5, 5.34],
      [100, 101.4],
      [200, 203],
    ]) {
      const w = contextWindowFor(a, b, src)
      expect(w.toS - w.fromS).toBeLessThanOrEqual(VOICE_CONTEXT_TARGET_S + 1e-6)
    }
  })
})
