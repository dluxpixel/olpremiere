// "Caption every clip", his ask of 2026-07-28: one option that captions the whole
// timeline instead of right-clicking each clip in turn.
//
// The orchestration is the part worth testing and the part that used to be done by
// hand twelve times: every audible clip is heard, ONE caption track is built from
// all of them, and it is ONE undo step. Whisper itself is mocked out here, because
// what this proves is the plumbing, not the recogniser.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

// One fake word per clip, named after the clip, so the assertions can tell which
// clip's audio a caption came from.
const heard: string[] = []
vi.mock('../engine/captions/transcribe', () => ({
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
vi.mock('../engine/captions/transcribeConfig', () => ({ getCaptionLanguage: () => 'en' }))

import {
  activeSequence,
  newClipFromAsset,
  newProject,
  videoTracks,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { autoCaptionEveryClip, useTranscribe } from './transcribeActions'

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
function seedAudio(specs: { id: string; startS: number }[], opts: { locked?: boolean } = {}): void {
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

beforeEach(() => {
  heard.length = 0
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
    expect(top.clips.map((c) => c.title?.text)).toEqual(['CLIP-A', 'CLIP-B', 'CLIP-C'])
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

  it('refuses to start while another transcription is running', async () => {
    seedAudio([{ id: 'a', startS: 0 }])
    useTranscribe.setState({ status: 'listening' })
    await autoCaptionEveryClip()
    expect(heard).toEqual([])
  })
})
