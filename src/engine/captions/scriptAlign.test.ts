// His script, timed by what the recogniser heard (CA-6).

import { describe, expect, it } from 'vitest'
import { AUTO_CAPTION_OPTIONS, chunkWords, type CaptionWord } from './captions'
import { alignScript } from './scriptAlign'

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
