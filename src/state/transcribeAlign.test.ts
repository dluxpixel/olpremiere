// The word aligner (alignRunner.ts) is asked for by the doors that put a word
// where he said it, and by no others. Proven here at the doors: which of them ask
// the speech worker to time the words, that a word it timed is left alone by the
// lag correction while a word it did not time still gets it, and that a timed
// listening and a raw one of the same clip are two answers, not one. Only the
// worker and the audio are faked; the tidy, the lag correction and the timeline
// mapping are the real ones.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsrChunk } from '../engine/captions/transcribe'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))
// His spellings come out of the saved projects, which node does not have.
vi.mock('./captionVocabulary', () => ({ currentVocabulary: async () => ({ rewrites: [] }) }))

/** What the worker answers for each clip, by clip id. */
const said: Record<string, AsrChunk[]> = {}
/** The clip whose audio was read last, so the fake worker answers for it. */
const listening = { id: '' }
/** Every request the (fake) worker got: the options the door sent along. */
const asked: ({ align?: boolean } | undefined)[] = []

vi.mock('../engine/captions/transcribe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/captions/transcribe')>()
  return {
    ...real,
    extractClipPcm: (_asset: unknown, clip: { id: string }) => {
      listening.id = clip.id
      return Promise.resolve(new Float32Array(8))
    },
    // No audio in node: the music classifier has no opinion, and no opinion keeps every word.
    extractClipPcmAt: () => Promise.reject(new Error('no audio in node')),
    transcribePcm: (_pcm: unknown, _language: unknown, _onProgress: unknown, opts?: { align?: boolean }) => {
      asked.push(opts)
      return { promise: Promise.resolve(said[listening.id] ?? []), cancel: () => {} }
    },
  }
})
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
  whisperModel: () => ({ wordLagS: 0.18 }),
}))
vi.mock('../engine/captions/voiceActivity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/captions/voiceActivity')>()
  return { ...real, voiceTrackForClip: () => Promise.resolve(null) }
})

import { activeSequence, newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { autoCaptionFromClip, forgetHeard, useTranscribe, wordsForClip } from './transcribeActions'
import { listenForWords } from './transcriptActions'

const chunk = (text: string, startS: number, endS: number, aligned?: true): AsrChunk => ({
  text: ` ${text}`,
  timestamp: [startS, endS],
  ...(aligned ? { aligned } : {}),
})

const asset: MediaAsset = { id: 'a', name: 'a', kind: 'audio', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: false }

function seed(): void {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { a: asset } })
  updateActiveSequence('seed', (sq) => {
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === targetId ? { ...t, clips: [{ ...newClipFromAsset(asset, 0), id: 'clip-a', outS: 3 }] } : t,
      ),
    }
  })
}
const theClip = () =>
  activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === 'clip-a')!

beforeEach(() => {
  forgetHeard()
  asked.length = 0
  for (const k of Object.keys(said)) delete said[k]
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
  seed()
})

describe('which doors ask for the word timing', () => {
  it('a caption door and the Words tab do', async () => {
    said['clip-a'] = [chunk('go', 0.3, 0.6), chunk('now.', 0.6, 1.0)]
    await autoCaptionFromClip('clip-a')
    expect(asked).toEqual([{ align: true }])
    forgetHeard()
    asked.length = 0
    await listenForWords('clip-a')
    expect(asked).toEqual([{ align: true }])
  })

  it('the listening the silence cutter uses does not, so it keeps the timings its air is tuned on', async () => {
    said['clip-a'] = [chunk('go', 0.3, 0.6), chunk('now.', 0.6, 1.0)]
    await wordsForClip(theClip(), asset)
    expect(asked).toEqual([{ align: false }])
  })
})

describe('a word the worker timed', () => {
  // "so" was timed by the aligner and stands where he said it. "nice" was not
  // (a word it could not place), so it is still the recogniser's, 0.18 s late.
  const MIXED = [chunk('so', 0.5, 0.9, true), chunk('nice.', 1.0, 1.5)]

  it('keeps its time through the lag correction, and the word beside it that was not timed does not', async () => {
    said['clip-a'] = MIXED
    const words = await wordsForClip(theClip(), asset, { trimToVoice: true })
    expect(words.map((w) => [w.text, +w.startS.toFixed(3)])).toEqual([
      ['so', 0.5],
      ['nice.', 0.82],
    ])
  })

  it('is left where it is by the Words tab too', async () => {
    said['clip-a'] = MIXED
    await listenForWords('clip-a')
    const kept = useStore.getState().project.assets['a']!.words!
    expect(kept.map((w) => [w.text, +w.startS.toFixed(3)])).toEqual([
      ['so', 0.5],
      ['nice.', 0.82],
    ])
  })
})

describe('a timed listening and a raw one of the same clip', () => {
  it('are two answers: the worker is asked once for each, then neither is asked again', async () => {
    said['clip-a'] = [chunk('go', 0.3, 0.6), chunk('now.', 0.6, 1.0)]
    await wordsForClip(theClip(), asset)
    await wordsForClip(theClip(), asset, { trimToVoice: true })
    expect(asked).toEqual([{ align: false }, { align: true }])
    await wordsForClip(theClip(), asset)
    await wordsForClip(theClip(), asset, { trimToVoice: true })
    expect(asked).toHaveLength(2)
  })
})
