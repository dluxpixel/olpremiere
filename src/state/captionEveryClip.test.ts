// "Caption every clip", his ask of 2026-07-28: one option that captions the whole
// timeline instead of right-clicking each clip in turn.
//
// The orchestration is the part worth testing and the part that used to be done by
// hand twelve times: every audible clip is heard, ONE caption track is built from
// all of them, and it is ONE undo step. Whisper itself is mocked out here, because
// what this proves is the plumbing, not the recogniser.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every toast the run raised, so the tests can prove the app SAYS what it did
// rather than silently doing nothing.
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

// One fake word per clip, named after the clip, so the assertions can tell which
// clip's audio a caption came from.
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
// The keyword highlight is ON by default, so this orchestration test walks the
// same path he does. The picker itself is real (it is pure and cheap); what is
// faked here is only the recogniser.
vi.mock('../engine/captions/transcribeConfig', () => ({
  getCaptionLanguage: () => 'en',
  getCaptionEmphasis: () => true,
}))
// The voice detector has NO opinion here (no wasm in node), which is the path
// that has to keep every word Whisper heard. Its own rule is tested against a
// synthesised probability track in engine/captions/voiceActivity.test.ts.
vi.mock('../engine/captions/voiceActivity', () => ({
  voiceTrackForClip: () => Promise.resolve(null),
  dropWordsWithoutVoice: (words: unknown[]) => words,
}))

import {
  activeSequence,
  newClipFromAsset,
  newProject,
  videoTracks,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { autoCaptionEveryClip, autoCaptionFromClip, useTranscribe } from './transcribeActions'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const asset = (id: string): MediaAsset => ({
  id,
  name: id,
  kind: 'audio',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: false,
})

/** Put audio clips on the first audio track, each with its own sounding asset. */
function seedAudio(
  specs: { id: string; startS: number }[],
  opts: { locked?: boolean; audioRole?: 'voice' | 'music' } = {},
): void {
  const s = useStore.getState()
  s.setProject({
    ...s.project,
    assets: Object.fromEntries(specs.map((sp) => [sp.id, asset(sp.id)])),
  })
  updateActiveSequence('seed', (sq) => {
    // ONE audio track only. A new project has several, and seeding them all would
    // give every clip a twin and quietly make this whole file test the wrong thing.
    const targetId = sq.tracks.find((t) => t.kind === 'audio')?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === targetId
          ? {
              ...t,
              locked: opts.locked ?? false,
              ...(opts.audioRole ? { audioRole: opts.audioRole } : {}),
              clips: specs.map((sp) => ({
                ...newClipFromAsset(asset(sp.id), sp.startS),
                id: `clip-${sp.id}`, // named, so the assertions can name it back
                outS: 1,
              })),
            }
          : t,
      ),
    }
  })
}

/** Two sounding audio tracks, one marked music and one marked voice. */
function seedMusicAndVoice(): void {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { bed: asset('bed'), vo: asset('vo') } })
  updateActiveSequence('seed music + voice', (sq) => {
    const audio = sq.tracks.filter((t) => t.kind === 'audio')
    const musicId = audio[0]?.id
    const voiceId = audio[1]?.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) => {
        if (t.id === musicId) {
          return {
            ...t,
            audioRole: 'music' as const,
            clips: [{ ...newClipFromAsset(asset('bed'), 0), id: 'clip-bed', outS: 1 }],
          }
        }
        if (t.id === voiceId) {
          return {
            ...t,
            audioRole: 'voice' as const,
            clips: [{ ...newClipFromAsset(asset('vo'), 0), id: 'clip-vo', outS: 1 }],
          }
        }
        return { ...t, clips: [] }
      }),
    }
  })
}

beforeEach(() => {
  heard.length = 0
  toasted.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('autoCaptionEveryClip', () => {
  it('hears every clip that has sound, in the order it plays', async () => {
    seedAudio([
      { id: 'b', startS: 4 },
      { id: 'a', startS: 0 },
    ])
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-a', 'clip-b'])
  })

  it('lands ONE caption track for the whole timeline, not one per clip', async () => {
    const before = videoTracks(seq()).length
    seedAudio([
      { id: 'a', startS: 0 },
      { id: 'b', startS: 4 },
      { id: 'c', startS: 8 },
    ])
    await autoCaptionEveryClip()

    const vids = videoTracks(seq())
    expect(vids).toHaveLength(before + 1) // three clips, ONE new track
    const top = vids[vids.length - 1]
    expect(top.clips.map((c) => c.title?.text)).toEqual(['clip-a', 'clip-b', 'clip-c'])
  })

  it('is one undo step for the whole run', async () => {
    const before = videoTracks(seq()).length
    seedAudio([
      { id: 'a', startS: 0 },
      { id: 'b', startS: 4 },
    ])
    await autoCaptionEveryClip()
    expect(videoTracks(seq())).toHaveLength(before + 1)

    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
    expect(seq().tracks.flatMap((t) => t.clips.filter((c) => c.title))).toHaveLength(0)
  })

  it('says which clip it is on, so a long run does not look stuck', async () => {
    seedAudio([
      { id: 'a', startS: 0 },
      { id: 'b', startS: 4 },
    ])
    const seen: (number | null)[] = []
    const stop = useTranscribe.subscribe((s) => seen.push(s.queue?.index ?? null))
    await autoCaptionEveryClip()
    stop()
    expect(seen).toContain(1)
    expect(seen).toContain(2)
    // and it is cleared when the run ends, so the pill cannot keep a stale count
    expect(useTranscribe.getState().queue).toBeNull()
  })

  it('leaves a locked track alone', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { locked: true })
    await autoCaptionEveryClip()
    expect(heard).toEqual([])
  })

  // His report, 2026-08-09: "with the auto caption, it also captions music."
  // A track he has marked as music is a backing bed, so every word Whisper finds
  // in it is a mishearing of a melody. It must never reach the recogniser.
  it('leaves a track marked as music alone', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { audioRole: 'music' })
    await autoCaptionEveryClip()
    expect(heard).toEqual([])
  })

  it('says the music track is why nothing happened, instead of claiming no sound', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { audioRole: 'music' })
    await autoCaptionEveryClip()
    expect(toasted.join(' ')).toContain('music track')
  })

  it('captions the voice track and skips the music bed under it', async () => {
    seedMusicAndVoice()
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-vo'])
  })

  // The failure that would cost him work is a MISSING caption, so only the
  // explicit 'music' mark is allowed to skip anything. Unmarked is the default
  // and nothing sets it automatically, so an unmarked voiceover must still run.
  it('still captions a track he has not marked at all', async () => {
    seedAudio([{ id: 'a', startS: 0 }])
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-a'])
  })

  it('still captions a track he has marked as voice', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { audioRole: 'voice' })
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-a'])
  })

  it('skips the music track on the selection path too', async () => {
    seedMusicAndVoice()
    await autoCaptionEveryClip(undefined, new Set(['clip-bed', 'clip-vo']))
    expect(heard).toEqual(['clip-vo'])
  })

  it('refuses to start while another transcription is running', async () => {
    seedAudio([{ id: 'a', startS: 0 }])
    useTranscribe.setState({ status: 'listening' })
    await autoCaptionEveryClip()
    expect(heard).toEqual([])
  })

  // Dropping a video with sound makes a LINKED PAIR: a video-track clip and an
  // audio-track clip sharing one assetId, one linkId, and the same in/out. Both
  // report hasAudio, because it is one asset. Filtering on the asset therefore
  // heard the same take twice and laid both word sets at the SAME timeline
  // moment, so every caption came out doubled and the Whisper wait doubled with
  // it. That is the normal way footage arrives, so it hit every real project,
  // and got worse the more clips there were.
  it('hears a linked video plus audio pair ONCE, not once per half', async () => {
    const av: MediaAsset = {
      id: 'av',
      name: 'av',
      kind: 'video',
      blobKey: 'b',
      durationS: 10,
      hasAudio: true,
      hasVideo: true,
    }
    const s = useStore.getState()
    s.setProject({ ...s.project, assets: { av } })
    updateActiveSequence('seed linked pair', (sq) => {
      const vId = sq.tracks.find((t) => t.kind === 'video')?.id
      const aId = sq.tracks.find((t) => t.kind === 'audio')?.id
      return {
        ...sq,
        tracks: sq.tracks.map((t) => {
          if (t.id === vId) {
            return { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'clip-video', outS: 1, linkId: 'pair' }] }
          }
          if (t.id === aId) {
            return { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'clip-audio', outS: 1, linkId: 'pair' }] }
          }
          return { ...t, clips: [] }
        }),
      }
    })
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-audio'])
  })

  it('still hears an UNLINKED video clip, whose sound has no audio-track partner', async () => {
    const av: MediaAsset = {
      id: 'solo',
      name: 'solo',
      kind: 'video',
      blobKey: 'b',
      durationS: 10,
      hasAudio: true,
      hasVideo: true,
    }
    const s = useStore.getState()
    s.setProject({ ...s.project, assets: { solo: av } })
    updateActiveSequence('seed unlinked video', (sq) => {
      const vId = sq.tracks.find((t) => t.kind === 'video')?.id
      return {
        ...sq,
        tracks: sq.tracks.map((t) =>
          t.id === vId ? { ...t, clips: [{ ...newClipFromAsset(av, 0), id: 'clip-solo', outS: 1 }] } : { ...t, clips: [] },
        ),
      }
    })
    await autoCaptionEveryClip()
    expect(heard).toEqual(['clip-solo'])
  })
})

// The single-clip door is him pointing at ONE thing on purpose. The sweep doors
// skip a music track; this one deliberately does not, because refusing would be
// the app arguing with a deliberate right-click. It says what it is doing so the
// two rules cannot look like the same rule quietly disagreeing.
describe('autoCaptionFromClip on a music track', () => {
  it('still runs, because he pointed at that clip himself', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { audioRole: 'music' })
    await autoCaptionFromClip('clip-a')
    expect(heard).toEqual(['clip-a'])
  })

  it('says out loud that the clip is on his music track', async () => {
    seedAudio([{ id: 'a', startS: 0 }], { audioRole: 'music' })
    await autoCaptionFromClip('clip-a')
    expect(toasted.join(' ')).toContain('music track')
  })

  it('says nothing about music for an ordinary clip', async () => {
    seedAudio([{ id: 'a', startS: 0 }])
    await autoCaptionFromClip('clip-a')
    // The "captions added" toast is the normal one; the music note must not fire.
    expect(toasted.join(' ')).not.toContain('music')
  })
})
