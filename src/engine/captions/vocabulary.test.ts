import { describe, expect, it } from 'vitest'
import { defaultTitleDef, newTitleClip, type Clip } from '../types'
import {
  applyRewrites,
  correctionsFromClips,
  EMPTY_VOCABULARY,
  learnVocabulary,
  spokenWords,
  type ProjectCorrections,
} from './vocabulary'

/** One caption clip: what the machine wrote, and what he left on screen. */
const cap = (machine: string, his: string, startS: number, durS = 0.4): Clip => ({
  ...newTitleClip(defaultTitleDef(his), startS, durS),
  captionOrigin: { text: machine, model: 'm' },
})

/** A project from [machine, his] pairs, one caption every half second. */
const project = (pairs: [string, string][]): ProjectCorrections =>
  correctionsFromClips(pairs.map(([m, h], i) => cap(m, h, i * 0.5)))!

describe('spokenWords', () => {
  it('reads what he styles as the word underneath', () => {
    expect(spokenWords('alrightttt, my LIFE!!')).toEqual(['alright', 'my', 'life'])
    expect(spokenWords('(not a legend rare) awakened')).toEqual(['awakened'])
    expect(spokenWords('pre-animation')).toEqual(['pre', 'animation'])
  })

  it('reads every way of writing a thousands separator as one number', () => {
    expect(spokenWords('30 ,000')).toEqual(['30000'])
    expect(spokenWords('30 000')).toEqual(['30000'])
    expect(spokenWords('540.000')).toEqual(['540000'])
  })
})

describe('correctionsFromClips', () => {
  // His BC edit, 2026-10-03: one machine caption "ranking all" split into three
  // clips he retyped. Read three times, the machine would have said it thrice.
  it('reads a caption he split into pieces as ONE machine caption', () => {
    const clips = [
      cap('ranking all', 'ranking', 0, 0.3),
      cap('ranking all', 'the most', 0.3, 0.3),
      cap('ranking all', 'annoying bun buns', 0.6, 0.6),
      cap('in the', 'in the', 1.3),
    ]
    const p = correctionsFromClips(clips)!
    expect(p.accepted).toEqual(expect.arrayContaining(['ranking', 'in', 'the']))
    // "all" was heard once, and the five words he typed are a lost stretch, not a spelling.
    expect(p.corrections).toEqual([])
  })

  it('keeps the words he changed, and leaves out a whole lost sentence', () => {
    const p = project([
      ['Fourth is', 'fourth is'],
      ['teacher', 'teacher'],
      ['Bamban,', 'bun bun'],
      ['he has', 'he has'],
      ['I mean', 'Minecraft but I can\'t touch the color green okay so we spawned and'],
    ])
    expect(p.corrections).toContainEqual({ heard: ['bamban'], his: ['bun', 'bun'] })
    expect(p.corrections.some((c) => c.his.includes('spawned'))).toBe(false)
  })

  it('has nothing to say about a project with no machine captions', () => {
    expect(correctionsFromClips([newTitleClip(defaultTitleDef('hi'), 0, 1)])).toBeNull()
  })
})

describe('learnVocabulary', () => {
  // The house bar (styleProfile.ts FIX_CONFIDENCE): twice, never once.
  it('rewrites a misspelling only once he has fixed it the same way twice', () => {
    const once = learnVocabulary([project([['He is', 'he is'], ['Bamban,', 'bun bun']])])
    expect(once.rewrites).toEqual([])
    const twice = learnVocabulary([
      project([['He is', 'he is'], ['Bamban,', 'bun bun']]),
      project([['And', 'and'], ['Bamban.', 'bun bun']]),
    ])
    expect(twice.rewrites).toEqual([{ heard: ['bamban'], his: 'bun bun', seen: 2 }])
  })

  it('never rewrites a word he has kept somewhere', () => {
    const v = learnVocabulary([
      project([['cool', 'cooldown'], ['so', 'so']]),
      project([['cool', 'cooldown'], ['so', 'so']]),
      project([['that is', 'that is'], ['cool', 'cool']]),
    ])
    expect(v.rewrites).toEqual([])
  })

  it('never picks between two spellings of his', () => {
    const v = learnVocabulary([
      project([['He is', 'he is'], ['Banban', 'bun bun']]),
      project([['He is', 'he is'], ['Banban', 'bunbun']]),
    ])
    expect(v.rewrites).toEqual([])
  })

  it('leaves numbers to the number fix', () => {
    const v = learnVocabulary([
      project([['for 60', 'for 60000'], ['which', 'which']]),
      project([['for 60', 'for 60000'], ['which', 'which']]),
    ])
    expect(v.rewrites).toEqual([])
  })

  it('learns a phrase the model wrote for one of his names, and tries it before its parts', () => {
    const v = learnVocabulary([
      project([['At number 2', 'at number 2'], ['VFP Pteral', 'we have pterowl hazuku'], ['with', 'with'], ['Pteral', 'pterowl']]),
      project([['At number 2', 'at number 2'], ['VFP Pteral', 'we have pterowl hazuku'], ['with', 'with'], ['Pteral', 'pterowl']]),
    ])
    expect(v.rewrites.map((r) => r.heard.join(' '))).toEqual(['vfp pteral', 'pteral'])
  })
})

describe('applyRewrites', () => {
  const v = { rewrites: [{ heard: ['mecha', 'bamban'], his: 'mecha bunbun', seen: 2 }, { heard: ['bamban'], his: 'bun bun', seen: 2 }] }
  const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })

  it('puts his spelling back as one word over the time it covered, keeping the full stop', () => {
    const out = applyRewrites([w('is', 0, 0.2), w('Mecha', 0.2, 0.5), w('Bamban.', 0.5, 0.9)], v)
    expect(out).toEqual([w('is', 0, 0.2), w('mecha bunbun.', 0.2, 0.9)])
  })

  it('does not join words across a pause', () => {
    const out = applyRewrites([w('Mecha', 0, 0.3), w('Bamban', 1.2, 1.6)], v)
    expect(out.map((x) => x.text)).toEqual(['Mecha', 'bun bun'])
  })

  it('changes nothing with no rewrites', () => {
    const words = [w('hello', 0, 0.3)]
    expect(applyRewrites(words, EMPTY_VOCABULARY)).toEqual(words)
  })
})
