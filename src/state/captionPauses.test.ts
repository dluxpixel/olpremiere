// His words, 2026-09-28: *"sometimes I just take a big pause between the words,
// and it still groups them together. This shit is so annoying."*
//
// The rule that makes a swallowed pause real is tested on its own in
// engine/captions/voiceActivity.test.ts. This proves the DOORS: both
// auto-caption doors hand the chunker words pulled in to his voice, and the
// shared listening step keeps the recogniser's own timings for the two features
// that cut at them (the Words panel and the silence cutter). Only Whisper and
// the audio are faked. The tidy, the voice filter, the timeline mapping and the
// chunker are all the real ones.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsrChunk } from '../engine/captions/transcribe'
import type { VoiceTrack } from '../engine/captions/voiceActivity'

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

/** What the recogniser hears in each clip, by clip id. */
const said: Record<string, AsrChunk[]> = {}
/** What the voice detector hears in each clip, by clip id. */
const voices: Record<string, VoiceTrack> = {}
/** The clip whose audio was read last, so the fake recogniser answers for it. */
const listening = { id: '' }

vi.mock('../engine/captions/transcribe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/captions/transcribe')>()
  return {
    ...real,
    extractClipPcm: (_asset: unknown, clip: { id: string }) => {
      listening.id = clip.id
      return Promise.resolve(new Float32Array(8))
    },
    // The music classifier reads the audio through this. No audio in node means
    // it has no opinion, and no opinion keeps every word.
    extractClipPcmAt: () => Promise.reject(new Error('no audio in node')),
    transcribePcm: () => ({ promise: Promise.resolve(said[listening.id] ?? []), cancel: () => {} }),
  }
})
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
}))
vi.mock('../engine/captions/voiceActivity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/captions/voiceActivity')>()
  return {
    ...real,
    voiceTrackForClip: (_asset: unknown, clip: { id: string }) => Promise.resolve(voices[clip.id] ?? null),
  }
})

import { activeSequence, newClipFromAsset, newProject, videoTracks, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { autoCaptionEveryClip, autoCaptionFromClip, useTranscribe, wordsForClip } from './transcribeActions'

/** RNNoise's real frame, 10 ms. Quiet everywhere except the voiced spans. */
const FRAME_S = 0.01
const voice = (totalS: number, voiced: [number, number][]): VoiceTrack => {
  const probs = new Float32Array(Math.round(totalS / FRAME_S))
  for (const [fromS, toS] of voiced) {
    for (let f = Math.round(fromS / FRAME_S); f < Math.round(toS / FRAME_S); f++) probs[f] = 1
  }
  return { probs, frameS: FRAME_S, offsetS: 0, clipS: 0 }
}
const chunk = (text: string, startS: number, endS: number): AsrChunk => ({ text: ` ${text}`, timestamp: [startS, endS] })

const asset = (id: string): MediaAsset => ({
  id,
  name: id,
  kind: 'audio',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: false,
})

/** Audio clips on ONE audio track, each with its own sounding asset. */
function seed(clips: { id: string; startS: number; outS: number }[]): void {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: Object.fromEntries(clips.map((c) => [c.id, asset(c.id)])) })
  updateActiveSequence('seed', (sq) => {
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === targetId
          ? {
              ...t,
              clips: clips.map((c) => ({ ...newClipFromAsset(asset(c.id), c.startS), id: `clip-${c.id}`, outS: c.outS })),
            }
          : t,
      ),
    }
  })
}

/** The caption texts on the caption track, in order. */
const captionTexts = (): string[] => {
  const vids = videoTracks(activeSequence(useStore.getState().project))
  return (vids[vids.length - 1]?.clips ?? []).map((c) => c.title?.text ?? '')
}

// He says "i", stops for 0.6 s, then "found it". The recogniser ran "i" to 0.75.
const PAUSED = [chunk('i', 0, 0.75), chunk('found', 0.75, 1.0), chunk('it.', 1.0, 1.3)]
const PAUSED_VOICE = voice(3, [
  [0, 0.15],
  [0.75, 1.3],
])

beforeEach(() => {
  toasted.length = 0
  for (const k of Object.keys(said)) delete said[k]
  for (const k of Object.keys(voices)) delete voices[k]
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('auto captions split where he paused', () => {
  it('right-click Auto-caption: a 0.6 s pause the recogniser hid is a caption break', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = PAUSED
    voices['clip-a'] = PAUSED_VOICE
    await autoCaptionFromClip('clip-a')
    expect(captionTexts()).toEqual(['I', 'found', 'it'])
  })

  it('Caption every clip: the same pause is a break there too', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = PAUSED
    voices['clip-a'] = PAUSED_VOICE
    await autoCaptionEveryClip()
    expect(captionTexts()).toEqual(['I', 'found', 'it'])
  })

  it('a pause sitting on the cut between two clips does not weld their words together', async () => {
    // Clip a is "i" and 0.6 s of him breathing, and the recogniser ran "i" to
    // the end of the clip. Clip b starts right on "found". Pooled onto the
    // timeline the two words touched, and the run used to show "I found".
    seed([
      { id: 'a', startS: 0, outS: 0.75 },
      { id: 'b', startS: 0.75, outS: 0.55 },
    ])
    said['clip-a'] = [chunk('i', 0, 0.75)]
    voices['clip-a'] = voice(3, [[0, 0.15]])
    said['clip-b'] = [chunk('found', 0, 0.25), chunk('it.', 0.25, 0.55)]
    voices['clip-b'] = voice(3, [[0, 0.55]])
    await autoCaptionEveryClip()
    expect(captionTexts()).toEqual(['I', 'found', 'it'])
  })

  it('with no pause in the voice, his words pair up exactly as they did', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = [chunk('go', 0, 0.25), chunk('now', 0.25, 0.5), chunk('okay.', 0.5, 1.0)]
    voices['clip-a'] = voice(3, [[0, 1.0]])
    await autoCaptionFromClip('clip-a')
    expect(captionTexts()).toEqual(['go now', 'okay'])
  })
})

describe('the listening step itself', () => {
  it('keeps the recogniser timings unless a caption door asks, so the Words panel and the silence cutter are unchanged', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = PAUSED
    voices['clip-a'] = PAUSED_VOICE
    const clip = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === 'clip-a')!
    const plain = await wordsForClip(clip, asset('a'))
    expect(plain.map((x) => [x.text, x.startS, x.endS])).toEqual([
      ['i', 0, 0.75],
      ['found', 0.75, 1.0],
      ['it.', 1.0, 1.3],
    ])
    const trimmed = await wordsForClip(clip, asset('a'), { trimToVoice: true })
    expect(trimmed[0]!.endS).toBeCloseTo(0.15, 6)
  })
})
