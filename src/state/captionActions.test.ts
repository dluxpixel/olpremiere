import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import {
  addCaptionsFromWords,
  CAPTION_WORDS_DEFAULT,
  getCaptionWordsPerChunk,
  setCaptionWordsPerChunk,
  splitTitleIntoWordCaptions,
} from './captionActions'
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
    // phrase-grouped: "so I" joins (no gap); "trapped" splits off after the 0.9s pause
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

describe('words per caption', () => {
  afterEach(() => setCaptionWordsPerChunk(CAPTION_WORDS_DEFAULT))

  const run = [
    { text: 'one', startS: 0.0, endS: 0.3 },
    { text: 'two', startS: 0.3, endS: 0.6 },
    { text: 'three', startS: 0.6, endS: 0.9 },
    { text: 'four', startS: 0.9, endS: 1.2 },
  ]

  it('clamps to a sane range and round-trips', () => {
    setCaptionWordsPerChunk(99)
    expect(getCaptionWordsPerChunk()).toBe(6)
    setCaptionWordsPerChunk(-4)
    expect(getCaptionWordsPerChunk()).toBe(1)
    setCaptionWordsPerChunk(4)
    expect(getCaptionWordsPerChunk()).toBe(4)
  })

  it('drives EVERY caption entrance without the caller passing it', () => {
    // The right-click auto-caption path calls addCaptionsFromWords with no
    // maxWords at all — the persisted pick has to reach it anyway.
    setCaptionWordsPerChunk(1)
    addCaptionsFromWords(run)
    let top = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(top.clips.map((c) => c.title?.text)).toEqual(['ONE', 'TWO', 'THREE', 'FOUR'])

    useStore.getState().undo()
    setCaptionWordsPerChunk(4)
    addCaptionsFromWords(run)
    top = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(top.clips.length).toBeLessThan(4) // grouped, not one word each
  })

  it('turning the dial up groups SHORT words, and never crams long ones', () => {
    // The whole point of width-governed chunking: the dial buys you more room,
    // and short words are what fit in it.
    const shortWords = [
      { text: 'go', startS: 0.0, endS: 0.3 },
      { text: 'now', startS: 0.3, endS: 0.6 },
      { text: 'get', startS: 0.6, endS: 0.9 },
      { text: 'it', startS: 0.9, endS: 1.2 },
    ]
    const longWords = [
      { text: 'minecraft', startS: 0.0, endS: 0.5 },
      { text: 'diamonds', startS: 0.5, endS: 1.0 },
      { text: 'underground', startS: 1.0, endS: 1.6 },
    ]
    setCaptionWordsPerChunk(4)

    addCaptionsFromWords(shortWords)
    const shortRun = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(shortRun.clips).toHaveLength(1) // 12 chars — they all fit
    useStore.getState().undo()

    addCaptionsFromWords(longWords)
    const longRun = videoTracks(seq())[videoTracks(seq()).length - 1]
    // Same dial, same word ceiling — but these do NOT get crammed together.
    expect(longRun.clips).toHaveLength(3)
  })

  it('an explicit maxWords still wins over the setting', () => {
    setCaptionWordsPerChunk(4)
    addCaptionsFromWords(run, { maxWords: 1 })
    const top = videoTracks(seq())[videoTracks(seq()).length - 1]
    expect(top.clips).toHaveLength(4)
  })
})
