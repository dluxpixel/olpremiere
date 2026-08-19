// The song gate, proved against hand written score tracks. No wasm, no model,
// no browser: everything here is arithmetic over the numbers the classifier
// returns, and the classifier itself is measured in `_verify/ast-music-probe.mjs`.

import { describe, expect, it, vi } from 'vitest'
import {
  dropWordsInMusic,
  isPureMusic,
  scoreForWord,
  speechScore,
  speechTrackFromPcm,
  SPEECH_BAR,
  WINDOW_S,
  type SpeechTrack,
} from './musicGate'

const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })
const trackOf = (scores: number[], windowS = WINDOW_S): SpeechTrack => ({
  scores: Float32Array.from(scores),
  windowS,
})

describe('speechScore', () => {
  it('takes the best label that means somebody is talking', () => {
    expect(
      speechScore([
        { label: 'Music', score: 0.9 },
        { label: 'Speech', score: 0.3 },
        { label: 'Narration, monologue', score: 0.42 },
      ]),
    ).toBeCloseTo(0.42, 6)
  })

  it('⛔ does NOT count Singing as speech, because a sung lyric is the complaint', () => {
    expect(speechScore([{ label: 'Singing', score: 0.95 }, { label: 'Music', score: 0.8 }])).toBe(0)
  })

  it('is zero when nothing on the list appears at all', () => {
    expect(speechScore([{ label: 'Vehicle', score: 0.7 }])).toBe(0)
  })
})

describe('scoreForWord', () => {
  const track = trackOf([0.9, 0.002, 0.8])

  it('reads the window the word sits in', () => {
    expect(scoreForWord(track, 1, 2)).toBeCloseTo(0.9, 6)
    expect(scoreForWord(track, 6, 7)).toBeCloseTo(0.002, 6)
  })

  it('⛔ takes the BEST of the windows a word straddles, never the first', () => {
    // Deleting a real word is his work gone; keeping a junk one is a delete.
    // The asymmetry decides this, not tidiness.
    expect(scoreForWord(track, 4.8, 5.4)).toBeCloseTo(0.9, 6)
  })

  it('⛔ keeps a word past the last scored window, because a tail is unscored', () => {
    expect(scoreForWord(track, 40, 40.4)).toBe(1)
  })
})

describe('dropWordsInMusic', () => {
  it('⛔ keeps every word when the analysis had no opinion', () => {
    const words = [w('a', 0, 1), w('b', 6, 7)]
    expect(dropWordsInMusic(words, null)).toHaveLength(2)
    expect(dropWordsInMusic(words, trackOf([]))).toHaveLength(2)
  })

  it('drops only the words sitting in the music', () => {
    const words = [w('clutch', 1, 1.4), w('invented', 6, 6.5), w('back', 11, 11.4)]
    const out = dropWordsInMusic(words, trackOf([0.9, 0.002, 0.8]))
    expect(out.map((x) => x.text)).toEqual(['clutch', 'back'])
  })

  it('⛔ takes the WHOLE transcript when no window shows anybody talking', () => {
    // The neighbouring voice gate refuses this on purpose, because ITS
    // instrument overlaps with speech. This one separates by twenty times, and
    // a clip of pure song captioned in full is the bug he reported.
    const words = [w('I', 1, 1.3), w('am', 6, 6.3), w('invented', 11, 11.3)]
    expect(dropWordsInMusic(words, trackOf([0.002, 0.003, 0.002]))).toEqual([])
  })

  it('⛔ keeps his voice under a bed 12 dB LOUDER than him', () => {
    // The measured worst real case is 0.259, five times over the bar.
    const words = [w('so', 1, 1.3), w('anyway', 6, 6.4)]
    expect(dropWordsInMusic(words, trackOf([0.259, 0.324]))).toHaveLength(2)
  })

  it('keeps room tone and silence from deciding anything on their own', () => {
    // Both score under the bar, and both are stretches with no words in them,
    // so the filter has nothing to remove and removes nothing.
    expect(dropWordsInMusic([], trackOf([0.009, 0.013]))).toEqual([])
  })
})

describe('isPureMusic', () => {
  it('is true only when every window is under the bar', () => {
    expect(isPureMusic(trackOf([0.002, 0.003]))).toBe(true)
    expect(isPureMusic(trackOf([0.002, 0.9]))).toBe(false)
    expect(isPureMusic(trackOf([]))).toBe(false)
  })

  it('uses the same bar the gate does', () => {
    expect(isPureMusic(trackOf([SPEECH_BAR - 0.001]))).toBe(true)
    expect(isPureMusic(trackOf([SPEECH_BAR]))).toBe(false)
  })
})

describe('speechTrackFromPcm', () => {
  const fake = (perWindow: number[]) => {
    let i = 0
    return vi.fn(async () => [{ label: 'Speech', score: perWindow[Math.min(i++, perWindow.length - 1)] }])
  }

  it('scores one window per WINDOW_S of audio, AND the part window at the end', () => {
    const pcm = new Float32Array(16000 * 12) // 12 s at 16 kHz = two whole 5 s windows, 2 s left
    const classify = fake([0.8, 0.02, 0.01])
    return speechTrackFromPcm(classify, pcm, 16000).then((t) => {
      expect(t?.scores.length).toBe(3)
      expect(classify).toHaveBeenCalledTimes(3)
      // Float32Array, so 0.8 reads back as 0.800000011920929.
      expect(t!.scores[0]).toBeCloseTo(0.8, 6)
      expect(t!.scores[1]).toBeCloseTo(0.02, 6)
      expect(t!.scores[2]).toBeCloseTo(0.01, 6)
    })
  })

  // The tail used to be skipped on purpose, and an unscored tail reads as speech,
  // so every clip kept up to five seconds of whatever the recogniser invented at
  // the end of it. On a music-only clip that is junk captions, every clip, which
  // is the thing he reported.
  it('a music-only clip is called pure music all the way to its end', () => {
    const pcm = new Float32Array(16000 * 12)
    return speechTrackFromPcm(fake([0.01]), pcm, 16000).then((t) => {
      expect(isPureMusic(t!)).toBe(true)
      // The last word in the clip is inside a scored window, so it can be dropped.
      expect(scoreForWord(t!, 11, 11.4)).toBeCloseTo(0.01, 6)
    })
  })

  it('⛔ a tail under a second is still left unscored, so it still reads as speech', () => {
    const pcm = new Float32Array(16000 * 10.5) // two whole windows, half a second left
    const classify = fake([0.01])
    return speechTrackFromPcm(classify, pcm, 16000).then((t) => {
      expect(t?.scores.length).toBe(2)
      expect(classify).toHaveBeenCalledTimes(2)
      expect(scoreForWord(t!, 10.2, 10.4)).toBe(1)
    })
  })

  it('scores a clip shorter than one window in one go, which is his common case', () => {
    const pcm = new Float32Array(16000 * 2)
    return speechTrackFromPcm(fake([0.004]), pcm, 16000).then((t) => {
      expect(t?.scores.length).toBe(1)
      expect(t?.windowS).toBeCloseTo(2, 6)
    })
  })

  it('⛔ has no opinion at all on under a second of audio', () => {
    return speechTrackFromPcm(fake([0.9]), new Float32Array(8000), 16000).then((t) => {
      expect(t).toBeNull()
    })
  })

  it('stops when the run is cancelled', () => {
    const signal = { aborted: true }
    return speechTrackFromPcm(fake([0.9]), new Float32Array(16000 * 12), 16000, { signal }).then((t) => {
      expect(t).toBeNull()
    })
  })
})
