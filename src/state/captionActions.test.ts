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
    // AUTO aims at a block LENGTH: "so" and "I" are said back to back and are
    // short, so they share a block, while "trapped" is across a 0.9s pause and
    // can never join them.
    expect(top.clips.map((c) => c.title?.text)).toEqual(['SO I', 'TRAPPED'])
    expect(top.clips[0].startS).toBeCloseTo(0, 6)
    expect(top.clips[1].startS).toBeCloseTo(1.5, 6)
    // house style: white 8%-height text, black outline, comic caption face
    expect(top.clips[0].title?.outline?.color).toBe('#000000')
    expect(top.clips[0].title?.fontFamily).toContain('Lilita One')
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

describe('captions are AUTO, and every block is the same length', () => {
  /** On-screen length of each caption clip, in order. */
  const blockLengths = (): number[] => {
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    return top.clips.map((c) => clipDurationS(c))
  }

  it('makes the blocks even, whether he talks fast or slow', () => {
    // THE ask, in his words: "auto-decide how many words it needs per caption so
    // the length of every single text block is the same". Four slow words then
    // eight fast ones: a word count cannot make those even, a target length can.
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
    addCaptionsFromWords(words)
    // The LAST block is whatever is left over and cannot be evened out, so the
    // claim is about the run, not the remainder.
    const lens = blockLengths().slice(0, -1)
    expect(lens.length).toBeGreaterThan(2)
    const spread = Math.max(...lens) - Math.min(...lens)
    expect(spread).toBeLessThan(0.2)
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
    expect(top.clips.map((c) => c.title?.text)).toEqual(['GREEN', 'EVIL'])
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
