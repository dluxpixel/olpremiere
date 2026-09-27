// listenToClip (the Words panel's "listen for words" door) shares wordsForClip
// with autoCaptionFromClip and the sweep, but until now it skipped the
// reversed/stopped refusal both of those got on 2026-09-23 (see
// captionEveryClip.test.ts, "a clip playing backwards or not at all is not
// captioned"). A reversed clip's audio is extracted forward, so Whisper hears
// it right, but timelineWords places the words assuming forward playback
// regardless of speed's sign, so this door was handing wrong word positions
// straight to transcriptActions.toSource and corrupting the asset's stored
// words. Whisper itself is mocked out; this proves the refusal, not the model.

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
vi.mock('../engine/captions/transcribe', () => ({
  TRANSCRIBE_SAMPLE_RATE: 16000,
  extractClipPcm: (_asset: unknown, clip: { id: string }) => {
    heard.push(clip.id)
    return Promise.resolve(new Float32Array(8))
  },
  transcribePcm: () => ({ promise: Promise.resolve([]), cancel: () => {} }),
  wordsFromAsrChunks: () => [],
  tidyTranscribedWords: () => [],
  timelineWords: (_w: unknown, clip: { id: string; startS: number }) => [
    { text: clip.id, startS: clip.startS, endS: clip.startS + 0.4 },
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

import { newClipFromAsset, newProject, type MediaAsset } from '../engine/types'
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

function seedClip(id: string, speed = 1): void {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { [id]: asset(id) } })
  updateActiveSequence('seed', (sq) => {
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === targetId
          ? { ...t, clips: [{ ...newClipFromAsset(asset(id), 0), id: `clip-${id}`, outS: 1, speed }] }
          : t,
      ),
    }
  })
}

beforeEach(() => {
  heard.length = 0
  toasted.length = 0
  useStore.getState().setProject(newProject())
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('listenToClip', () => {
  it('listens to an ordinary forward clip', async () => {
    seedClip('a')
    const words = await listenToClip('clip-a')
    expect(heard).toEqual(['clip-a'])
    expect(words).not.toBeNull()
  })

  it('refuses a reversed clip instead of handing back words mapped the wrong way', async () => {
    seedClip('rev', -1)
    const words = await listenToClip('clip-rev')
    expect(heard).toEqual([])
    expect(words).toBeNull()
    expect(toasted.join(' ')).toContain('plays backwards')
  })

  it('refuses a stopped clip (speed 0), which makes no sound to listen to', async () => {
    seedClip('stopped', 0)
    const words = await listenToClip('clip-stopped')
    expect(heard).toEqual([])
    expect(words).toBeNull()
    expect(toasted.join(' ')).toContain('stopped')
  })

  it('still listens to a clip playing in fast forward', async () => {
    seedClip('fast', 2)
    const words = await listenToClip('clip-fast')
    expect(heard).toEqual(['clip-fast'])
    expect(words).not.toBeNull()
  })
})
