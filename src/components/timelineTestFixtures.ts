import { recomputeDuration } from '../engine/timeline'
import { defaultTransform, type Clip, type MediaAsset, type Sequence, type Track } from '../engine/types'

// Shared fixtures for the timeline module tests. Not a test file itself, so
// vitest never collects it.

let n = 0
const uid = (prefix: string): string => `${prefix}-${++n}`

export const makeClip = (over: Partial<Clip> = {}): Clip => ({
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

export const makeTrack = (over: Partial<Track> = {}): Track => ({
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

export const makeSeq = (tracks: Track[], over: Partial<Sequence> = {}): Sequence =>
  recomputeDuration({
    id: 'seq',
    name: 'Test',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 0,
    tracks,
    markers: [],
    ...over,
  })

export const makeAsset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: uid('asset'),
  name: 'a.mp4',
  kind: 'video',
  blobKey: 'blob',
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
  ...over,
})

/** A 10 second video with sound, id `av`, the asset every fixture clip points at. */
export const AV = makeAsset({ id: 'av', durationS: 10 })
export const ASSETS: Record<string, MediaAsset> = { av: AV }
