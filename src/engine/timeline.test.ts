import { describe, expect, it } from 'vitest'
import { defaultTransform, type Clip, type MediaAsset, type Sequence, type Track } from './types'
import {
  addClipFromAsset,
  addMarker,
  canPlace,
  clipDurationS,
  clipEndS,
  collectSnapPoints,
  deleteClip,
  duplicateClips,
  findClip,
  moveClip,
  moveMarker,
  pasteClips,
  pxToTime,
  recomputeDuration,
  removeMarker,
  removeMarkerNear,
  resolveStart,
  rippleDelete,
  rippleTrimTo,
  rollEditTo,
  sequenceDurationS,
  serializeClips,
  slideClip,
  slipClip,
  snapTime,
  splitClip,
  timeToPx,
  trimClipTo,
} from './timeline'

// ---------------------------------------------------------------------------
// Fixtures

let n = 0
const uid = (prefix: string): string => `${prefix}-${++n}`

const makeClip = (over: Partial<Clip> = {}): Clip => ({
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

const makeTrack = (over: Partial<Track> = {}): Track => ({
  id: uid('track'),
  kind: 'video',
  name: 'V1',
  height: 64,
  muted: false,
  solo: false,
  locked: false,
  clips: [],
  ...over,
})

const makeSeq = (tracks: Track[], over: Partial<Sequence> = {}): Sequence =>
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

const makeAsset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: uid('asset'),
  name: 'a.mp4',
  kind: 'video',
  blobKey: 'blob',
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
  ...over,
})

// Shared asset table for trim tests: av = 10s video, ai = still image.
const AV = makeAsset({ id: 'av', durationS: 10 })
const AI = makeAsset({ id: 'ai', kind: 'image', durationS: 0, hasAudio: false })
const ASSETS: Record<string, MediaAsset> = { av: AV, ai: AI }

const FRAME = 1 / 30

// ---------------------------------------------------------------------------

describe('clipDurationS / clipEndS', () => {
  it('is outS - inS at speed 1', () => {
    expect(clipDurationS(makeClip({ inS: 1, outS: 4 }))).toBe(3)
  })
  it('halves at speed 2', () => {
    expect(clipDurationS(makeClip({ inS: 0, outS: 4, speed: 2 }))).toBe(2)
  })
  it('doubles at speed 0.5', () => {
    expect(clipDurationS(makeClip({ inS: 0, outS: 2, speed: 0.5 }))).toBe(4)
  })
  it('uses absolute speed for reverse', () => {
    expect(clipDurationS(makeClip({ inS: 0, outS: 2, speed: -1 }))).toBe(2)
  })
  it('treats speed 0 as 1', () => {
    expect(clipDurationS(makeClip({ inS: 0, outS: 2, speed: 0 }))).toBe(2)
  })
  it('clipEndS = startS + duration', () => {
    expect(clipEndS(makeClip({ startS: 2, inS: 1, outS: 4 }))).toBe(5)
  })
})

describe('sequenceDurationS / recomputeDuration', () => {
  it('is 0 for an empty sequence', () => {
    expect(sequenceDurationS(makeSeq([makeTrack(), makeTrack({ kind: 'audio' })]))).toBe(0)
  })
  it('takes the max clip end across all tracks', () => {
    const seq = makeSeq([
      makeTrack({ clips: [makeClip({ startS: 0, outS: 2 })] }),
      makeTrack({ kind: 'audio', clips: [makeClip({ startS: 1, outS: 3 })] }),
    ])
    expect(sequenceDurationS(seq)).toBe(4)
  })
  it('recomputeDuration returns the same reference when already in sync', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip({ outS: 2 })] })])
    expect(recomputeDuration(seq)).toBe(seq)
  })
  it('recomputeDuration fixes a stale durationS', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip({ outS: 2 })] })])
    const stale = { ...seq, durationS: 99 }
    expect(recomputeDuration(stale).durationS).toBe(2)
  })
})

describe('findClip', () => {
  it('returns track/clip with indices', () => {
    const c = makeClip({ startS: 3 })
    const seq = makeSeq([makeTrack(), makeTrack({ clips: [makeClip(), c] })])
    const found = findClip(seq, c.id)
    expect(found?.trackIndex).toBe(1)
    expect(found?.clipIndex).toBe(1)
    expect(found?.clip).toBe(c)
    expect(found?.track).toBe(seq.tracks[1])
  })
  it('returns null for an unknown id', () => {
    expect(findClip(makeSeq([makeTrack()]), 'nope')).toBeNull()
  })
})

describe('canPlace', () => {
  it('always true on an empty track', () => {
    expect(canPlace(makeTrack(), 0, 5)).toBe(true)
  })
  it('rejects a straddling overlap', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 0, outS: 2 })] })
    expect(canPlace(track, 1, 2)).toBe(false)
  })
  it('rejects a fully contained placement', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 0, outS: 4 })] })
    expect(canPlace(track, 1, 1)).toBe(false)
  })
  it('allows touching: new start == existing end', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 0, outS: 2 })] })
    expect(canPlace(track, 2, 2)).toBe(true)
  })
  it('allows touching: new end == existing start', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 2, outS: 2 })] })
    expect(canPlace(track, 0, 2)).toBe(true)
  })
  it('ignoreClipId lets a clip occupy its own footprint', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const track = makeTrack({ clips: [c] })
    expect(canPlace(track, 1, 2, c.id)).toBe(true)
    expect(canPlace(track, 1, 2)).toBe(false)
  })
})

describe('resolveStart', () => {
  it('returns desired on an empty track', () => {
    expect(resolveStart(makeTrack(), 3, 2)).toBe(3)
  })
  it('clamps desired to 0 on an empty track', () => {
    expect(resolveStart(makeTrack(), -5, 2)).toBe(0)
  })
  it('keeps desired when the spot is free', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 0, outS: 2 })] })
    expect(resolveStart(track, 5, 2)).toBe(5)
  })
  it('picks the gap before when it is nearer', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 2, outS: 2 })] }) // occupies 2..4
    expect(resolveStart(track, 0.5, 1)).toBe(0.5) // free
    expect(resolveStart(track, 1, 1)).toBe(1) // touching is legal
    expect(resolveStart(track, 1.8, 1)).toBe(1) // pushed back to the gap end
  })
  it('picks the gap after when it is nearer', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 2, outS: 2 })] })
    expect(resolveStart(track, 3.5, 1)).toBe(4)
  })
  it('prefers the earlier candidate on an exact tie', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 2, outS: 2 })] })
    // Candidates: 1 (gap before) and 4 (open end), both at distance 1.5.
    expect(resolveStart(track, 2.5, 1)).toBe(1)
  })
  it('clamps at 0 when the first gap starts there', () => {
    const track = makeTrack({ clips: [makeClip({ startS: 0.5, outS: 2 })] })
    expect(resolveStart(track, -3, 0.25)).toBe(0)
  })
  it('falls past the last clip when interior gaps are too small', () => {
    const track = makeTrack({
      clips: [makeClip({ startS: 0, outS: 2 }), makeClip({ startS: 3, outS: 2 })],
    })
    expect(resolveStart(track, 2.2, 2)).toBe(5)
  })
  it('accepts an exact-fit gap', () => {
    const track = makeTrack({
      clips: [makeClip({ startS: 0, outS: 2 }), makeClip({ startS: 3, outS: 2 })],
    })
    expect(resolveStart(track, 2.4, 1)).toBe(2)
  })
  it('ignoreClipId keeps a clip resolvable onto its own spot', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const track = makeTrack({ clips: [c, makeClip({ startS: 4, outS: 2 })] })
    expect(resolveStart(track, 0, 2, c.id)).toBe(0)
  })
})

describe('addClipFromAsset', () => {
  it('adds a video asset to a video track with contract defaults', () => {
    const track = makeTrack()
    const seq = makeSeq([track])
    const { seq: next, clipId } = addClipFromAsset(seq, track.id, AV, 1)
    const found = findClip(next, clipId)
    expect(found).not.toBeNull()
    const clip = found!.clip
    expect(clip.startS).toBe(1)
    expect(clip.inS).toBe(0)
    expect(clip.outS).toBe(10)
    expect(clip.speed).toBe(1)
    expect(clip.enabled).toBe(true)
    expect(clip.transform).toEqual(defaultTransform())
    expect(clip.opacity).toBe(1)
    expect(clip.blendMode).toBe('normal')
    expect(clip.audioGainDb).toBe(0)
    expect(clip.fadeInS).toBe(0)
    expect(clip.fadeOutS).toBe(0)
    expect(clip.effects).toEqual([])
    expect(clip.assetId).toBe('av')
    expect(next.durationS).toBe(11)
  })
  it('gives image assets a 5s default and allows them on video tracks', () => {
    const track = makeTrack()
    const { seq: next, clipId } = addClipFromAsset(makeSeq([track]), track.id, AI, 0)
    const clip = findClip(next, clipId)!.clip
    expect(clip.outS).toBe(5)
    expect(next.durationS).toBe(5)
  })
  it('adds an audio asset to an audio track', () => {
    const track = makeTrack({ kind: 'audio' })
    const audio = makeAsset({ kind: 'audio', durationS: 3, hasVideo: false })
    const { seq: next, clipId } = addClipFromAsset(makeSeq([track]), track.id, audio, 2)
    expect(findClip(next, clipId)!.clip.startS).toBe(2)
  })
  it('no-ops with clipId "" when an audio asset targets a video track', () => {
    const track = makeTrack()
    const seq = makeSeq([track])
    const audio = makeAsset({ kind: 'audio', hasVideo: false })
    const r = addClipFromAsset(seq, track.id, audio, 0)
    expect(r.seq).toBe(seq)
    expect(r.clipId).toBe('')
  })
  it('no-ops when a video asset targets an audio track', () => {
    const track = makeTrack({ kind: 'audio' })
    const seq = makeSeq([track])
    const r = addClipFromAsset(seq, track.id, AV, 0)
    expect(r.seq).toBe(seq)
    expect(r.clipId).toBe('')
  })
  it('no-ops on a locked track', () => {
    const track = makeTrack({ locked: true })
    const seq = makeSeq([track])
    const r = addClipFromAsset(seq, track.id, AV, 0)
    expect(r.seq).toBe(seq)
    expect(r.clipId).toBe('')
  })
  it('no-ops on an unknown track id', () => {
    const seq = makeSeq([makeTrack()])
    const r = addClipFromAsset(seq, 'nope', AV, 0)
    expect(r.seq).toBe(seq)
    expect(r.clipId).toBe('')
  })
  it('resolves collisions and inserts in sorted order', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 5, outS: 2 })
    const track = makeTrack({ clips: [a, b] })
    const short = makeAsset({ durationS: 2 })
    const { seq: next, clipId } = addClipFromAsset(makeSeq([track]), track.id, short, 1)
    const clips = next.tracks[0].clips
    expect(findClip(next, clipId)!.clip.startS).toBe(2) // pushed out of a's footprint
    expect(clips.map((c) => c.id)).toEqual([a.id, clipId, b.id])
  })
  it('clamps a negative desired start to 0', () => {
    const track = makeTrack()
    const { seq: next, clipId } = addClipFromAsset(makeSeq([track]), track.id, AV, -4)
    expect(findClip(next, clipId)!.clip.startS).toBe(0)
  })
})

describe('moveClip', () => {
  it('moves within a track and recomputes duration', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const track = makeTrack({ clips: [c] })
    const next = moveClip(makeSeq([track]), c.id, track.id, 5)
    expect(findClip(next, c.id)!.clip.startS).toBe(5)
    expect(next.durationS).toBe(7)
  })
  it('moves across tracks of the same kind', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const v1 = makeTrack({ clips: [c] })
    const v2 = makeTrack({ name: 'V2' })
    const next = moveClip(makeSeq([v1, v2]), c.id, v2.id, 3)
    expect(next.tracks[0].clips).toHaveLength(0)
    const found = findClip(next, c.id)!
    expect(found.trackIndex).toBe(1)
    expect(found.clip.startS).toBe(3)
  })
  it('refuses a cross-kind move', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const v1 = makeTrack({ clips: [c] })
    const a1 = makeTrack({ kind: 'audio' })
    const seq = makeSeq([v1, a1])
    expect(moveClip(seq, c.id, a1.id, 0)).toBe(seq)
  })
  it('no-ops when the source track is locked', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const v1 = makeTrack({ clips: [c], locked: true })
    const v2 = makeTrack()
    const seq = makeSeq([v1, v2])
    expect(moveClip(seq, c.id, v2.id, 3)).toBe(seq)
  })
  it('no-ops when the target track is locked', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const v1 = makeTrack({ clips: [c] })
    const v2 = makeTrack({ locked: true })
    const seq = makeSeq([v1, v2])
    expect(moveClip(seq, c.id, v2.id, 3)).toBe(seq)
  })
  it('resolves collisions against other clips (own footprint ignored)', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 5, outS: 2 })
    const track = makeTrack({ clips: [a, b] })
    const next = moveClip(makeSeq([track]), b.id, track.id, 1)
    expect(findClip(next, b.id)!.clip.startS).toBe(2)
    expect(next.tracks[0].clips.map((c) => c.id)).toEqual([a.id, b.id])
  })
  it('keeps clips sorted when moving past a neighbor', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 4, outS: 2 })
    const track = makeTrack({ clips: [a, b] })
    const next = moveClip(makeSeq([track]), a.id, track.id, 8)
    expect(next.tracks[0].clips.map((c) => c.id)).toEqual([b.id, a.id])
  })
  it('no-ops for an unknown clip', () => {
    const seq = makeSeq([makeTrack()])
    expect(moveClip(seq, 'nope', seq.tracks[0].id, 3)).toBe(seq)
  })
  it('returns the same reference when the resolved position is unchanged', () => {
    const c = makeClip({ startS: 2, outS: 2 })
    const track = makeTrack({ clips: [c] })
    const seq = makeSeq([track])
    expect(moveClip(seq, c.id, track.id, 2)).toBe(seq)
  })
})

describe('trimClipTo', () => {
  it('in-edge: moves startS+inS together, out edge stays fixed', () => {
    const c = makeClip({ startS: 2, inS: 1, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const endBefore = clipEndS(c)
    const next = trimClipTo(seq, ASSETS, c.id, 'in', 3)
    const t = findClip(next, c.id)!.clip
    expect(t.startS).toBe(3)
    expect(t.inS).toBe(2)
    expect(t.outS).toBe(5)
    expect(clipEndS(t)).toBeCloseTo(endBefore, 9)
  })
  it('out-edge: moves outS, start edge stays fixed', () => {
    const c = makeClip({ startS: 2, inS: 1, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const next = trimClipTo(seq, ASSETS, c.id, 'out', 5)
    const t = findClip(next, c.id)!.clip
    expect(t.startS).toBe(2)
    expect(t.inS).toBe(1)
    expect(t.outS).toBe(4)
    expect(clipEndS(t)).toBeCloseTo(5, 9)
  })
  it('in-edge clamps against the previous neighbor', () => {
    const prev = makeClip({ startS: 0, outS: 2 })
    const c = makeClip({ startS: 3, inS: 2, outS: 8 })
    const seq = makeSeq([makeTrack({ clips: [prev, c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'in', 1), c.id)!.clip
    expect(t.startS).toBe(2)
    expect(t.inS).toBe(1)
  })
  it('out-edge clamps against the next neighbor', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 3 })
    const nextClip = makeClip({ startS: 4, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c, nextClip] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'out', 5.5), c.id)!.clip
    expect(t.outS).toBe(4)
    expect(clipEndS(t)).toBe(4)
  })
  it('out-edge enforces the one-frame minimum duration', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'out', 0), c.id)!.clip
    expect(t.outS).toBeCloseTo(FRAME, 9)
  })
  it('in-edge enforces the one-frame minimum duration', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'in', 10), c.id)!.clip
    expect(t.startS).toBeCloseTo(2 - FRAME, 9)
    expect(clipDurationS(t)).toBeCloseTo(FRAME, 9)
    expect(clipEndS(t)).toBeCloseTo(2, 9)
  })
  it('in-edge clamps to the source head (inS floor 0 for video)', () => {
    const c = makeClip({ startS: 5, inS: 1, outS: 3 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'in', 3), c.id)!.clip
    expect(t.startS).toBe(4)
    expect(t.inS).toBe(0)
  })
  it('out-edge clamps to the source tail', () => {
    const c = makeClip({ startS: 0, inS: 8, outS: 9 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'out', 5), c.id)!.clip
    expect(clipEndS(t)).toBe(2) // 0 + (10 - 8) / 1
    expect(t.outS).toBe(10)
  })
  it('in-edge trims at 2x source rate for speed 2', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'in', 0.5), c.id)!.clip
    expect(t.startS).toBe(0.5)
    expect(t.inS).toBe(1)
    expect(clipEndS(t)).toBeCloseTo(2, 9)
  })
  it('out-edge source bound scales with speed', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    // Max end = 0 + 10/2 = 5 on the timeline.
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'out', 7), c.id)!.clip
    expect(clipEndS(t)).toBeCloseTo(5, 9)
    expect(t.outS).toBeCloseTo(10, 9)
  })
  it('image out-edge is unbounded past its nominal duration', () => {
    const c = makeClip({ assetId: 'ai', startS: 0, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'out', 12), c.id)!.clip
    expect(t.outS).toBe(12)
    expect(clipEndS(t)).toBe(12)
  })
  it('image in-edge extends left freely: inS floors at 0, out edge fixed', () => {
    const c = makeClip({ assetId: 'ai', startS: 4, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(trimClipTo(seq, ASSETS, c.id, 'in', 1), c.id)!.clip
    expect(t.startS).toBe(1)
    expect(t.inS).toBe(0)
    expect(clipEndS(t)).toBeCloseTo(9, 9)
  })
  it('returns the same reference when the clamp lands on the current edge', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(trimClipTo(seq, ASSETS, c.id, 'in', -5)).toBe(seq)
  })
  it('recomputes the sequence duration after an out trim', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 8 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(trimClipTo(seq, ASSETS, c.id, 'out', 3).durationS).toBe(3)
  })
})

describe('splitClip', () => {
  it('no-ops at the exact boundaries and outside', () => {
    const c = makeClip({ startS: 1, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(splitClip(seq, c.id, 1)).toBe(seq)
    expect(splitClip(seq, c.id, 5)).toBe(seq)
    expect(splitClip(seq, c.id, 0.5)).toBe(seq)
    expect(splitClip(seq, c.id, 7)).toBe(seq)
  })
  it('produces continuous halves preserving the source range', () => {
    const c = makeClip({ startS: 1, inS: 0.5, outS: 4.5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const next = splitClip(seq, c.id, 3)
    const [left, right] = next.tracks[0].clips
    expect(next.tracks[0].clips).toHaveLength(2)
    expect(left.id).toBe(c.id)
    expect(right.id).not.toBe(c.id)
    expect(clipEndS(left)).toBeCloseTo(3, 9)
    expect(right.startS).toBe(3)
    expect(left.inS).toBe(0.5)
    expect(left.outS).toBeCloseTo(2.5, 9)
    expect(right.inS).toBeCloseTo(2.5, 9)
    expect(right.outS).toBe(4.5)
    expect(clipEndS(right)).toBeCloseTo(5, 9)
    expect(next.durationS).toBeCloseTo(5, 9)
  })
  it('splits in source time scaled by speed', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 8, speed: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 1).tracks[0].clips
    expect(left.outS).toBe(2)
    expect(right.inS).toBe(2)
    expect(right.outS).toBe(8)
    expect(clipEndS(right)).toBeCloseTo(4, 9)
  })
  it('copies effects to both halves with fresh ids on the right', () => {
    const fx = { id: 'fx1', type: 'blur', params: { amount: 3 }, enabled: true }
    const c = makeClip({ startS: 0, inS: 0, outS: 4, effects: [fx] })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips
    expect(left.effects[0].id).toBe('fx1')
    expect(right.effects[0].id).not.toBe('fx1')
    expect(right.effects[0].type).toBe('blur')
    expect(right.effects[0].params).toEqual({ amount: 3 })
  })
  it('splits transitions: left keeps in, right keeps out', () => {
    const c = makeClip({
      startS: 0,
      inS: 0,
      outS: 4,
      transitionIn: { type: 'dissolve', durationS: 1 },
      transitionOut: { type: 'wipe', durationS: 0.5 },
    })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips
    expect(left.transitionIn).toEqual({ type: 'dissolve', durationS: 1 })
    expect(left.transitionOut).toBeUndefined()
    expect(right.transitionIn).toBeUndefined()
    expect(right.transitionOut).toEqual({ type: 'wipe', durationS: 0.5 })
  })
  it('copies the transform to both halves', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips
    expect(left.transform).toEqual(c.transform)
    expect(right.transform).toEqual(c.transform)
  })
})

describe('deleteClip / rippleDelete', () => {
  it('deleteClip lifts, leaving the gap', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = deleteClip(seq, a.id)
    expect(next.tracks[0].clips.map((c) => c.id)).toEqual([b.id])
    expect(findClip(next, b.id)!.clip.startS).toBe(3) // untouched
    expect(next.durationS).toBe(5)
  })
  it('deleteClip no-ops for an unknown id', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip()] })])
    expect(deleteClip(seq, 'nope')).toBe(seq)
  })
  it('rippleDelete shifts only later clips on that track', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 }) // duration 2, occupies 3..5
    const c = makeClip({ startS: 6, outS: 2 })
    const otherClip = makeClip({ startS: 3, outS: 2 })
    const other = makeTrack({ kind: 'audio', clips: [otherClip] })
    const seq = makeSeq([makeTrack({ clips: [a, b, c] }), other])
    const next = rippleDelete(seq, b.id)
    expect(findClip(next, a.id)!.clip.startS).toBe(0)
    expect(findClip(next, c.id)!.clip.startS).toBe(4)
    expect(findClip(next, otherClip.id)!.clip.startS).toBe(3) // other track untouched
    expect(next.durationS).toBe(6)
  })
  it('rippleDelete of the first clip pulls everything left by its duration', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const c = makeClip({ startS: 6, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b, c] })])
    const next = rippleDelete(seq, a.id)
    expect(findClip(next, b.id)!.clip.startS).toBe(1)
    expect(findClip(next, c.id)!.clip.startS).toBe(4)
  })
  it('rippleDelete accounts for clip speed in the shift', () => {
    const fast = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 }) // 2s on the timeline
    const b = makeClip({ startS: 5, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [fast, b] })])
    expect(findClip(rippleDelete(seq, fast.id), b.id)!.clip.startS).toBe(3)
  })
})

describe('snapTime', () => {
  it('snaps to the nearest point within the threshold', () => {
    expect(snapTime(1.9, [0, 2], 0.15)).toEqual({ t: 2, snapped: true })
  })
  it('does not snap outside the threshold', () => {
    expect(snapTime(1.5, [0, 2], 0.2)).toEqual({ t: 1.5, snapped: false })
  })
  it('snaps exactly at the threshold (inclusive)', () => {
    expect(snapTime(1.75, [2], 0.25)).toEqual({ t: 2, snapped: true })
  })
  it('prefers the earlier point on an exact tie', () => {
    expect(snapTime(1.5, [1, 2], 0.6)).toEqual({ t: 1, snapped: true })
  })
  it('handles no points', () => {
    expect(snapTime(3, [], 1)).toEqual({ t: 3, snapped: false })
  })
})

describe('collectSnapPoints', () => {
  it('collects 0, clip edges, markers, and the playhead, sorted', () => {
    const seq = makeSeq(
      [
        makeTrack({ clips: [makeClip({ startS: 1, outS: 2 })] }),
        makeTrack({ kind: 'audio', clips: [makeClip({ startS: 3, outS: 2 })] }),
      ],
      { markers: [{ id: 'm1', t: 7.5, label: 'M', color: '#fff' }] },
    )
    expect(collectSnapPoints(seq, { playheadS: 2.25 })).toEqual([0, 1, 2.25, 3, 5, 7.5])
  })
  it('dedupes shared edges and 0', () => {
    const seq = makeSeq([
      makeTrack({ clips: [makeClip({ startS: 0, outS: 3 }), makeClip({ startS: 3, outS: 3, inS: 0 })] }),
    ])
    expect(collectSnapPoints(seq)).toEqual([0, 3, 6])
  })
  it('excludes the dragged clip', () => {
    const dragged = makeClip({ startS: 1, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [dragged, makeClip({ startS: 5, outS: 2 })] })])
    expect(collectSnapPoints(seq, { excludeClipId: dragged.id })).toEqual([0, 5, 7])
  })
  it('omits the playhead when not provided', () => {
    const seq = makeSeq([makeTrack()])
    expect(collectSnapPoints(seq)).toEqual([0])
  })
})

describe('time ↔ pixels', () => {
  it('converts both ways', () => {
    expect(timeToPx(2.5, 60)).toBe(150)
    expect(pxToTime(150, 60)).toBe(2.5)
  })
  it('round-trips', () => {
    expect(pxToTime(timeToPx(4.321, 37), 37)).toBeCloseTo(4.321, 12)
  })
})

// ---------------------------------------------------------------------------
// Phase 3

describe('rippleTrimTo', () => {
  it('out grow shifts every later clip on that track by the delta, preserving gaps', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const c = makeClip({ startS: 6, outS: 2 })
    const otherClip = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([
      makeTrack({ clips: [a, b, c] }),
      makeTrack({ kind: 'audio', clips: [otherClip] }),
    ])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', 4)
    expect(clipEndS(findClip(next, a.id)!.clip)).toBe(4)
    expect(findClip(next, b.id)!.clip.startS).toBe(5)
    expect(findClip(next, c.id)!.clip.startS).toBe(8)
    expect(findClip(next, otherClip.id)!.clip.startS).toBe(3)
  })
  it('out shrink pulls later clips left and recomputes duration', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', 1)
    expect(findClip(next, a.id)!.clip.outS).toBe(1)
    expect(findClip(next, b.id)!.clip.startS).toBe(1)
    expect(next.durationS).toBe(3)
  })
  it('out never shifts earlier clips', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, b.id, 'out', 5)
    expect(findClip(next, a.id)!.clip.startS).toBe(0)
    expect(clipEndS(findClip(next, b.id)!.clip)).toBe(5)
  })
  it('out respects the source tail bound', () => {
    const a = makeClip({ startS: 0, inS: 8, outS: 9 })
    const b = makeClip({ startS: 1, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', 5)
    const t = findClip(next, a.id)!.clip
    expect(clipEndS(t)).toBe(2)
    expect(t.outS).toBe(10)
    expect(findClip(next, b.id)!.clip.startS).toBe(2)
  })
  it('out enforces the one-frame minimum', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', -3)
    expect(findClip(next, a.id)!.clip.outS).toBeCloseTo(FRAME, 9)
    expect(findClip(next, b.id)!.clip.startS).toBeCloseTo(FRAME, 9)
  })
  it('out on an image clip is unbounded', () => {
    const a = makeClip({ assetId: 'ai', startS: 0, outS: 5 })
    const b = makeClip({ startS: 5, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', 12)
    expect(findClip(next, a.id)!.clip.outS).toBe(12)
    expect(findClip(next, b.id)!.clip.startS).toBe(12)
  })
  it('out scales the source delta by speed', () => {
    const a = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const b = makeClip({ startS: 2, outS: 1 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'out', 3)
    expect(findClip(next, a.id)!.clip.outS).toBe(6)
    expect(findClip(next, b.id)!.clip.startS).toBe(3)
  })
  it('out returns the same reference when clamped to the current end', () => {
    const a = makeClip({ startS: 0, inS: 8, outS: 10 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    expect(rippleTrimTo(seq, ASSETS, a.id, 'out', 9)).toBe(seq)
  })
  it('in keeps startS fixed and shifts later clips by the duration delta (shrink)', () => {
    const a = makeClip({ startS: 2, inS: 1, outS: 5 })
    const b = makeClip({ startS: 6, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 3)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(2)
    expect(t.inS).toBe(2)
    expect(t.outS).toBe(5)
    expect(clipEndS(t)).toBe(5)
    expect(findClip(next, b.id)!.clip.startS).toBe(5)
  })
  it('in grows the head and pushes later clips right', () => {
    const a = makeClip({ startS: 2, inS: 3, outS: 5 })
    const b = makeClip({ startS: 4, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 0)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(2)
    expect(t.inS).toBe(1)
    expect(clipEndS(t)).toBe(6)
    expect(findClip(next, b.id)!.clip.startS).toBe(6)
  })
  it('in ignores the gap to the previous clip (start never moves)', () => {
    const p = makeClip({ startS: 0, outS: 2 })
    const a = makeClip({ startS: 2, inS: 5, outS: 7 })
    const b = makeClip({ startS: 4, outS: 1 })
    const seq = makeSeq([makeTrack({ clips: [p, a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 1)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(2)
    expect(t.inS).toBe(4)
    expect(findClip(next, p.id)!.clip.startS).toBe(0)
    expect(findClip(next, b.id)!.clip.startS).toBe(5)
  })
  it('in clamps at the source head', () => {
    const a = makeClip({ startS: 5, inS: 1, outS: 3 })
    const b = makeClip({ startS: 7, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 1)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(5)
    expect(t.inS).toBe(0)
    expect(clipDurationS(t)).toBe(3)
    expect(findClip(next, b.id)!.clip.startS).toBe(8)
  })
  it('in enforces the one-frame minimum', () => {
    const a = makeClip({ startS: 0, inS: 0, outS: 2 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 10)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(0)
    expect(clipDurationS(t)).toBeCloseTo(FRAME, 9)
    expect(findClip(next, b.id)!.clip.startS).toBeCloseTo(FRAME, 9)
  })
  it('in on an image floors inS at 0 and widens the window', () => {
    const a = makeClip({ assetId: 'ai', startS: 4, inS: 0, outS: 5 })
    const b = makeClip({ startS: 9, outS: 1 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 1)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(4)
    expect(t.inS).toBe(0)
    expect(t.outS).toBe(8)
    expect(clipEndS(t)).toBe(12)
    expect(findClip(next, b.id)!.clip.startS).toBe(12)
  })
  it('in scales the source delta by speed', () => {
    const a = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const b = makeClip({ startS: 2, outS: 1 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = rippleTrimTo(seq, ASSETS, a.id, 'in', 0.5)
    const t = findClip(next, a.id)!.clip
    expect(t.startS).toBe(0)
    expect(t.inS).toBe(1)
    expect(clipDurationS(t)).toBe(1.5)
    expect(findClip(next, b.id)!.clip.startS).toBe(1.5)
  })
  it('in returns the same reference when clamped to the current start', () => {
    const a = makeClip({ startS: 3, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    expect(rippleTrimTo(seq, ASSETS, a.id, 'in', 0)).toBe(seq)
  })
  it('no-ops for an unknown clip', () => {
    const seq = makeSeq([makeTrack()])
    expect(rippleTrimTo(seq, ASSETS, 'nope', 'out', 3)).toBe(seq)
  })
})

describe('rollEditTo', () => {
  it('moves the boundary right: left tail grows, right head trims, right end fixed', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 0, outS: 3 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 3)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(3)
    expect(clipEndS(nl)).toBe(3)
    expect(nr.startS).toBe(3)
    expect(nr.inS).toBe(1)
    expect(nr.outS).toBe(3)
    expect(clipEndS(nr)).toBe(5)
  })
  it('moves the boundary left: left tail trims, right head grows', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 1)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(1)
    expect(nr.startS).toBe(1)
    expect(nr.inS).toBe(1)
    expect(clipEndS(nr)).toBe(5)
  })
  it('clamps to the left minimum duration', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, -5)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBeCloseTo(FRAME, 9)
    expect(nr.startS).toBeCloseTo(FRAME, 9)
    expect(clipEndS(nr)).toBeCloseTo(5, 9)
  })
  it('clamps to the right minimum duration', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 0, outS: 3 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 9)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(clipEndS(nl)).toBeCloseTo(5 - FRAME, 9)
    expect(nr.startS).toBeCloseTo(5 - FRAME, 9)
    expect(clipDurationS(nr)).toBeCloseTo(FRAME, 9)
    expect(clipEndS(nr)).toBeCloseTo(5, 9)
  })
  it('clamps to the left source tail', () => {
    const l = makeClip({ startS: 0, inS: 8, outS: 9 })
    const r = makeClip({ startS: 1, inS: 5, outS: 8 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 3)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(10)
    expect(clipEndS(nl)).toBe(2)
    expect(nr.startS).toBe(2)
    expect(nr.inS).toBe(6)
    expect(clipEndS(nr)).toBe(4)
  })
  it('clamps to the right source head', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 1, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 0)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(1)
    expect(nr.startS).toBe(1)
    expect(nr.inS).toBe(0)
    expect(clipEndS(nr)).toBe(5)
  })
  it('floors a right image clip inS at 0 keeping its end fixed', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 5 })
    const r = makeClip({ assetId: 'ai', startS: 5, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 3)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(3)
    expect(nr.startS).toBe(3)
    expect(nr.inS).toBe(0)
    expect(nr.outS).toBe(7)
    expect(clipEndS(nr)).toBe(10)
  })
  it('scales by each clip speed independently', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const r = makeClip({ startS: 2, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    const next = rollEditTo(seq, ASSETS, l.id, r.id, 3)
    const nl = findClip(next, l.id)!.clip
    const nr = findClip(next, r.id)!.clip
    expect(nl.outS).toBe(6)
    expect(clipEndS(nl)).toBe(3)
    expect(nr.startS).toBe(3)
    expect(nr.inS).toBe(1)
    expect(clipEndS(nr)).toBe(4)
  })
  it('no-ops when the clips are not adjacent', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 3, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    expect(rollEditTo(seq, ASSETS, l.id, r.id, 2.5)).toBe(seq)
  })
  it('no-ops across different tracks', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [l] }), makeTrack({ name: 'V2', clips: [r] })])
    expect(rollEditTo(seq, ASSETS, l.id, r.id, 3)).toBe(seq)
  })
  it('no-ops for unknown ids', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [l] })])
    expect(rollEditTo(seq, ASSETS, l.id, 'nope', 1)).toBe(seq)
    expect(rollEditTo(seq, ASSETS, 'nope', l.id, 1)).toBe(seq)
  })
  it('returns the same reference when rolled to the current boundary', () => {
    const l = makeClip({ startS: 0, inS: 0, outS: 2 })
    const r = makeClip({ startS: 2, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [l, r] })])
    expect(rollEditTo(seq, ASSETS, l.id, r.id, 2)).toBe(seq)
  })
})

describe('slipClip', () => {
  it('shifts the source window without moving the clip', () => {
    const c = makeClip({ startS: 3, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(slipClip(seq, ASSETS, c.id, 1), c.id)!.clip
    expect(t.startS).toBe(3)
    expect(t.inS).toBe(3)
    expect(t.outS).toBe(6)
    expect(clipDurationS(t)).toBe(3)
  })
  it('slips backwards', () => {
    const c = makeClip({ startS: 3, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(slipClip(seq, ASSETS, c.id, -1), c.id)!.clip
    expect(t.inS).toBe(1)
    expect(t.outS).toBe(4)
  })
  it('clamps at the source head', () => {
    const c = makeClip({ startS: 3, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(slipClip(seq, ASSETS, c.id, -5), c.id)!.clip
    expect(t.inS).toBe(0)
    expect(t.outS).toBe(3)
  })
  it('clamps at the source tail', () => {
    const c = makeClip({ startS: 3, inS: 2, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(slipClip(seq, ASSETS, c.id, 9), c.id)!.clip
    expect(t.inS).toBe(7)
    expect(t.outS).toBe(10)
  })
  it('scales the timeline delta by speed', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 4, speed: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const t = findClip(slipClip(seq, ASSETS, c.id, 1), c.id)!.clip
    expect(t.inS).toBe(2)
    expect(t.outS).toBe(6)
    expect(clipDurationS(t)).toBe(2)
  })
  it('no-ops on an image clip (same reference)', () => {
    const c = makeClip({ assetId: 'ai', startS: 0, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(slipClip(seq, ASSETS, c.id, 1)).toBe(seq)
  })
  it('returns the same reference when the window already fills the source', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 10 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(slipClip(seq, ASSETS, c.id, 1)).toBe(seq)
    expect(slipClip(seq, ASSETS, c.id, -1)).toBe(seq)
  })
  it('does not move neighbors', () => {
    const c = makeClip({ startS: 0, inS: 2, outS: 4 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c, b] })])
    const next = slipClip(seq, ASSETS, c.id, 1)
    expect(findClip(next, b.id)!.clip).toBe(b)
  })
  it('no-ops for an unknown clip', () => {
    const seq = makeSeq([makeTrack()])
    expect(slipClip(seq, ASSETS, 'nope', 1)).toBe(seq)
  })
})

describe('slideClip', () => {
  const flushTrio = () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 2, outS: 4 })
    return { p, c, nx, seq: makeSeq([makeTrack({ clips: [p, c, nx] })]) }
  }
  it('slides right: prev tail grows, next head trims, totals preserved', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    const next = slideClip(seq, ASSETS, c.id, 3)
    const np = findClip(next, p.id)!.clip
    const nc = findClip(next, c.id)!.clip
    const nn = findClip(next, nx.id)!.clip
    expect(np.outS).toBe(3)
    expect(clipEndS(np)).toBe(3)
    expect(nc.startS).toBe(3)
    expect(nc.inS).toBe(0)
    expect(nc.outS).toBe(2)
    expect(nn.startS).toBe(5)
    expect(nn.inS).toBe(1)
    expect(clipEndS(nn)).toBe(6)
    expect(next.durationS).toBe(6)
  })
  it('slides left: prev tail trims, next head grows', () => {
    const { p, c, nx, seq } = flushTrio()
    const next = slideClip(seq, ASSETS, c.id, 1)
    const np = findClip(next, p.id)!.clip
    const nc = findClip(next, c.id)!.clip
    const nn = findClip(next, nx.id)!.clip
    expect(np.outS).toBe(1)
    expect(nc.startS).toBe(1)
    expect(nn.startS).toBe(3)
    expect(nn.inS).toBe(1)
    expect(clipEndS(nn)).toBe(6)
    expect(next.durationS).toBe(6)
  })
  it('clamps to the prev minimum duration', () => {
    const { p, c, seq } = flushTrio()
    const next = slideClip(seq, ASSETS, c.id, -5)
    expect(clipDurationS(findClip(next, p.id)!.clip)).toBeCloseTo(FRAME, 9)
    expect(findClip(next, c.id)!.clip.startS).toBeCloseTo(FRAME, 9)
  })
  it('clamps to the prev source tail', () => {
    const p = makeClip({ startS: 0, inS: 7, outS: 9 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    const next = slideClip(seq, ASSETS, c.id, 5)
    const np = findClip(next, p.id)!.clip
    expect(np.outS).toBe(10)
    expect(clipEndS(np)).toBe(3)
    expect(findClip(next, c.id)!.clip.startS).toBe(3)
    expect(findClip(next, nx.id)!.clip.startS).toBe(5)
    expect(findClip(next, nx.id)!.clip.inS).toBe(1)
  })
  it('clamps to the next minimum duration', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    const next = slideClip(seq, ASSETS, c.id, 5)
    const nn = findClip(next, nx.id)!.clip
    expect(findClip(next, c.id)!.clip.startS).toBeCloseTo(4 - FRAME, 9)
    expect(clipDurationS(nn)).toBeCloseTo(FRAME, 9)
    expect(clipEndS(nn)).toBeCloseTo(6, 9)
  })
  it('clamps to the next source head', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 1, outS: 3 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    const next = slideClip(seq, ASSETS, c.id, 0)
    const nn = findClip(next, nx.id)!.clip
    expect(findClip(next, p.id)!.clip.outS).toBe(1)
    expect(findClip(next, c.id)!.clip.startS).toBe(1)
    expect(nn.startS).toBe(3)
    expect(nn.inS).toBe(0)
    expect(clipEndS(nn)).toBe(6)
  })
  it('handles an image next by flooring inS at 0 with its end fixed', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ assetId: 'ai', startS: 4, inS: 0, outS: 5 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    const next = slideClip(seq, ASSETS, c.id, 1)
    const nn = findClip(next, nx.id)!.clip
    expect(nn.startS).toBe(3)
    expect(nn.inS).toBe(0)
    expect(nn.outS).toBe(6)
    expect(clipEndS(nn)).toBe(9)
  })
  it('no-ops without a previous neighbor', () => {
    const c = makeClip({ startS: 0, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 2, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c, nx] })])
    expect(slideClip(seq, ASSETS, c.id, 1)).toBe(seq)
  })
  it('no-ops without a next neighbor', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 2 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [p, c] })])
    expect(slideClip(seq, ASSETS, c.id, 3)).toBe(seq)
  })
  it('no-ops when a neighbor is not flush', () => {
    const p = makeClip({ startS: 0, inS: 0, outS: 1.5 })
    const c = makeClip({ startS: 2, inS: 0, outS: 2 })
    const nx = makeClip({ startS: 4, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [p, c, nx] })])
    expect(slideClip(seq, ASSETS, c.id, 3)).toBe(seq)
  })
  it('returns the same reference when the clamp lands on the current start', () => {
    const { c, seq } = flushTrio()
    expect(slideClip(seq, ASSETS, c.id, 2)).toBe(seq)
  })
  it('no-ops for an unknown clip', () => {
    const seq = makeSeq([makeTrack()])
    expect(slideClip(seq, ASSETS, 'nope', 1)).toBe(seq)
  })
})

describe('markers', () => {
  const emptySeq = () => makeSeq([makeTrack()])
  it('addMarker inserts with defaults and returns the id', () => {
    const { seq, markerId } = addMarker(emptySeq(), 2)
    expect(seq.markers).toEqual([{ id: markerId, t: 2, label: '', color: '#6f6bff' }])
  })
  it('addMarker keeps a custom label and color', () => {
    const { seq } = addMarker(emptySeq(), 1, 'Scene', '#ff0000')
    expect(seq.markers[0].label).toBe('Scene')
    expect(seq.markers[0].color).toBe('#ff0000')
  })
  it('addMarker keeps markers sorted by t', () => {
    let seq = addMarker(emptySeq(), 5).seq
    seq = addMarker(seq, 2).seq
    seq = addMarker(seq, 8).seq
    expect(seq.markers.map((m) => m.t)).toEqual([2, 5, 8])
  })
  it('addMarker at an exact existing time returns the existing id, seq unchanged', () => {
    const r1 = addMarker(emptySeq(), 2, 'first')
    const r2 = addMarker(r1.seq, 2, 'second')
    expect(r2.seq).toBe(r1.seq)
    expect(r2.markerId).toBe(r1.markerId)
  })
  it('addMarker allows near-duplicates beyond the exact-time tolerance', () => {
    const r1 = addMarker(emptySeq(), 2)
    const r2 = addMarker(r1.seq, 2.001)
    expect(r2.seq.markers).toHaveLength(2)
    expect(r2.markerId).not.toBe(r1.markerId)
  })
  it('addMarker clamps a negative time to 0', () => {
    expect(addMarker(emptySeq(), -3).seq.markers[0].t).toBe(0)
  })
  it('removeMarker removes by id', () => {
    const { seq, markerId } = addMarker(emptySeq(), 2)
    expect(removeMarker(seq, markerId).markers).toEqual([])
  })
  it('removeMarker returns the same reference for an unknown id', () => {
    const { seq } = addMarker(emptySeq(), 2)
    expect(removeMarker(seq, 'nope')).toBe(seq)
  })
  it('removeMarkerNear removes the nearest marker within tolerance', () => {
    let seq = addMarker(emptySeq(), 1).seq
    seq = addMarker(seq, 3).seq
    const next = removeMarkerNear(seq, 2.8, 0.5)
    expect(next.markers.map((m) => m.t)).toEqual([1])
  })
  it('removeMarkerNear is inclusive at the tolerance and no-ops outside it', () => {
    const seq = addMarker(emptySeq(), 3).seq
    expect(removeMarkerNear(seq, 2.5, 0.5).markers).toEqual([])
    expect(removeMarkerNear(seq, 2.4, 0.5)).toBe(seq)
  })
  it('removeMarkerNear prefers the earlier marker on an exact tie', () => {
    let seq = addMarker(emptySeq(), 1).seq
    seq = addMarker(seq, 3).seq
    expect(removeMarkerNear(seq, 2, 1.5).markers.map((m) => m.t)).toEqual([3])
  })
  it('moveMarker moves and re-sorts', () => {
    const r1 = addMarker(emptySeq(), 1)
    let seq = r1.seq
    seq = addMarker(seq, 3).seq
    seq = addMarker(seq, 5).seq
    const next = moveMarker(seq, r1.markerId, 4)
    expect(next.markers.map((m) => m.t)).toEqual([3, 4, 5])
    expect(next.markers[1].id).toBe(r1.markerId)
  })
  it('moveMarker clamps to >= 0', () => {
    const { seq, markerId } = addMarker(emptySeq(), 2)
    expect(moveMarker(seq, markerId, -5).markers[0].t).toBe(0)
  })
  it('moveMarker returns the same reference for an unknown id or unchanged time', () => {
    const { seq, markerId } = addMarker(emptySeq(), 2)
    expect(moveMarker(seq, 'nope', 4)).toBe(seq)
    expect(moveMarker(seq, markerId, 2)).toBe(seq)
  })
})

describe('serializeClips', () => {
  it('computes offsets from the earliest selected clip and per-kind track offsets', () => {
    const a = makeClip({ startS: 2, outS: 2 })
    const b = makeClip({ startS: 5, outS: 2 })
    const c = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([
      makeTrack({ clips: [a] }),
      makeTrack({ name: 'V2', clips: [b] }),
      makeTrack({ kind: 'audio', clips: [c] }),
    ])
    const payload = serializeClips(seq, [a.id, b.id, c.id])
    expect(payload).toHaveLength(3)
    expect(payload[0]).toMatchObject({ trackKind: 'video', trackOffset: 0, offsetS: 0 })
    expect(payload[1]).toMatchObject({ trackKind: 'video', trackOffset: 1, offsetS: 3 })
    expect(payload[2]).toMatchObject({ trackKind: 'audio', trackOffset: 0, offsetS: 1 })
  })
  it('counts only same-kind tracks for trackOffset', () => {
    const c = makeClip({ startS: 1, outS: 2 })
    const seq = makeSeq([
      makeTrack(),
      makeTrack({ name: 'V2' }),
      makeTrack({ kind: 'audio', name: 'A1' }),
      makeTrack({ kind: 'audio', name: 'A2', clips: [c] }),
    ])
    expect(serializeClips(seq, [c.id])[0].trackOffset).toBe(1)
  })
  it('skips unknown ids and returns [] when nothing matches', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    expect(serializeClips(seq, [a.id, 'nope'])).toHaveLength(1)
    expect(serializeClips(seq, ['nope'])).toEqual([])
    expect(serializeClips(seq, [])).toEqual([])
  })
  it('payload clip omits id and startS but keeps the trim window', () => {
    const a = makeClip({ startS: 4, inS: 1, outS: 4, speed: 2, opacity: 0.5 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    const [p] = serializeClips(seq, [a.id])
    expect('id' in p.clip).toBe(false)
    expect('startS' in p.clip).toBe(false)
    expect(p.assetId).toBe('av')
    expect(p.clip.inS).toBe(1)
    expect(p.clip.outS).toBe(4)
    expect(p.clip.speed).toBe(2)
    expect(p.clip.opacity).toBe(0.5)
  })
  it('preserves the clipIds order', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const payload = serializeClips(seq, [b.id, a.id])
    expect(payload.map((p) => p.offsetS)).toEqual([3, 0])
  })
})

describe('pasteClips', () => {
  it('pastes at atS with preserved offsets, fresh ids, matching tracks', () => {
    const a = makeClip({ startS: 2, outS: 2 })
    const b = makeClip({ startS: 5, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a] }), makeTrack({ name: 'V2', clips: [b] })])
    const payload = serializeClips(seq, [a.id, b.id])
    const { seq: next, newIds } = pasteClips(seq, payload, 10)
    expect(newIds).toHaveLength(2)
    expect(newIds).not.toContain(a.id)
    expect(newIds).not.toContain(b.id)
    const na = findClip(next, newIds[0])!
    const nb = findClip(next, newIds[1])!
    expect(na.trackIndex).toBe(0)
    expect(na.clip.startS).toBe(10)
    expect(nb.trackIndex).toBe(1)
    expect(nb.clip.startS).toBe(13)
    expect(findClip(next, a.id)).not.toBeNull()
    expect(next.durationS).toBe(15)
  })
  it('clamps trackOffset onto the last same-kind track', () => {
    const b = makeClip({ startS: 0, outS: 2 })
    const source = makeSeq([makeTrack(), makeTrack({ name: 'V2', clips: [b] })])
    const payload = serializeClips(source, [b.id])
    const target = makeSeq([makeTrack()])
    const { seq: next, newIds } = pasteClips(target, payload, 1)
    expect(findClip(next, newIds[0])!.trackIndex).toBe(0)
    expect(findClip(next, newIds[0])!.clip.startS).toBe(1)
  })
  it('collision-resolves each insert via resolveStart', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, makeClip({ startS: 10, outS: 2 })] })])
    const payload = serializeClips(seq, [a.id])
    const { seq: next, newIds } = pasteClips(seq, payload, 11)
    expect(findClip(next, newIds[0])!.clip.startS).toBe(12)
  })
  it('collision-resolves later payload items against earlier pasted ones', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const payload = serializeClips(seq, [a.id, b.id])
    const { seq: next, newIds } = pasteClips(seq, payload, 4)
    expect(findClip(next, newIds[0])!.clip.startS).toBe(4)
    expect(findClip(next, newIds[1])!.clip.startS).toBe(6)
  })
  it('regenerates effect instance ids without mutating the payload', () => {
    const fx = { id: 'fx1', type: 'blur', params: { amount: 3 }, enabled: true }
    const a = makeClip({ startS: 0, outS: 2, effects: [fx] })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    const payload = serializeClips(seq, [a.id])
    const { seq: next, newIds } = pasteClips(seq, payload, 5)
    const pasted = findClip(next, newIds[0])!.clip
    expect(pasted.effects[0].id).not.toBe('fx1')
    expect(pasted.effects[0].type).toBe('blur')
    expect(pasted.effects[0].params).toEqual({ amount: 3 })
    expect(payload[0].clip.effects[0].id).toBe('fx1')
  })
  it('skips items targeting a locked track but pastes the rest', () => {
    const v = makeClip({ startS: 0, outS: 2 })
    const aClip = makeClip({ startS: 1, outS: 2 })
    const source = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [aClip] })])
    const payload = serializeClips(source, [v.id, aClip.id])
    const target = makeSeq([makeTrack({ locked: true }), makeTrack({ kind: 'audio' })])
    const { seq: next, newIds } = pasteClips(target, payload, 5)
    expect(newIds).toHaveLength(1)
    expect(next.tracks[0].clips).toHaveLength(0)
    const pasted = findClip(next, newIds[0])!
    expect(pasted.trackIndex).toBe(1)
    expect(pasted.clip.startS).toBe(6)
  })
  it('returns the same reference for an empty payload', () => {
    const seq = makeSeq([makeTrack()])
    const r = pasteClips(seq, [], 5)
    expect(r.seq).toBe(seq)
    expect(r.newIds).toEqual([])
  })
  it('returns the same reference when every item is skipped', () => {
    const v = makeClip({ startS: 0, outS: 2 })
    const source = makeSeq([makeTrack({ clips: [v] })])
    const payload = serializeClips(source, [v.id])
    const target = makeSeq([makeTrack({ locked: true })])
    const r = pasteClips(target, payload, 0)
    expect(r.seq).toBe(target)
    expect(r.newIds).toEqual([])
  })
})

describe('duplicateClips', () => {
  it('lands duplicates flush after the selection on the same tracks', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const { seq: next, newIds } = duplicateClips(seq, [a.id, b.id])
    expect(newIds).toHaveLength(2)
    expect(findClip(next, newIds[0])!.clip.startS).toBe(5)
    expect(findClip(next, newIds[1])!.clip.startS).toBe(8)
    expect(findClip(next, a.id)!.clip.startS).toBe(0)
    expect(findClip(next, b.id)!.clip.startS).toBe(3)
    expect(next.durationS).toBe(10)
  })
  it('duplicates across kinds keeping the layout', () => {
    const v = makeClip({ startS: 1, outS: 2 })
    const aClip = makeClip({ startS: 2, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [aClip] })])
    const { seq: next, newIds } = duplicateClips(seq, [v.id, aClip.id])
    const nv = findClip(next, newIds[0])!
    const na = findClip(next, newIds[1])!
    expect(nv.trackIndex).toBe(0)
    expect(nv.clip.startS).toBe(4)
    expect(na.trackIndex).toBe(1)
    expect(na.clip.startS).toBe(5)
  })
  it('duplicates a single clip immediately after itself', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    const { seq: next, newIds } = duplicateClips(seq, [a.id])
    expect(newIds).toHaveLength(1)
    expect(newIds[0]).not.toBe(a.id)
    expect(findClip(next, newIds[0])!.clip.startS).toBe(2)
  })
  it('returns the same reference for an empty or unknown selection', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip()] })])
    const r1 = duplicateClips(seq, [])
    const r2 = duplicateClips(seq, ['nope'])
    expect(r1.seq).toBe(seq)
    expect(r1.newIds).toEqual([])
    expect(r2.seq).toBe(seq)
    expect(r2.newIds).toEqual([])
  })
})
