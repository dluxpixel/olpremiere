// His words, 2026-09-28: *"sometimes I just take a big pause between the words,
// and it still groups them together. This shit is so annoying."*
//
// The rule that makes a swallowed pause real is tested on its own in
// engine/captions/voiceActivity.test.ts. This proves the DOORS: both
// auto-caption doors hand the chunker words pulled in to his voice, and the
// shared listening step keeps the recogniser's own timings for the silence
// cutter, whose air is tuned on them. The Words tab gets the lag taken off but
// no trim (CA-9), because it cuts from word start to word start. Only Whisper and
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
/** How many times the (fake) speech model actually ran. */
const recogniserRuns = { n: 0 }
/** Something he does while the model is busy. */
const duringListen: { fn: (() => void) | null } = { fn: null }

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
    transcribePcm: () => {
      recogniserRuns.n++
      duringListen.fn?.()
      return { promise: Promise.resolve(said[listening.id] ?? []), cancel: () => {} }
    },
  }
})
/** The recogniser's lag the caption doors take off (wordTiming.ts). 0 unless a test sets it. */
const lag = { s: 0 }
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => false,
  modelFor: () => 'onnx-community/whisper-small.en_timestamped',
  whisperModel: () => ({ wordLagS: lag.s }),
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
import { autoCaptionEveryClip, autoCaptionFromClip, forgetHeard, useTranscribe, wordsForClip } from './transcribeActions'
import { listenForWords } from './transcriptActions'

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
  // Every test says its own words; a clip heard in the last one must not answer.
  forgetHeard()
  recogniserRuns.n = 0
  duringListen.fn = null
  lag.s = 0
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
  it('hands back the recogniser timings unless a caption door asks, so the silence cutter is unchanged', async () => {
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

// CA-5. Captioning a clip, listening to it for words, captioning it again in
// another style: three full runs of the speech model for the same answer.
describe('an unchanged clip is heard once', () => {
  it('two caption runs on the same clip run the speech model once', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = PAUSED
    voices['clip-a'] = PAUSED_VOICE
    await autoCaptionFromClip('clip-a')
    await autoCaptionFromClip('clip-a')
    expect(recogniserRuns.n).toBe(1)
    expect(captionTexts()).toEqual(['I', 'found', 'it'])
  })

  it('a clip trimmed since is heard again', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = PAUSED
    await autoCaptionFromClip('clip-a')
    updateActiveSequence('trim', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'clip-a' ? { ...c, outS: 2 } : c)) })),
    }))
    await autoCaptionFromClip('clip-a')
    expect(recogniserRuns.n).toBe(2)
  })
})

// CA-9. The Words tab cut at the recogniser's raw times, a fifth of a second
// late, so a cut left the start of the cut word and took the start of the next.
describe('the Words tab keeps words where he said them', () => {
  const storedWords = (id: string) => useStore.getState().project.assets[id]!.words!.map((w) => [w.text, +w.startS.toFixed(3)])

  it('takes the recogniser lag off what it keeps, and marks the media', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = [chunk('so', 0.68, 1.0), chunk('nice.', 1.0, 1.5)]
    lag.s = 0.18
    await listenForWords('clip-a')
    expect(storedWords('a')).toEqual([
      ['so', 0.5],
      ['nice.', 0.82],
    ])
    expect(useStore.getState().project.assets['a']!.wordsOnVoice).toBe(true)
  })

  it('a clip moved while it is heard still keeps each word at its own second of the media', async () => {
    seed([{ id: 'a', startS: 5, outS: 3 }])
    said['clip-a'] = [chunk('hey', 1.0, 1.3)]
    duringListen.fn = () =>
      updateActiveSequence('he drags it', (sq) => ({
        ...sq,
        tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'clip-a' ? { ...c, startS: 9 } : c)) })),
      }))
    await listenForWords('clip-a')
    expect(storedWords('a')).toEqual([['hey', 1]])
  })
})

describe('captions land when he says the word', () => {
  // The recogniser stamps every word late (wordTiming.ts, measured on his own
  // takes). Here it heard "so nice." 0.18 s after he said it.
  const LATE = [chunk('so', 0.68, 1.0), chunk('nice.', 1.0, 1.5)]
  const SAID = voice(3, [[0.5, 1.32]])

  it('a caption door takes the lag off, so the caption comes on as he starts the word', async () => {
    lag.s = 0.18
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = LATE
    voices['clip-a'] = SAID
    await autoCaptionFromClip('clip-a')
    const vids = videoTracks(activeSequence(useStore.getState().project))
    const caps = vids[vids.length - 1]!.clips
    expect(caps.map((c) => c.title?.text)).toEqual(['so nice'])
    expect(caps[0]!.startS).toBeCloseTo(0.5, 6)
  })

  it('the silence cutter keeps the recogniser timings, lag and all (the Words tab gets the lag off, CA-9)', async () => {
    lag.s = 0.18
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = LATE
    voices['clip-a'] = SAID
    const clip = activeSequence(useStore.getState().project)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === 'clip-a')!
    const plain = await wordsForClip(clip, asset('a'))
    expect(plain.map((x) => [x.text, x.startS, x.endS])).toEqual([
      ['so', 0.68, 1.0],
      ['nice.', 1.0, 1.5],
    ])
  })

  it('every caption starts and ends on a frame of the sequence', async () => {
    seed([{ id: 'a', startS: 0, outS: 3 }])
    said['clip-a'] = [chunk('go', 0.013, 0.271), chunk('now.', 0.271, 0.533)]
    voices['clip-a'] = voice(3, [[0, 0.533]])
    await autoCaptionFromClip('clip-a')
    const seq = activeSequence(useStore.getState().project)
    const vids = videoTracks(seq)
    const caps = vids[vids.length - 1]!.clips
    expect(caps.length).toBeGreaterThan(0)
    for (const c of caps) {
      expect(c.startS * seq.fps).toBeCloseTo(Math.round(c.startS * seq.fps), 6)
      expect((c.startS + (c.outS - c.inS)) * seq.fps).toBeCloseTo(Math.round((c.startS + (c.outS - c.inS)) * seq.fps), 6)
    }
  })
})
