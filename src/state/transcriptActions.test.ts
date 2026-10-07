// The Words panel's Listen keeps what it heard on the media, in source seconds.
// Listening takes tens of seconds and nothing holds the timeline still while it
// runs, so the words have to be turned back into source seconds against the
// clip as it was HEARD, not the clip as it is when the listening ends. Whisper
// is mocked out, the way listenToClip.test.ts does it.

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
  tidyTranscribedWords: () => [],
  // What the real door hands back: the word he said 1 to 1.5 s into the clip,
  // placed on the timeline through the clip it was given.
  timelineWords: (_w: unknown, clip: { startS: number; speed: number }) => [
    { text: 'hi', startS: clip.startS + 1 / Math.abs(clip.speed), endS: clip.startS + 1.5 / Math.abs(clip.speed) },
  ],
}))
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
}))
vi.mock('../engine/captions/voiceActivity', () => ({
  voiceTrackForClip: () => Promise.resolve(null),
  dropWordsWithoutVoice: (words: unknown[]) => words,
}))

import { activeSequence, newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { listenForWords } from './transcriptActions'
import { useTranscribe } from './transcribeActions'

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
