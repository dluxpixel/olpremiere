// The Words panel's Listen keeps what it heard on the media, in source seconds.
// Listening takes tens of seconds and nothing holds the timeline still while it
// runs, so the words are put in source seconds against the clip as it was HEARD
// (listenToClip hands back { clip, asset, words } in the media's own seconds),
// never against the clip as it is when the listening ends. Whisper is mocked
// out, the way listenToClip.test.ts does it.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

/** Run while "Whisper" listens: he edits the timeline meanwhile. */
let duringListen: () => void = () => {}
vi.mock('../engine/captions/transcribe', () => ({
  TRANSCRIBE_SAMPLE_RATE: 16000,
  extractClipPcm: () => Promise.resolve(new Float32Array(8)),
  transcribePcm: () => {
    duringListen()
    return { promise: Promise.resolve([]), cancel: () => {} }
  },
  wordsFromAsrChunks: () => [],
  // What the recogniser heard: the word he said 1 to 1.5 s into the clip, in
  // clip time. listenToClip turns it into the media's seconds through the
  // clip's in point, from the clip as it stood when the listening began.
  tidyTranscribedWords: () => [{ text: 'hi', startS: 1, endS: 1.5 }],
  // The caption door's answer, placed on the timeline. Listen ignores it (it
  // keeps the media's seconds), but it must not be empty or nobody "talked".
  timelineWords: (_w: unknown, clip: { startS: number; speed: number }) => [
    { text: 'hi', startS: clip.startS + 1 / Math.abs(clip.speed), endS: clip.startS + 1.5 / Math.abs(clip.speed) },
  ],
}))
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
  whisperModel: () => ({ wordLagS: 0 }),
}))
// His spellings are read from every other project, which needs a database this
// test does not have: none are taught here.
vi.mock('./captionVocabulary', () => ({ currentVocabulary: async () => ({ rewrites: [] }) }))
vi.mock('../engine/captions/voiceActivity', () => ({
  voiceTrackForClip: () => Promise.resolve(null),
  dropWordsWithoutVoice: (words: unknown[]) => words,
}))

import { activeSequence, newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { listenForWords } from './transcriptActions'
import { forgetHeard, useTranscribe } from './transcribeActions'

const ASSET: MediaAsset = { id: 'a', name: 'take.wav', kind: 'audio', blobKey: 'b', durationS: 20, hasAudio: true, hasVideo: false }

function seedClip(over: { startS: number; inS: number; outS: number }): void {
  const s = useStore.getState()
  s.setProject({ ...newProject(), assets: { a: ASSET } })
  updateActiveSequence('seed', (sq) => {
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) => (t.id === targetId ? { ...t, clips: [{ ...newClipFromAsset(ASSET, 0), id: 'c', ...over }] } : t)),
    }
  })
}

const moveClip = (dS: number) =>
  updateActiveSequence('drag', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, startS: c.startS + dS })) })),
  }))

const words = () => useStore.getState().project.assets.a?.words ?? []

beforeEach(() => {
  duringListen = () => {}
  // The recogniser keeps what it heard for the same stretch of the same media, so
  // without this the drag test would never reach the model and never drag.
  forgetHeard()
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('Listen keeps the words where they were said', () => {
  it('in source seconds, through the clip in point', async () => {
    seedClip({ startS: 3, inS: 4, outS: 10 })
    await listenForWords('c')
    expect(words()).toHaveLength(1)
    expect(words()[0]!.startS).toBeCloseTo(5, 6)
    expect(words()[0]!.endS).toBeCloseTo(5.5, 6)
  })

  it('and remembers which stretch of the file was heard, so its quiet is known to be quiet', async () => {
    seedClip({ startS: 3, inS: 4, outS: 10 })
    await listenForWords('c')
    expect(useStore.getState().project.assets.a?.heardSpans).toEqual([{ fromS: 4, toS: 10 }])
  })

  it('⛔ when he drags the clip while it listens, the words stay on what he said', async () => {
    seedClip({ startS: 3, inS: 4, outS: 10 })
    duringListen = () => moveClip(5)
    await listenForWords('c')
    // Still where he said it: 1 s into the clip is source 5, wherever the clip went.
    expect(activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips)[0]!.startS).toBe(8)
    expect(words()[0]!.startS).toBeCloseTo(5, 6)
    expect(words()[0]!.endS).toBeCloseTo(5.5, 6)
  })
})
