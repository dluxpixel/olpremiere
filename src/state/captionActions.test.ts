import { beforeEach, describe, expect, it, vi } from 'vitest'

// Toasts touch window.setTimeout, which the node test env lacks.
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  videoTracks,
  type Clip,
  type Sequence,
} from '../engine/types'
import { addCaptionsFromWords, splitTitleIntoWordCaptions } from './captionActions'
import { AUTO_CAPTION_TARGET_S, type CaptionWord } from '../engine/captions/captions'
import { clipDurationS } from '../engine/timeline'
import { updateActiveSequence, useStore } from './store'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const allClips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)

/** Insert a title clip directly onto V1 (bypassing playhead/appearance logic). */
function seedTitle(text: string, startS: number, durationS: number): Clip {
  const clip = newTitleClip({ ...defaultTitleDef(text), fontSizePx: 60 }, startS, durationS)
  updateActiveSequence('seed', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
  }))
  return clip
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('splitTitleIntoWordCaptions', () => {
  it('replaces the title with one caption per word inside its window', () => {
    const clip = seedTitle('so I built a trap', 2, 5)
    splitTitleIntoWordCaptions(clip.id)

    const track = seq().tracks[0]
    expect(track.clips.some((c) => c.id === clip.id)).toBe(false)
    expect(track.clips).toHaveLength(5)
    expect(track.clips.map((c) => c.title?.text)).toEqual(['so', 'I', 'built', 'a', 'trap'])
    // stays inside the original clip's window, in order, without overlaps
    expect(track.clips[0].startS).toBeCloseTo(2, 6)
    for (let i = 0; i < track.clips.length; i++) {
      const c = track.clips[i]
      const end = c.startS + c.outS
      expect(end).toBeLessThanOrEqual(7 + 1e-6)
      if (i > 0) {
        const prev = track.clips[i - 1]
        expect(c.startS).toBeGreaterThanOrEqual(prev.startS + prev.outS - 1e-6)
      }
    }
    // inherits the source style; hard-cut per the brief (no entrance animation)
    expect(track.clips[0].title?.fontSizePx).toBe(60)
    expect(track.clips[0].appearance).toBeUndefined()
    // selection moves to the new pieces
    expect(useStore.getState().ui.selection).toEqual(track.clips.map((c) => c.id))
  })

  it('is one undo step back to the original title', () => {
    const clip = seedTitle('one two three', 0, 3)
    splitTitleIntoWordCaptions(clip.id)
    expect(seq().tracks[0].clips).toHaveLength(3)

    useStore.getState().undo()
    const clips = seq().tracks[0].clips
    expect(clips).toHaveLength(1)
    expect(clips[0].id).toBe(clip.id)
    expect(clips[0].title?.text).toBe('one two three')
  })

  it('refuses single-word titles and locked tracks', () => {
    const clip = seedTitle('Boom', 0, 3)
    splitTitleIntoWordCaptions(clip.id)
    expect(seq().tracks[0].clips).toHaveLength(1)

    const two = seedTitle('two words', 4, 2)
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    splitTitleIntoWordCaptions(two.id)
    expect(seq().tracks[0].clips).toHaveLength(2) // untouched
  })
})

describe('addCaptionsFromWords', () => {
  const words = [
    { text: 'so', startS: 0, endS: 0.3 },
    { text: 'I', startS: 0.3, endS: 0.6 },
    { text: 'trapped', startS: 1.5, endS: 2.0 },
  ]

  it('creates a new top video track carrying the caption run', () => {
    const before = videoTracks(seq()).length
    addCaptionsFromWords(words)

    const vids = videoTracks(seq())
    expect(vids).toHaveLength(before + 1)
    const top = vids[vids.length - 1]
    // AUTO aims at a block LENGTH of 0.45s. Each of these words is 0.3s, so
    // pairing them would overshoot as far as leaving them alone undershoots,
    // and the tie splits: one word per block, which is what the reference
    // channel measured. "trapped" is across a 0.9s pause and could never join.
    expect(top.clips.map((c) => c.title?.text)).toEqual(['so', 'i', 'trapped'])
    expect(top.clips[0].startS).toBeCloseTo(0, 6)
    expect(top.clips[1].startS).toBeCloseTo(0.3, 6)
    expect(top.clips[2].startS).toBeCloseTo(1.5, 6)
    // house style: measured lowercase, white text, black outline, geometric sans
    expect(top.clips[0].title?.outline?.color).toBe('#000000')
    expect(top.clips[0].title?.fontFamily).toContain('Montserrat')
    expect(top.clips[0].appearance).toBeUndefined()
    expect(useStore.getState().ui.selection).toEqual(top.clips.map((c) => c.id))
  })

  it('is one undo step (track and clips vanish together)', () => {
    const before = videoTracks(seq()).length
    addCaptionsFromWords(words)
    expect(videoTracks(seq())).toHaveLength(before + 1)

    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
    expect(allClips()).toHaveLength(0)
  })

  it('does nothing for an empty word list', () => {
    const before = seq().tracks.length
    addCaptionsFromWords([])
    expect(seq().tracks).toHaveLength(before)
  })
})

describe('captions are AUTO, and the block length is what is held steady', () => {
  /** On-screen length of each caption clip, in order. */
  const blockLengths = (): number[] => {
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    return top.clips.map((c) => clipDurationS(c))
  }

  /** Words shown in each caption clip, in order. */
  const blockWords = (): number[] => {
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    return top.clips.map((c) => (c.title?.text ?? '').split(' ').filter(Boolean).length)
  }

  /** Four slow words, then eight fast ones. No word count can even these out. */
  const slowThenFast = (): { text: string; startS: number; endS: number }[] => {
    const words = []
    let t = 0
    for (let i = 0; i < 4; i++) {
      words.push({ text: 'slow' + i, startS: t, endS: t + 0.7 })
      t += 0.75
    }
    for (let i = 0; i < 8; i++) {
      words.push({ text: 'fast' + i, startS: t, endS: t + 0.16 })
      t += 0.2
    }
    return words
  }

  it('runs long ONLY where a single word is simply that long', () => {
    // His ask was "auto-decide how many words it needs per caption so the length
    // of every single text block is the same", and the target does exactly that.
    // But evenness has a floor no rule can go under: a word that takes 0.7s to
    // say occupies 0.7s. The measured reference behaves the same way, its longest
    // block being the single word "invisibility" at 1.3s against a 0.49s mean.
    // So the honest invariant is not "all equal", it is "never long by CHOICE".
    addCaptionsFromWords(slowThenFast())
    const lens = blockLengths()
    const counts = blockWords()
    expect(lens.length).toBeGreaterThan(2)
    for (let i = 0; i < lens.length; i++) {
      if (lens[i] > AUTO_CAPTION_TARGET_S + 0.15) expect(counts[i]).toBe(1)
    }
  })

  it('keeps the blocks it CAN control tight around the target', () => {
    // Every block that holds more than one word was assembled by the rule, so
    // those are the ones evenness is actually a claim about.
    addCaptionsFromWords(slowThenFast())
    const lens = blockLengths()
    const counts = blockWords()
    const built = lens.filter((_, i) => counts[i] > 1)
    expect(built.length).toBeGreaterThan(2)
    expect(Math.max(...built) - Math.min(...built)).toBeLessThan(0.2)
    for (const len of built) expect(Math.abs(len - AUTO_CAPTION_TARGET_S)).toBeLessThan(0.2)
  })

  it('never puts three words on screen at once', () => {
    // Measured: 1 word in 15 of 20 blocks, 2 in the other 5, never 3.
    addCaptionsFromWords(slowThenFast())
    expect(Math.max(...blockWords())).toBeLessThanOrEqual(2)
  })

  it('puts MORE words in a block when he speaks faster', () => {
    // The word count is an output. Same target, twice the speaking rate, so
    // twice the words per block.
    const fast = []
    for (let i = 0; i < 8; i++) fast.push({ text: 'w' + i, startS: i * 0.2, endS: i * 0.2 + 0.16 })
    addCaptionsFromWords(fast)
    const vids = videoTracks(seq())
    const perBlock = vids[vids.length - 1].clips.map((c) => (c.title?.text ?? '').split(' ').length)
    expect(Math.max(...perBlock)).toBeGreaterThan(1)
  })

  it('never lets a block span a real pause, even to hit the target', () => {
    // Matching the voice outranks evenness. He says "green", stops, then says
    // "evil" two seconds later: those can never share a block.
    addCaptionsFromWords([
      { text: 'green', startS: 0, endS: 0.4 },
      { text: 'evil', startS: 2.4, endS: 2.8 },
    ])
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(top.clips.map((c) => c.title?.text)).toEqual(['green', 'evil'])
    expect(top.clips[0].startS + clipDurationS(top.clips[0])).toBeLessThanOrEqual(0.55)
  })

  it('hands over with no blank frame inside a phrase', () => {
    const run = []
    for (let i = 0; i < 8; i++) run.push({ text: 'w' + i, startS: i * 0.3, endS: i * 0.3 + 0.28 })
    addCaptionsFromWords(run)
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    for (let i = 0; i < top.clips.length - 1; i++) {
      const end = top.clips[i].startS + clipDurationS(top.clips[i])
      expect(end).toBeCloseTo(top.clips[i + 1].startS, 5)
    }
  })
})

describe('laying a caption run stays linear in the word count', () => {
  // THE BUG. Every caption is ONE word, and "caption every clip" pools the words
  // of the whole project into a single run, so N is everything he said. Placing
  // them one at a time was O(N^2 log N) inside one synchronous dispatch, with the
  // UI locked: measured 21.6ms at 750 words, 60.6ms at 1500, 168.9ms at 3000 and
  // 540.9ms at 6000. Placing the run in one pass: 3.0, 6.9, 13.0 and 21.7ms.
  // Disable the one-pass path and BOTH assertions below go red (596ms, ratio 3.2).
  //
  // Two assertions on purpose. The budget is generous so a busy machine cannot
  // make it lie, and the ratio catches the SHAPE regardless of machine speed:
  // doubling the words must not much more than double the cost.
  const BUDGET_MS = 300
  const MAX_DOUBLING_COST = 3

  const speech = (n: number): CaptionWord[] =>
    Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startS: i * 0.4, endS: i * 0.4 + 0.35 }))

  /** Lay `n` words onto a fresh project and return the milliseconds it took. */
  function timeRun(n: number): number {
    useStore.getState().setProject(newProject())
    useStore.getState().setUI({ selection: [], playheadS: 0 })
    const words = speech(n)
    const t0 = performance.now()
    addCaptionsFromWords(words)
    return performance.now() - t0
  }

  it('lays 6000 words, about 40 minutes of talking, without the cost squaring', () => {
    timeRun(500) // warm up, so the first real run is not paying for the JIT
    const half = timeRun(3000)
    const full = timeRun(6000)

    expect(full).toBeLessThan(BUDGET_MS)
    expect(full / half).toBeLessThan(MAX_DOUBLING_COST)

    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(top.clips).toHaveLength(6000)
    // and it is still a valid track: ascending, and nothing on top of anything
    for (let i = 1; i < top.clips.length; i++) {
      const prevEnd = top.clips[i - 1].startS + clipDurationS(top.clips[i - 1])
      expect(top.clips[i].startS).toBeGreaterThanOrEqual(prevEnd - 1e-9)
    }
    expect(top.clips[0].title?.text).toBe('w0')
    expect(top.clips[5999].title?.text).toBe('w5999')
  })

  it('falls back to placing one at a time when the run would land on something', () => {
    // Seed a title, then seed a SECOND clip inside the window the split will fill.
    // The one-pass path must refuse this, or a caption lands on top of a clip.
    const title = seedTitle('one two three four five', 2, 5)
    const blocker = seedTitle('blocker', 3, 1)
    splitTitleIntoWordCaptions(title.id)

    const track = seq().tracks[0]
    expect(track.clips.some((c) => c.id === blocker.id)).toBe(true)
    const sorted = [...track.clips].sort((a, b) => a.startS - b.startS)
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].startS + clipDurationS(sorted[i - 1])
      expect(sorted[i].startS).toBeGreaterThanOrEqual(prevEnd - 1e-9)
    }
  })
})
