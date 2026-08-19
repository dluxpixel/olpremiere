// Learning his caption style from finished work, and applying it to the next
// video.
//
// ⛔ THE BAR HERE IS HIGHER THAN USUAL, because everything this decides ends up
// as words on screen in his video without him asking. A wrong rule does not
// throw or turn red: it quietly writes a word he did not choose, in the one
// feature whose whole promise is that it sounds like him. So the tests below
// spend most of their effort on what must NOT be learned.

import { describe, expect, it } from 'vitest'
import { caseShapeOf, sameWord, sampleFromClips, type StyleSample } from './styleLearning'
import { applyProfile, buildProfile, suggestFor, FIX_CONFIDENCE, HABIT_MIN_SAMPLES } from './styleProfile'
import { defaultTitleDef, newTitleClip, type Clip } from '../types'

const MODEL = 'onnx-community/whisper-small.en_timestamped'

/** A caption clip as a run would leave it: machine text stamped, his text shown. */
function caption(machine: string, his: string, over: Partial<Clip> = {}): Clip {
  const def = { ...defaultTitleDef(his) }
  const clip = newTitleClip(def, 0, 0.4)
  return { ...clip, captionOrigin: { text: machine, model: MODEL }, ...over }
}

const sampleOf = (clips: Clip[]): StyleSample => {
  const s = sampleFromClips(clips)
  if (!s) throw new Error('expected a sample')
  return s
}

describe('caseShapeOf', () => {
  it('names the four shapes', () => {
    expect(caseShapeOf('clutch')).toBe('lower')
    expect(caseShapeOf('CLUTCH')).toBe('upper')
    expect(caseShapeOf('Clutch')).toBe('title')
    expect(caseShapeOf('cS2')).toBe('mixed')
  })

  it('ignores punctuation when deciding', () => {
    expect(caseShapeOf('clutch!')).toBe('lower')
    expect(caseShapeOf('CLUTCH!')).toBe('upper')
  })

  it('does not crash on a caption with no letters at all', () => {
    expect(caseShapeOf('...')).toBe('mixed')
    expect(caseShapeOf('')).toBe('mixed')
  })
})

describe('sameWord', () => {
  it('sees through case and punctuation', () => {
    expect(sameWord('clutch', 'CLUTCH!')).toBe(true)
    expect(sameWord('cs go', 'CS GO')).toBe(true)
  })

  it('still separates genuinely different words', () => {
    expect(sameWord('cs go', 'CS2')).toBe(false)
  })

  it('⛔ counts a spacing change as a rewrite, because that is how he types a name', () => {
    // The recogniser splits a name it does not know, and gluing it back is the
    // single most common correction he makes. Folding the space away here made
    // it invisible to the learning, which is the bug this pins.
    expect(sameWord('cs go', 'CSGO')).toBe(false)
    expect(sameWord('you tube', 'YouTube')).toBe(false)
  })
})

describe('sampleFromClips', () => {
  it('is null for a project with no captions from a model', () => {
    expect(sampleFromClips([newTitleClip(defaultTitleDef('hand typed'), 0, 1)])).toBeNull()
  })

  it('counts the captions he left alone, which is the honesty check', () => {
    const s = sampleOf([caption('hello', 'hello'), caption('there', 'there'), caption('cs go', 'CS2')])
    expect(s.captions).toBe(3)
    expect(s.untouched).toBe(2)
  })

  it('records a real rewrite', () => {
    const s = sampleOf([caption('cs go', 'CS2')])
    expect(s.wordFixes).toEqual([{ from: 'cs go', to: 'CS2', seen: 1 }])
  })

  it('⛔ does NOT record a case change as a word rewrite', () => {
    // Otherwise every shouted word fills the fix list with "cool" to "COOL",
    // and the list stops meaning "the machine got this wrong".
    const s = sampleOf([caption('cool', 'COOL')])
    expect(s.wordFixes).toEqual([])
    expect(s.caseCounts.upper).toBe(1)
  })

  it('⛔ does NOT record dropped punctuation as a word rewrite', () => {
    const s = sampleOf([caption('yeah.', 'yeah')])
    expect(s.wordFixes).toEqual([])
    expect(s.punctuationStripped).toBe(1)
  })

  it('keeps the spelling he used MOST when he has used two', () => {
    const s = sampleOf([caption('cs go', 'CS2'), caption('cs go', 'CS2'), caption('cs go', 'CSGO')])
    expect(s.wordFixes[0]).toEqual({ from: 'cs go', to: 'CS2', seen: 2 })
  })

  it('reads size and animation off what he shipped', () => {
    const big = caption('hi', 'hi')
    big.title!.fontSizePx = 120
    const s = sampleOf([{ ...big, appearance: { in: 'pop', durS: 0.12 } }])
    expect(s.sizes).toEqual([120])
    expect(s.animations).toEqual({ pop: 1 })
  })
})

describe('buildProfile', () => {
  /** n captions he left exactly alone, to give habits something to sit on. */
  const untouched = (n: number, word = 'yeah'): Clip[] =>
    Array.from({ length: n }, () => caption(word, word))

  it('is null when nothing was captioned by that model', () => {
    expect(buildProfile([], MODEL)).toBeNull()
  })

  it('⛔ IGNORES samples from a DIFFERENT model', () => {
    // A correction against whisper-base says "base misheard this". Against
    // small it may never have been needed. Merging them teaches the profile the
    // difference between two models and calls it his style.
    const old = sampleOf([caption('cs go', 'CS2'), caption('cs go', 'CS2')])
    const stale: StyleSample = { ...old, model: 'onnx-community/whisper-base.en_timestamped' }
    expect(buildProfile([stale], MODEL)).toBeNull()
  })

  it('⛔ does NOT trust a rewrite it has seen only ONCE', () => {
    // One is a typo or a one-off proper noun. Applying it silently puts a word
    // in his next video that he never chose.
    const p = buildProfile([sampleOf([caption('cs go', 'CS2')])], MODEL)!
    expect(p.fixes).toEqual([])
    expect(p.candidates.map((c) => c.to)).toEqual(['CS2'])
  })

  it('trusts it at the confidence bar', () => {
    const clips = Array.from({ length: FIX_CONFIDENCE }, () => caption('cs go', 'CS2'))
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.fixes).toEqual([{ from: 'cs go', to: 'CS2', seen: FIX_CONFIDENCE }])
  })

  it('⛔ refuses a word he has spelled two ways near-equally, however often', () => {
    // 3 against 2 clears the count bar and is still a coin flip. Picking the
    // winner would hand him the loser's spelling about half the times he
    // expected it, which reads as broken rather than opinionated.
    const s = sampleOf([
      ...Array.from({ length: 3 }, () => caption('cs go', 'CS2')),
      ...Array.from({ length: 2 }, () => caption('cs go', 'CSGO')),
    ])
    // The per-project sample already collapses to his most-used, so build the
    // split explicitly across two projects, which is how it really happens.
    const a = sampleOf(Array.from({ length: 3 }, () => caption('cs go', 'CS2')))
    const b = sampleOf(Array.from({ length: 2 }, () => caption('cs go', 'CSGO')))
    const p = buildProfile([a, b], MODEL)!
    expect(p.fixes).toEqual([])
    expect(p.candidates[0].from).toBe('cs go')
    expect(s.wordFixes.length).toBe(1) // sanity: the sample itself did collapse
  })

  it('⛔ will not settle a casing habit on too few captions', () => {
    const p = buildProfile([sampleOf([caption('a', 'A'), caption('b', 'B')])], MODEL)!
    expect(p.caseHabit).toBeNull()
  })

  it('settles a casing habit once there is enough of it', () => {
    const clips = Array.from({ length: HABIT_MIN_SAMPLES }, (_, i) => caption(`w${i}`, `W${i}`.toUpperCase()))
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.caseHabit).toBe('upper')
  })

  it('⛔ takes the MODE of his sizes, never the mean', () => {
    // Averaging 96 and 120 produces 108, a size he has never once chosen and
    // would have to correct on every caption.
    const clips = Array.from({ length: HABIT_MIN_SAMPLES + 2 }, (_, i) => {
      const c = caption(`w${i}`, `w${i}`)
      c.title!.fontSizePx = i < 2 ? 120 : 96
      return c
    })
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.fontSizePx).toBe(96)
  })

  it('learns that he strips the punctuation the model writes', () => {
    const clips = Array.from({ length: HABIT_MIN_SAMPLES }, (_, i) => caption(`w${i}.`, `w${i}`))
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.stripsPunctuation).toBe(true)
  })

  it('learns the opposite just as readily', () => {
    const clips = Array.from({ length: HABIT_MIN_SAMPLES }, (_, i) => caption(`w${i}.`, `w${i}.`))
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.stripsPunctuation).toBe(false)
  })

  it('adds up captions across several projects', () => {
    const a = sampleOf(untouched(5, 'aa'))
    const b = sampleOf(untouched(7, 'bb'))
    expect(buildProfile([a, b], MODEL)!.captions).toBe(12)
  })
})

describe('applyProfile', () => {
  const withFix = (): ReturnType<typeof buildProfile> =>
    buildProfile([sampleOf(Array.from({ length: FIX_CONFIDENCE }, () => caption('cs go', 'CS2')))], MODEL)

  it('changes nothing without a profile', () => {
    expect(applyProfile('cs go', null)).toBe('cs go')
  })

  it('applies a settled rewrite', () => {
    expect(applyProfile('cs go', withFix())).toBe('CS2')
  })

  it('is case-insensitive about what the model wrote', () => {
    expect(applyProfile('CS Go', withFix())).toBe('CS2')
  })

  it('⛔ does NOT re-case a rewrite he typed himself', () => {
    // He typed "CS2". A lowercase habit applied over the top hands back "cs2",
    // which is the feature undoing the thing it just learned.
    const clips = [
      ...Array.from({ length: FIX_CONFIDENCE }, () => caption('cs go', 'CS2')),
      ...Array.from({ length: HABIT_MIN_SAMPLES }, (_, i) => caption(`w${i}`, `w${i}`)),
    ]
    const p = buildProfile([sampleOf(clips)], MODEL)!
    expect(p.caseHabit).toBe('lower')
    expect(applyProfile('cs go', p)).toBe('CS2')
    expect(applyProfile('Something', p)).toBe('something')
  })

  it('⛔ does NOT rewrite a word that merely CONTAINS the learned one', () => {
    // Every caption here is one word, so a whole-caption match is a word match.
    // Substring matching would turn "cost" into "CS2st" the first time he typed
    // a sentence by hand.
    expect(applyProfile('cs going somewhere', withFix())).toBe('cs going somewhere')
  })

  it('strips punctuation when that is the settled habit', () => {
    const clips = Array.from({ length: HABIT_MIN_SAMPLES }, (_, i) => caption(`w${i}.`, `w${i}`))
    expect(applyProfile('yeah.', buildProfile([sampleOf(clips)], MODEL))).toBe('yeah')
  })

  it('leaves an empty caption alone', () => {
    expect(applyProfile('   ', withFix())).toBe('   ')
  })
})

describe('suggestFor', () => {
  const profile = () =>
    buildProfile([sampleOf(Array.from({ length: FIX_CONFIDENCE }, () => caption('cs go', 'CS2')))], MODEL)

  it('offers nothing when nothing would change', () => {
    expect(suggestFor(['hello', 'there'], profile())).toEqual([])
  })

  it('offers the change and says why in his language', () => {
    const [s] = suggestFor(['cs go'], profile())
    expect(s.before).toBe('cs go')
    expect(s.after).toBe('CS2')
    expect(s.reason).toContain('CS2')
  })

  it('counts a repeat instead of listing it twice', () => {
    const [s] = suggestFor(['cs go', 'cs go', 'cs go'], profile())
    expect(s.seen).toBe(3)
  })

  it('⛔ CHANGES NOTHING ITSELF, which is the point of a suggestion', () => {
    const texts = ['cs go']
    suggestFor(texts, profile())
    expect(texts).toEqual(['cs go'])
  })
})
