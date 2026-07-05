import { describe, expect, it } from 'vitest'
import { defaultTransform, type Clip, type MediaAsset, type Sequence, type Track } from './types'
import {
  addClipFromAsset,
  canPlace,
  clipDurationS,
  clipEndS,
  collectSnapPoints,
  deleteClip,
  findClip,
  moveClip,
  pxToTime,
  recomputeDuration,
  resolveStart,
  rippleDelete,
  sequenceDurationS,
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
