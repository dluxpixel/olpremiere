// His script, timed by what the recogniser heard (CA-6).

import { describe, expect, it } from 'vitest'
import { AUTO_CAPTION_OPTIONS, chunkWords, type CaptionWord } from './captions'
import { alignScript, keepHitTakes, scriptHeard } from './scriptAlign'

const w = (text: string, startS: number, endS: number, emphasis?: boolean): CaptionWord => ({
  text,
  startS,
  endS,
  ...(emphasis ? { emphasis: true } : {}),
})
const texts = (ws: readonly CaptionWord[] | null): string[] => (ws ?? []).map((x) => x.text)

describe('alignScript', () => {
  it('a script heard as written keeps every heard time, in his spelling', () => {
    const heard = [w('so', 0, 0.2), w('i', 0.2, 0.3), w('hit', 0.3, 0.6), w('a', 0.6, 0.7), w('pr', 0.7, 1.1)]
    const out = alignScript('So I hit a PR.', heard)!
    expect(texts(out)).toEqual(['So', 'I', 'hit', 'a', 'PR.'])
    expect(out.map((x) => [x.startS, x.endS])).toEqual(heard.map((x) => [x.startS, x.endS]))
  })

  it('a name the model split in two is one word over both', () => {
    const out = alignScript('Minecraft is back', [w('mine', 0, 0.3), w('draft', 0.3, 0.7), w('is', 0.7, 0.9), w('back', 0.9, 1.2)])!
    expect(texts(out)).toEqual(['Minecraft', 'is', 'back'])
    expect([out[0]!.startS, out[0]!.endS]).toEqual([0, 0.7])
  })

  it('two words the model ran together share its time', () => {
    const out = alignScript('Bun Bun wins', [w('bunbun', 1, 1.6), w('wins', 1.6, 2)])!
    expect(texts(out)).toEqual(['Bun', 'Bun', 'wins'])
    expect(out[0]!.startS).toBe(1)
    expect(out[1]!.endS).toBe(1.6)
    expect(out[0]!.endS).toBeCloseTo(1.3, 9)
  })

  it('a name the model got wrong still takes the time it was said at', () => {
    const out = alignScript('Sir Rel is here', [w('sirrel', 0, 0.5), w('is', 0.5, 0.7), w('here', 0.7, 1)])!
    expect(texts(out)).toEqual(['Sir', 'Rel', 'is', 'here'])
    expect(out[0]!.startS).toBe(0)
    expect(out[1]!.endS).toBe(0.5)
  })

  it('a word the model missed shares the time between its neighbours', () => {
    const out = alignScript('the very best', [w('the', 0, 0.2), w('best', 0.8, 1.1)])!
    expect(texts(out)).toEqual(['the', 'very', 'best'])
    expect(out[1]!.startS).toBeCloseTo(0.2, 9)
    expect(out[1]!.endS).toBeCloseTo(0.8, 9)
  })

  it('with no room between its neighbours, a missed word takes the back of the one before', () => {
    const out = alignScript('the very best', [w('the', 0, 0.4), w('best', 0.4, 0.8)])!
    expect(texts(out)).toEqual(['the', 'very', 'best'])
    expect(out[1]!.endS - out[1]!.startS).toBeGreaterThan(0.1)
    expect(out[0]!.endS).toBeCloseTo(out[1]!.startS, 9)
    expect(out[0]!.endS).toBeGreaterThan(out[0]!.startS)
  })

  it('drops a heard word the script does not have', () => {
    const out = alignScript('go now', [w('go', 0, 0.2), w('um', 0.2, 0.5), w('now', 0.5, 0.8)])!
    expect(texts(out)).toEqual(['go', 'now'])
    expect(out[1]!.startS).toBe(0.5)
  })

  it('keeps punctuation standing alone on the word before it', () => {
    const out = alignScript('wait ... what ?', [w('wait', 0, 0.3), w('what', 0.6, 0.9)])!
    expect(texts(out)).toEqual(['wait ...', 'what ?'])
    expect(alignScript('wait, what?', [w('wait', 0, 0.3), w('what', 0.6, 0.9)])!.map((x) => x.text)).toEqual(['wait,', 'what?'])
  })

  it('never captions a direction in square brackets', () => {
    const out = alignScript('[HOOK] Bun Bun is back [cut to the base] for good', [
      w('bunbun', 0, 0.5),
      w('is', 0.5, 0.7),
      w('back', 0.7, 1),
      w('for', 1.2, 1.4),
      w('good', 1.4, 1.8),
    ])!
    expect(texts(out)).toEqual(['Bun', 'Bun', 'is', 'back', 'for', 'good'])
    expect(out[4]!.startS).toBe(1.2)
  })

  it('the names the model really got wrong take the time they were said at', () => {
    const bun = alignScript('my Bun Bun wins', [w('my', 0, 0.2), w('bamban', 0.2, 0.8), w('wins', 0.8, 1.1)])!
    expect(texts(bun)).toEqual(['my', 'Bun', 'Bun', 'wins'])
    expect([bun[1]!.startS, bun[2]!.endS]).toEqual([0.2, 0.8])
    const rel = alignScript('then Sir Rel came', [w('then', 0, 0.3), w('cerraral', 0.3, 0.9), w('came', 0.9, 1.2)])!
    expect(texts(rel)).toEqual(['then', 'Sir', 'Rel', 'came'])
    // Too unlike to count as heard, so it is timed by its neighbours: the same stretch.
    expect(rel[1]!.startS).toBeCloseTo(0.3, 9)
    expect(rel[2]!.endS).toBeCloseTo(0.9, 9)
  })

  it('a missed first word with no room takes the front of the word after, never sitting on it', () => {
    const out = alignScript('so the best', [w('the', 0, 0.4), w('best', 0.4, 0.8)])!
    expect(texts(out)).toEqual(['so', 'the', 'best'])
    expect(out[0]!.startS).toBe(0)
    expect(out[0]!.endS).toBeGreaterThan(0.1)
    expect(out[1]!.startS).toBeCloseTo(out[0]!.endS, 9)
    expect(out[1]!.endS).toBe(0.4)
  })

  it('no two words he wrote ever overlap or run backwards', () => {
    const heard = [w('um', 0, 0.2), w('so', 0.2, 0.4), w('mine', 0.4, 0.6), w('draft', 0.6, 0.9), w('uh', 0.9, 1.2), w('back', 1.2, 1.5)]
    const out = alignScript('So, Minecraft is finally back.', heard)!
    expect(texts(out)).toEqual(['So,', 'Minecraft', 'is', 'finally', 'back.'])
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.endS).toBeGreaterThan(out[i]!.startS)
      if (i > 0) expect(out[i]!.startS).toBeGreaterThanOrEqual(out[i - 1]!.endS - 1e-9)
    }
    expect([out[1]!.startS, out[1]!.endS]).toEqual([0.4, 0.9])
    expect(out[4]!.startS).toBe(1.2)
  })

  it('a sentence end in his script still ends a caption', () => {
    const out = alignScript('I won. Then I left', [w('i', 0, 0.2), w('won', 0.2, 0.5), w('then', 0.5, 0.7), w('i', 0.7, 0.8), w('left', 0.8, 1.1)])!
    const chunks = chunkWords(out, AUTO_CAPTION_OPTIONS)
    expect(chunks.some((c) => c.text.endsWith('won.'))).toBe(true)
    expect(chunks.every((c) => !/won\. then/i.test(c.text))).toBe(true)
  })

  it('the highlight the listening picked stays on the word he wrote', () => {
    const out = alignScript('the BEST one', [w('the', 0, 0.2), w('best', 0.2, 0.6, true), w('one', 0.6, 0.9)])!
    expect(out.map((x) => !!x.emphasis)).toEqual([false, true, false])
  })

  it('is null when nothing in the script was said, or there is nothing to align', () => {
    expect(alignScript('completely different words here', [w('minecraft', 0, 0.5), w('diamonds', 0.5, 1)])).toBeNull()
    expect(alignScript('   ', [w('hi', 0, 0.2)])).toBeNull()
    expect(alignScript('hi', [])).toBeNull()
  })

  // ⛔ R-2. Every script word used to be given a time, heard or not.
  describe('script that was not heard there gets no caption', () => {
    /** Words said back to back from `fromS`, a quarter second each. */
    const said = (text: string, fromS: number): CaptionWord[] =>
      text.split(' ').map((t, i) => w(t, fromS + i * 0.25, fromS + (i + 1) * 0.25))

    it('a whole script against one clip lays only what that clip said, inside it', () => {
      const clip = said('then i hit two plates', 10)
      const script = 'So today I trained legs.\nThen I hit two plates!\nAnd I went home to eat.'
      const out = scriptHeard(script, clip)!
      expect(texts(out.words)).toEqual(['Then', 'I', 'hit', 'two', 'plates!'])
      expect(out.words.map((x) => [x.startS, x.endS])).toEqual(clip.map((x) => [x.startS, x.endS]))
      expect(out.unheardLines).toBe(2)
      expect(out.unheardWords).toBe(0)
    })

    it('a line cut from the middle of the edit squeezes nothing in and shortens no word', () => {
      const heard = [...said('i won the set', 0), ...said('then i left', 1)]
      const out = scriptHeard('I won the set.\nWe cut this whole line out.\nThen I left.', heard)!
      expect(texts(out.words)).toEqual(['I', 'won', 'the', 'set.', 'Then', 'I', 'left.'])
      expect(out.words.map((x) => [x.startS, x.endS])).toEqual(heard.map((x) => [x.startS, x.endS]))
      expect(out.unheardLines).toBe(1)
    })

    it('a line cut from the end is never laid past the last word heard', () => {
      const heard = said('i won the set', 0)
      const out = scriptHeard('I won the set. And then I went home.', heard)!
      expect(texts(out.words)).toEqual(['I', 'won', 'the', 'set.'])
      expect(Math.max(...out.words.map((x) => x.endS))).toBe(1)
      // Part of a line he said: counted as words, not as a line.
      expect([out.unheardLines, out.unheardWords]).toEqual([0, 5])
    })

    it('a script line before the first word heard never lands before it', () => {
      const heard = said('then i left', 5)
      const out = scriptHeard('This is the hook line.\nThen I left.', heard)!
      expect(texts(out.words)).toEqual(['Then', 'I', 'left.'])
      expect(Math.min(...out.words.map((x) => x.startS))).toBe(5)
    })

    it('a one word line he cut is not squeezed between the lines around it', () => {
      const heard = [...said('i won', 0), ...said('then i left', 0.5)]
      const out = scriptHeard('I won.\nWow.\nThen I left.', heard)!
      expect(texts(out.words)).toEqual(['I', 'won.', 'Then', 'I', 'left.'])
      expect(out.words[1]!.endS).toBe(0.5)
    })

    it('a word missed at the very end takes the back of the word before, never past it', () => {
      const out = scriptHeard('we did it again', said('we did it', 0))!
      expect(texts(out.words)).toEqual(['we', 'did', 'it', 'again'])
      expect(out.words[3]!.endS).toBe(0.75)
      expect(out.words[3]!.startS).toBeGreaterThan(out.words[2]!.startS)
      expect(out.words[2]!.endS).toBeCloseTo(out.words[3]!.startS, 9)
    })

    it('a stretch the model heard as other words, between heard words, is still his', () => {
      // Four words heard as two that are nothing like them: said, just misheard.
      const heard = [w('now', 0, 0.3), w('cerraral', 0.3, 0.9), w('degrade', 0.9, 1.4), w('is', 1.4, 1.6), w('back', 1.6, 2)]
      const out = scriptHeard('now Sir Rel the Great is back', heard)!
      expect(texts(out.words)).toEqual(['now', 'Sir', 'Rel', 'the', 'Great', 'is', 'back'])
      expect(out.words[1]!.startS).toBeCloseTo(0.3, 9)
      expect(out.words[4]!.endS).toBeCloseTo(1.4, 9)
      expect([out.unheardLines, out.unheardWords]).toEqual([0, 0])
    })

    // A filler is heard, never the model's version of a word of his script, so
    // three of them in a gap do not make five missing words "about as many".
    it('fillers heard where five words of his script are missing do not make them misheard', () => {
      const heard = [w('alpha', 0, 0.3), w('um', 0.3, 0.5), w('uh', 0.5, 0.7), w('um', 0.7, 0.9), w('eta', 0.9, 1.2)]
      const out = scriptHeard('alpha beta gamma delta epsilon zeta eta', heard)!
      expect(texts(out.words)).toEqual(['alpha', 'eta'])
      expect(out.unheardWords).toBe(5)
    })

    it('a stretch heard as other words still counts when a filler sits in it', () => {
      const heard = [w('now', 0, 0.3), w('cerraral', 0.3, 0.9), w('um', 0.9, 1), w('degrade', 1, 1.5), w('is', 1.5, 1.7), w('back', 1.7, 2.1)]
      const out = scriptHeard('now Sir Rel the Great is back', heard)!
      expect(texts(out.words)).toEqual(['now', 'Sir', 'Rel', 'the', 'Great', 'is', 'back'])
    })

    // Two clips with nothing selected between them are not one stretch of speech:
    // words missed "between" them were timed across the whole gap, over clips he
    // never asked about.
    describe('between clips that do not touch', () => {
      const clipA = { startS: 0, endS: 1 }
      const heardA = [w('alpha', 0, 0.3), w('beta', 0.3, 0.6), w('qqqq', 0.6, 0.9)]
      const apart = [clipA, { startS: 5, endS: 6 }]
      const beside = [clipA, { startS: 1, endS: 2 }]

      it('one or two missed words are laid inside the earlier clip, not across the gap', () => {
        const heard = [w('alpha', 0, 0.3), w('beta', 0.3, 0.6), w('zeta', 5.3, 5.6)]
        const out = scriptHeard('alpha beta gamma delta zeta', heard, apart)!
        expect(texts(out.words)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'zeta'])
        for (const x of out.words.slice(0, 4)) expect(x.endS).toBeLessThanOrEqual(clipA.endS + 1e-9)
        expect(out.words[4]!.startS).toBe(5.3)
        // The same two words with no spans are timed up to the next heard word.
        const loose = scriptHeard('alpha beta gamma delta zeta', heard)!
        expect(loose.words[3]!.endS).toBeCloseTo(5.3, 9)
      })

      it('three words heard as two others, one in each clip, are not laid in either', () => {
        const heard = [...heardA, w('rrrr', 5, 5.3), w('zeta', 5.3, 5.6)]
        const out = scriptHeard('alpha beta one two three zeta', heard, apart)!
        expect(texts(out.words)).toEqual(['alpha', 'beta', 'zeta'])
        expect(out.unheardWords).toBe(3)
      })

      it('clips that touch are one stretch, as before', () => {
        const heard = [...heardA, w('rrrr', 1, 1.3), w('zeta', 1.3, 1.6)]
        const out = scriptHeard('alpha beta one two three zeta', heard, beside)!
        expect(texts(out.words)).toEqual(['alpha', 'beta', 'one', 'two', 'three', 'zeta'])
      })
    })
  })

  // ⛔ S-1. On a tie the aligner paired a script word as late as possible, so a
  // word could land in a LATER copy of itself, and the run then replaced that
  // later take's captions. Every tie is now settled for the first take, and a
  // word is never taken from one take while the rest of the line is in another.
  describe('a line said in more than one take is laid where it was said, whole', () => {
    const said = (text: string, fromS: number): CaptionWord[] =>
      text.split(' ').map((t, i) => w(t, fromS + i * 0.25, fromS + (i + 1) * 0.25))
    const starts = (ws: readonly CaptionWord[]): number[] => ws.map((x) => x.startS)

    it('the same line in three takes is laid in the first, all of it', () => {
      const heard = [...said('i did it', 0), ...said('i did it', 10), ...said('i did it', 20)]
      expect(starts(scriptHeard('I did it.', heard)!.words)).toEqual([0, 0.25, 0.5])
    })

    it('words spread over the takes still come from the one take that has them all', () => {
      const heard = [...said('okay i did', 0), ...said('i did it', 10), ...said('yeah it', 20)]
      expect(starts(scriptHeard('I did it.', heard)!.words)).toEqual([10, 10.25, 10.5])
    })

    it('a flubbed first take does not lend its words to the good one after it', () => {
      const heard = [...said('i did', 0), ...said('i did it', 10)]
      expect(starts(scriptHeard('I did it.', heard)!.words)).toEqual([10, 10.25, 10.5])
    })

    it('an ad-libbed take after the line is never laid into', () => {
      const heard = [...said('i did it', 0), ...said('yeah i did it man', 10)]
      expect(starts(scriptHeard('I did it.', heard)!.words)).toEqual([0, 0.25, 0.5])
      const whole = scriptHeard('I did it. Then we left.', [...said('i did it then we left', 0), ...said('yeah i did it man', 10)])!
      expect(texts(whole.words)).toEqual(['I', 'did', 'it.', 'Then', 'we', 'left.'])
      expect(Math.max(...starts(whole.words))).toBeLessThan(10)
    })

    it('a stray um inside the good take does not hand its first word to the take before', () => {
      const heard = [...said('bravo juliet', 0), ...said('juliet um hotel golf', 10)]
      expect(starts(scriptHeard('Juliet hotel golf.', heard)!.words)).toEqual([10, 10.5, 10.75])
    })

    it('a line said twice in the script is laid in both takes', () => {
      const heard = [...said('i did it', 0), ...said('i did it', 10)]
      expect(starts(scriptHeard('I did it. I did it.', heard)!.words)).toEqual([0, 0.25, 0.5, 10, 10.25, 10.5])
    })
  })

  it('a direction in (parentheses) is never captioned, like one in [brackets]', () => {
    const heard = [w('that', 0, 0.2), w('was', 0.2, 0.4), w('insane', 0.4, 0.9), w('right', 1.5, 1.8)]
    expect(texts(alignScript('That was insane (laughs) right', heard))).toEqual(['That', 'was', 'insane', 'right'])
    expect(texts(alignScript('That was insane (cut to the base shot) right', heard))).toEqual(['That', 'was', 'insane', 'right'])
  })

  it('a three minute script is aligned in a moment', () => {
    const said = Array.from({ length: 500 }, (_, i) => `word${i % 37}x${i % 11}`)
    const heard = said.map((t, i) => w(t, i * 0.36, i * 0.36 + 0.3))
    const t0 = performance.now()
    const out = alignScript(said.join(' '), heard)!
    const ms = performance.now() - t0
    expect(out).toHaveLength(500)
    expect(out[250]!.startS).toBeCloseTo(heard[250]!.startS, 9)
    expect(ms).toBeLessThan(2000)
  })
})

describe('keepHitTakes', () => {
  const run = (n: number, from: number): CaptionWord[] => Array.from({ length: n }, (_, i) => w('x', from + i * 0.1, from + i * 0.1 + 0.1))
  const takes = [
    { startS: 0, endS: 3 },
    { startS: 3, endS: 6 },
  ]

  it('a take with one stray word of many heard in it is dropped, and counted', () => {
    const out = keepHitTakes([...run(3, 0), ...run(1, 3)], [...run(3, 0), ...run(6, 3)], takes)
    expect(out.words).toHaveLength(3)
    expect(out.dropped).toBe(1)
  })

  it('a short take the script is about stays, one word and all', () => {
    const out = keepHitTakes([...run(3, 0), ...run(1, 3)], [...run(3, 0), ...run(1, 3)], takes)
    expect(out.words).toHaveLength(4)
    expect(out.dropped).toBe(0)
  })

  it('with no take hit, the takes with the most words laid are kept, never none', () => {
    const out = keepHitTakes([...run(1, 0), ...run(1, 3)], [...run(9, 0), ...run(9, 3)], takes)
    expect(out.words).toHaveLength(2)
    expect(out.dropped).toBe(0)
  })

  it('a word that starts in no take is kept', () => {
    const out = keepHitTakes([...run(3, 0), w('x', 9, 9.1)], [...run(3, 0)], takes)
    expect(out.words).toHaveLength(4)
  })
})
