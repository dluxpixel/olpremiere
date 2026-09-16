// Cutting by the words: the mapping from source words to the timeline, the span
// a run of words occupies, and that a cut takes the SAME seconds off every
// unlocked track so they stay in step.

import { describe, expect, it } from 'vitest'
import { recomputeDuration } from './timeline'
import { cutRange, mergeWords, wordSpan, wordsOnTimeline } from './transcriptCut'
import { clipEndS, defaultTransform, type Clip, type MediaAsset, type Sequence, type SpokenWord, type Track } from './types'

let n = 0
const uid = (prefix: string): string => `${prefix}-${++n}`

const makeClip = (over: Partial<Clip> = {}): Clip => ({
  id: uid('clip'),
  assetId: 'av',
  startS: 0,
  inS: 0,
  outS: 2,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...over,
})

const makeTrack = (over: Partial<Track> = {}): Track => ({
  id: uid('track'),
  kind: 'video',
  name: 'V1',
  height: 64,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips: [],
  ...over,
})

const makeSeq = (tracks: Track[]): Sequence =>
  recomputeDuration({ id: 'seq', name: 'Test', fps: 30, width: 1920, height: 1080, sampleRate: 48000, durationS: 0, tracks, markers: [] })

const w = (text: string, startS: number, endS: number): SpokenWord => ({ text, startS, endS })
const SAID: SpokenWord[] = [w('one', 0.5, 0.9), w('two', 1.5, 1.9), w('three', 2.5, 2.9), w('four', 3.5, 3.9)]
const AV: MediaAsset = { id: 'av', name: 'talk.mp4', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true, words: SAID }
const ASSETS = { av: AV }

describe('wordsOnTimeline', () => {
  it('lays each clip\'s slice of the words onto the timeline through its in point and speed', () => {
    // The clip starts at 10 s on the timeline, shows source 1 to 4 at double speed.
    const clip = makeClip({ startS: 10, inS: 1, outS: 4, speed: 2 })
    const [row] = wordsOnTimeline(makeSeq([makeTrack({ kind: 'audio', clips: [clip] })]), ASSETS)
    expect(row.words.map((x) => x.text)).toEqual(['two', 'three', 'four'])
    expect(row.words[0].atS).toBeCloseTo(10.25, 6)
    expect(row.words[0].endAtS).toBeCloseTo(10.45, 6)
    expect(row.words[0].clipId).toBe(clip.id)
  })

  it('lists a linked pair once, through the half that plays the sound', () => {
    const v = makeClip({ startS: 0, inS: 0, outS: 4, linkId: 'L' })
    const a = makeClip({ startS: 0, inS: 0, outS: 4, linkId: 'L' })
    const rows = wordsOnTimeline(makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })]), ASSETS)
    expect(rows.map((r) => r.clip.id)).toEqual([a.id])
    expect(rows[0].words).toHaveLength(4)
  })

  it('lists a clip whose media was never listened to, with no words, so the panel can offer to listen', () => {
    const quiet: MediaAsset = { ...AV, id: 'q', words: undefined }
    const rows = wordsOnTimeline(makeSeq([makeTrack({ kind: 'audio', clips: [makeClip({ assetId: 'q' })] })]), { q: quiet })
    expect(rows).toHaveLength(1)
    expect(rows[0].words).toEqual([])
  })
})

describe('mergeWords', () => {
  it('replaces what was heard inside the span, keeps the rest, and stays sorted', () => {
    const heard = [w('TWO', 1.4, 1.8), w('THREE', 2.6, 2.95)]
    const merged = mergeWords(SAID, heard, 1, 3)
    expect(merged.map((x) => x.text)).toEqual(['one', 'TWO', 'THREE', 'four'])
  })

  it('starts from nothing', () => {
    expect(mergeWords(undefined, [w('hi', 0, 1)], 0, 5)).toEqual([w('hi', 0, 1)])
  })
})

describe('wordSpan', () => {
  const clip = makeClip({ startS: 0, inS: 0, outS: 4 })
  const words = wordsOnTimeline(makeSeq([makeTrack({ kind: 'audio', clips: [clip] })]), ASSETS)[0].words

  it('runs from the first word to the start of the word after the last, so the pause goes with the words', () => {
    expect(wordSpan(words, 1, 2, 30)).toEqual({ startS: 1.5, endS: 3.5 })
    expect(wordSpan(words, 2, 1, 30)).toEqual({ startS: 1.5, endS: 3.5 })
  })

  it('stops at the last word\'s end when nothing follows it in the clip', () => {
    expect(wordSpan(words, 3, 3, 30)).toEqual({ startS: 3.5, endS: 3.9 })
  })

  it('lands on frame edges and is never shorter than a frame', () => {
    const span = wordSpan([{ ...words[0], atS: 1.234, endAtS: 1.2401 }], 0, 0, 30)!
    expect(span.startS * 30).toBeCloseTo(Math.round(span.startS * 30), 9)
    expect(span.endS - span.startS).toBeCloseTo(1 / 30, 9)
  })
})

describe('cutRange', () => {
  it('takes the same seconds off every unlocked track, gaps included, and leaves locked tracks alone', () => {
    const a = makeClip({ startS: 0, inS: 0, outS: 10 })
    const b1 = makeClip({ startS: 0, inS: 0, outS: 5 })
    const b2 = makeClip({ startS: 7, inS: 0, outS: 3 })
    const music = makeClip({ startS: 0, inS: 0, outS: 10 })
    const seq = makeSeq([
      makeTrack({ clips: [a] }),
      makeTrack({ kind: 'audio', clips: [b1, b2] }),
      makeTrack({ kind: 'audio', name: 'Music', locked: true, clips: [music] }),
    ])
    const next = cutRange(seq, 4, 6)
    const [va, vb, vm] = next.tracks
    // A: 0 to 4, then what was 6 to 10 now 4 to 8, still showing source 6 onward.
    expect(va.clips.map((c) => [c.startS, clipEndS(c), c.inS])).toEqual([
      [0, 4, 0],
      [4, 8, 6],
    ])
    // B: 0 to 4 kept, the 4 to 5 piece gone, and the later clip moved up by the full two seconds.
    expect(vb.clips.map((c) => [c.startS, clipEndS(c)])).toEqual([
      [0, 4],
      [5, 8],
    ])
    expect(vm.clips.map((c) => [c.startS, clipEndS(c)])).toEqual([[0, 10]])
  })

  it('cuts a linked pair together', () => {
    const v = makeClip({ startS: 0, inS: 0, outS: 10, linkId: 'L' })
    const au = makeClip({ startS: 0, inS: 0, outS: 10, linkId: 'L' })
    const next = cutRange(makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [au] })]), 2, 3)
    for (const t of next.tracks) {
      expect(t.clips.map((c) => [c.startS, clipEndS(c), c.inS])).toEqual([
        [0, 2, 0],
        [2, 9, 3],
      ])
    }
  })

  it('does nothing for an empty or backwards range', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip({ outS: 10 })] })])
    expect(cutRange(seq, 3, 3)).toBe(seq)
    expect(cutRange(seq, 5, 3)).toBe(seq)
  })
})

describe('reversed clips', () => {
  it('lay their words out in the order they play, from the out point backwards', () => {
    // Source 0 to 4 played backwards at 10 s: "four" is heard first.
    const clip = makeClip({ startS: 10, inS: 0, outS: 4, speed: -1 })
    const [row] = wordsOnTimeline(makeSeq([makeTrack({ kind: 'audio', clips: [clip] })]), ASSETS)
    expect(row.words.map((x) => x.text)).toEqual(['four', 'three', 'two', 'one'])
    expect(row.words[0].atS).toBeCloseTo(10.1, 6) // 3.9 from the out point of 4
    expect(row.words[0].endAtS).toBeCloseTo(10.5, 6)
    expect(row.words[3].atS).toBeCloseTo(13.1, 6)
  })
})

describe('a locked partner', () => {
  it('is left whole while the unlocked half is cut', () => {
    const v = makeClip({ startS: 0, inS: 0, outS: 10, linkId: 'L' })
    const au = makeClip({ startS: 0, inS: 0, outS: 10, linkId: 'L' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', locked: true, clips: [au] })])
    const next = cutRange(seq, 2, 3)
    expect(next.tracks[0].clips.map((c) => [c.startS, clipEndS(c)])).toEqual([
      [0, 2],
      [2, 9],
    ])
    expect(next.tracks[1].clips.map((c) => [c.startS, clipEndS(c)])).toEqual([[0, 10]])
  })
})
