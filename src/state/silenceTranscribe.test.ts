// "Cut the quiet parts" listens through the same door as the caption runs and
// the Words panel, so it has to leave that door the way it found it. It used to
// call the recogniser bare: the listening pill stayed on screen after the cut,
// and every caption door and the Words panel then said "A transcription is
// already running" until a restart. Whisper itself is mocked out, the way
// listenToClip.test.ts does it; this proves the door, not the model.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasted: string[] = []
vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string) => {
        toasted.push(message)
      },
    }),
  },
}))

const heard: string[] = []
/** How far into the clip the one heard word starts, and the recogniser's lag the cutter takes off. */
const wordAt = { s: 0 }
const lag = { s: 0 }
vi.mock('../engine/captions/transcribe', () => ({
  TRANSCRIBE_SAMPLE_RATE: 16000,
  extractClipPcm: (_asset: unknown, clip: { id: string }) => {
    heard.push(clip.id)
    return Promise.resolve(new Float32Array(8))
  },
  transcribePcm: () => ({ promise: Promise.resolve([]), cancel: () => {} }),
  wordsFromAsrChunks: () => [],
  tidyTranscribedWords: () => [],
  // One word at the head of the clip, in timeline seconds like the real one.
  timelineWords: (_w: unknown, clip: { startS: number }) => [
    { text: 'hi', startS: clip.startS + wordAt.s, endS: clip.startS + wordAt.s + 0.4 },
  ],
}))
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
  whisperModel: () => ({ wordLagS: lag.s }),
}))
// His spellings are read from every other project, which needs a database this
// test does not have: none are taught here.
vi.mock('./captionVocabulary', () => ({ currentVocabulary: async () => ({ rewrites: [] }) }))
vi.mock('../engine/captions/voiceActivity', () => ({
  voiceTrackForClip: () => Promise.resolve(null),
  dropWordsWithoutVoice: (words: unknown[]) => words,
}))

import { newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
import { cutQuietParts } from './silenceActions'
import { updateActiveSequence, useStore } from './store'
import { listenToClip, useTranscribe } from './transcribeActions'

const asset = (id: string): MediaAsset => ({
  id,
  name: id,
  kind: 'audio',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: false,
})

function seedClip(id: string): void {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { [id]: asset(id) } })
  updateActiveSequence('seed', (sq) => {
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === targetId ? { ...t, clips: [{ ...newClipFromAsset(asset(id), 0), id: `clip-${id}`, outS: 4 }] } : t,
      ),
    }
  })
}

beforeEach(() => {
  heard.length = 0
  toasted.length = 0
  wordAt.s = 0
  lag.s = 0
  useStore.getState().setProject(newProject())
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('Cut the quiet parts and the transcription door', () => {
  it('puts the status back to idle, so the caption doors and the Words panel still work after it', async () => {
    seedClip('a')
    await cutQuietParts('clip-a')
    expect(heard).toEqual(['clip-a'])
    expect(useTranscribe.getState().status).toBe('idle')

    toasted.length = 0
    expect(await listenToClip('clip-a')).not.toBeNull()
    expect(toasted.join(' ')).not.toContain('already running')
  })

  it('waits its turn: while another transcription runs it says so and reads nothing', async () => {
    seedClip('a')
    useTranscribe.setState({ status: 'listening' })
    await cutQuietParts('clip-a')
    expect(heard).toEqual([])
    expect(toasted.join(' ')).toContain('already running')
    // And it leaves the other run's status alone.
    expect(useTranscribe.getState().status).toBe('listening')
  })
})

// Review B2. Taking the recogniser's lag off a word that starts just inside the
// clip carries it back past the clip's in point, and the Words tab drops a word
// that starts before it. The cutter keeps the word at the in point instead.
describe('Cut the quiet parts keeps what it heard inside the clip', () => {
  it('a first word the lag would carry before the in point starts at the in point', async () => {
    lag.s = 0.18
    wordAt.s = 0.05
    const s = useStore.getState()
    s.setProject({ ...s.project, assets: { a: { ...asset('a'), wordsOnVoice: true } } })
    updateActiveSequence('seed', (sq) => {
      const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
      return {
        ...sq,
        tracks: sq.tracks.map((t) =>
          t.id === targetId ? { ...t, clips: [{ ...newClipFromAsset(asset('a'), 0), id: 'clip-a', inS: 2, outS: 6 }] } : t,
        ),
      }
    })
    await cutQuietParts('clip-a')
    expect(heard).toEqual(['clip-a'])
    const words = useStore.getState().project.assets['a']!.words ?? []
    expect(words.map((w) => w.text)).toEqual(['hi'])
    expect(words[0]!.startS).toBe(2)
    expect(words[0]!.endS).toBeGreaterThanOrEqual(words[0]!.startS)
  })
})
