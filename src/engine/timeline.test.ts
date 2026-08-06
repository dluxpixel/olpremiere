import { describe, expect, it } from 'vitest'
import { applyAppearanceToClip, retimeAppearance } from './anim/appearance'
import { clipEmitsAudio } from './audio'
import { channelKeyframes, resolveChannel } from './effects/channels'
import {
  defaultTitleDef,
  defaultTransform,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Sequence,
  type Track,
} from './types'
import {
  addClipFromAsset,
  addClipWithLinkedAudio,
  addTrack,
  adoptFrameRate,
  addMarker,
  canPlace,
  clipDurationS,
  clipEndS,
  clipGroupIds,
  closeAllGaps,
  closeGapBefore,
  collectSnapPoints,
  gapBefore,
  deleteClip,
  deleteGroup,
  deleteScoped,
  duplicateClips,
  findClip,
  linkGroupIndex,
  moveClip,
  moveGroup,
  moveMarker,
  pasteClips,
  pxToTime,
  rateStretchGroup,
  recomputeDuration,
  removeMarker,
  removeMarkerNear,
  clearSpan,
  resolveStart,
  rippleDelete,
  rippleTrimTo,
  rollEditTo,
  sequenceDurationS,
  refitClipToFill,
  serializeClips,
  setClipSpeed,
  setSequenceFormat,
  slideClip,
  slipClip,
  slipGroup,
  snapTime,
  splitClip,
  unlockedClipIds,
  splitClipOnly,
  splitGroup,
  timeToPx,
  trimClipTo,
  trimGroup,
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
  volumeDb: 0,
  pan: 0,
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
  it('keyframes split by time: no replayed animation, seamless value at the cut', () => {
    // A punch zoom [1 → 1.3 over 0.5s]. Cutting at 0.25 must leave each half
    // its own slice. Copying the full set made the zoom REPLAY on the right.
    const c = makeClip({
      startS: 0,
      inS: 0,
      outS: 4,
      keyframes: {
        scale: [
          { t: 0, value: 1, ease: 'linear' },
          { t: 0.5, value: 1.3, ease: 'linear' },
        ],
      },
    })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 0.25).tracks[0].clips
    const lk = left.keyframes!.scale!
    const rk = right.keyframes!.scale!
    // Left: original start + boundary at the cut carrying the mid value.
    expect(lk.map((k) => [k.t, k.value])).toEqual([
      [0, 1],
      [0.25, 1.15],
    ])
    // Right: boundary at its new zero + the remaining keyframe, shifted.
    expect(rk.map((k) => [k.t, k.value])).toEqual([
      [0, 1.15],
      [0.25, 1.3],
    ])
  })

  it('a side whose animation is constant collapses to a static base (no phantom stopwatch)', () => {
    // Zoom finished at 0.5; cut at 2, so the right half must HOLD 1.3 statically,
    // not carry a single-keyframe "animated" channel, and not replay anything.
    const c = makeClip({
      startS: 0,
      inS: 0,
      outS: 4,
      keyframes: {
        scale: [
          { t: 0, value: 1, ease: 'linear' },
          { t: 0.5, value: 1.3, ease: 'linear' },
        ],
      },
    })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips
    expect(left.keyframes!.scale!.length).toBe(3) // 0, 0.5, boundary@2
    expect(right.keyframes?.scale ?? []).toHaveLength(0)
    expect(right.transform.scale).toBeCloseTo(1.3, 9)
  })

  it('animated EFFECT params split the same way', () => {
    const c = makeClip({
      startS: 0,
      inS: 0,
      outS: 4,
      effects: [
        {
          id: 'fx',
          type: 'gaussianBlur',
          enabled: true,
          params: {
            blur: {
              value: 0,
              keyframes: [
                { t: 0, value: 0, ease: 'linear' },
                { t: 1, value: 10, ease: 'linear' },
              ],
            },
          },
        },
      ],
    })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 0.5).tracks[0].clips
    const lp = left.effects[0].params.blur
    const rp = right.effects[0].params.blur
    if (typeof lp === 'number' || typeof rp === 'number') throw new Error('should stay animated')
    expect(lp.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 0],
      [0.5, 5],
    ])
    expect(rp.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 5],
      [0.5, 10],
    ])
  })

  // A cut must never change what is on screen at that instant. The canonical
  // appearance recompile only reproduces the original motion while each window
  // sits entirely on one side of it; cut INSIDE the entrance and the right half
  // used to have its entrance channels cleared, snapping mid-animation.
  it('a cut INSIDE an entrance window keeps the motion instead of recompiling', () => {
    const base = makeClip({ startS: 0, inS: 0, outS: 4, appearance: { in: 'pop', durS: 0.5 } })
    const c = applyAppearanceToClip(base, base.appearance!, 1920, 1080)
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const cutAt = 0.2 // well inside the 0.5s entrance

    const [left, right] = splitClip(seq, c.id, cutAt).tracks[0].clips

    // The picture is unchanged across the cut: the right half opens on exactly
    // the value the original was showing there.
    expect(resolveChannel(right, 'scale', 0)).toBeCloseTo(resolveChannel(c, 'scale', cutAt), 9)
    // ...and it still ANIMATES the rest of the entrance rather than snapping.
    expect(channelKeyframes(right, 'scale').length).toBeGreaterThan(1)
    expect(resolveChannel(left, 'scale', cutAt)).toBeCloseTo(resolveChannel(c, 'scale', cutAt), 9)
    // Neither half claims a preset it no longer matches.
    expect(left.appearance).toBeUndefined()
    expect(right.appearance).toBeUndefined()
  })

  it('a cut OUTSIDE both windows still recompiles each half from its own spec', () => {
    const base = makeClip({ startS: 0, inS: 0, outS: 4, appearance: { in: 'pop', out: 'fadeOut', durS: 0.5 } })
    const c = applyAppearanceToClip(base, base.appearance!, 1920, 1080)
    const seq = makeSeq([makeTrack({ clips: [c] })])

    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips

    expect(left.appearance).toEqual({ in: 'pop', durS: 0.5 })
    expect(right.appearance).toEqual({ out: 'fadeOut', durS: 0.5 })
  })

  it('fades split with their edge: left keeps fade-in only, right fade-out only', () => {
    // Copying both fades to both halves put an audible fade-out+fade-in dip at
    // every cut point. The cut itself must stay a hard cut.
    const c = makeClip({ startS: 0, inS: 0, outS: 4, fadeInS: 0.8, fadeOutS: 0.6 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const [left, right] = splitClip(seq, c.id, 2).tracks[0].clips
    expect(left.fadeInS).toBe(0.8)
    expect(left.fadeOutS).toBe(0)
    expect(right.fadeInS).toBe(0)
    expect(right.fadeOutS).toBe(0.6)
  })

  it('no-ops at the exact boundaries and outside', () => {
    const c = makeClip({ startS: 1, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(splitClip(seq, c.id, 1)).toBe(seq)
    expect(splitClip(seq, c.id, 5)).toBe(seq)
    expect(splitClip(seq, c.id, 0.5)).toBe(seq)
    expect(splitClip(seq, c.id, 7)).toBe(seq)
  })
  it('no-ops within one frame of an edge: jitter cuts must not leave slivers', () => {
    const c = makeClip({ startS: 1, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })]) // 30fps → min piece 1/30s
    expect(splitClip(seq, c.id, 1.02)).toBe(seq) // 20ms from the start edge
    expect(splitClip(seq, c.id, 4.985)).toBe(seq) // 15ms from the end edge
    // exactly one frame in is a legitimate cut
    const ok = splitClip(seq, c.id, 1 + 1 / 30)
    expect(ok).not.toBe(seq)
    expect(ok.tracks[0].clips).toHaveLength(2)
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
  it('deleting one half of a linked A/V pair keeps the other half (and its link marker)', () => {
    // The "delete the audio, keep the video" case. deleteClip acts on ONE clip,
    // never the group; the surviving video keeps its linkId so it stays silent
    // (its own audio remains suppressed) rather than suddenly playing sound.
    const v = makeClip({ startS: 0, outS: 4, linkId: 'g1' })
    const a = makeClip({ startS: 0, outS: 4, linkId: 'g1' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
    const next = deleteClip(seq, a.id) // delete the audio
    expect(findClip(next, a.id)).toBeNull()
    const survivor = findClip(next, v.id)!.clip
    expect(survivor.id).toBe(v.id)
    expect(survivor.linkId).toBe('g1') // kept -> video stays video-only/silent
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

describe('unlockedClipIds', () => {
  it('drops ids whose clips sit on a locked track, keeps the rest', () => {
    const a = makeClip({ startS: 0, outS: 2 })
    const b = makeClip({ startS: 3, outS: 2 })
    const seq = makeSeq([
      makeTrack({ clips: [a] }),
      makeTrack({ kind: 'audio', clips: [b], locked: true }),
    ])
    expect(unlockedClipIds(seq, [a.id, b.id])).toEqual([a.id])
  })
  it('returns empty when everything is locked', () => {
    const a = makeClip()
    const seq = makeSeq([makeTrack({ clips: [a], locked: true })])
    expect(unlockedClipIds(seq, [a.id])).toEqual([])
  })
  it('preserves input order and passes unknown ids through untouched', () => {
    const a = makeClip()
    const seq = makeSeq([makeTrack({ clips: [a] })])
    expect(unlockedClipIds(seq, ['ghost', a.id])).toEqual(['ghost', a.id])
  })
})

describe('rateStretchGroup', () => {
  const find = (seq: Sequence, id: string) => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

  it('dragging the out edge inward speeds the clip up; the source window never moves', () => {
    const c = makeClip({ startS: 0, outS: 4 }) // 4s of source at speed 1
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const out = find(rateStretchGroup(seq, c.id, 'out', 2), c.id)
    expect(out.speed).toBeCloseTo(2)
    expect(clipDurationS(out)).toBeCloseTo(2)
    expect(out.inS).toBe(0) // a stretch is NOT a trim
    expect(out.outS).toBe(4)
    expect(out.startS).toBe(0)
  })

  it('dragging the out edge outward slows it down', () => {
    const c = makeClip({ startS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const out = find(rateStretchGroup(seq, c.id, 'out', 8), c.id)
    expect(out.speed).toBeCloseTo(0.5)
    expect(clipDurationS(out)).toBeCloseTo(8)
  })

  it('the in edge keeps the END fixed and moves the start', () => {
    const c = makeClip({ startS: 2, outS: 4 }) // 2..6 on the timeline
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const out = find(rateStretchGroup(seq, c.id, 'in', 4), c.id)
    expect(out.startS).toBeCloseTo(4)
    expect(clipEndS(out)).toBeCloseTo(6)
    expect(out.speed).toBeCloseTo(2)
  })

  it('clamps against the next clip instead of overlapping it', () => {
    const a = makeClip({ startS: 0, outS: 4 })
    const b = makeClip({ startS: 5, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const out = find(rateStretchGroup(seq, a.id, 'out', 9), a.id)
    expect(clipDurationS(out)).toBeCloseTo(5) // stops at b.startS
    expect(out.speed).toBeCloseTo(4 / 5)
  })

  it('clamps against the previous clip end on the in edge', () => {
    const a = makeClip({ startS: 0, outS: 2 }) // 0..2
    const b = makeClip({ startS: 4, outS: 2 }) // 4..6
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const out = find(rateStretchGroup(seq, b.id, 'in', 0), b.id)
    expect(out.startS).toBeCloseTo(2) // stops at a's end
    expect(clipEndS(out)).toBeCloseTo(6)
  })

  it('clamps to the engine speed range both ways', () => {
    const c = makeClip({ startS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(find(rateStretchGroup(seq, c.id, 'out', 0.01), c.id).speed).toBeCloseTo(8)
    expect(find(rateStretchGroup(seq, c.id, 'out', 400), c.id).speed).toBeCloseTo(0.1)
  })

  it('a linked A/V pair stretches together and stays aligned', () => {
    const v = makeClip({ startS: 1, outS: 4, linkId: 'g' })
    const a = makeClip({ startS: 1, outS: 4, linkId: 'g' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
    const next = rateStretchGroup(seq, v.id, 'out', 3)
    const vOut = find(next, v.id)
    const aOut = find(next, a.id)
    expect(vOut.speed).toBeCloseTo(2)
    expect(aOut.speed).toBeCloseTo(2)
    expect(clipDurationS(aOut)).toBeCloseTo(clipDurationS(vOut))
    expect(aOut.startS).toBe(vOut.startS)
  })

  it('a reversed clip keeps its direction', () => {
    const c = makeClip({ startS: 0, outS: 4, speed: -1 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(find(rateStretchGroup(seq, c.id, 'out', 2), c.id).speed).toBeCloseTo(-2)
  })

  it('returns the sequence unchanged when there is no room at all', () => {
    // Fastest legal speed still needs 0.5s, but the neighbour is 0.3s away.
    const a = makeClip({ startS: 0, outS: 4 })
    const b = makeClip({ startS: 0.3, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    expect(rateStretchGroup(seq, a.id, 'out', 0.2)).toBe(seq)
  })

  it('never stretches below one output frame', () => {
    const c = makeClip({ startS: 0, outS: 0.1 }) // tiny source span
    const seq = makeSeq([makeTrack({ clips: [c] })])
    const out = find(rateStretchGroup(seq, c.id, 'out', 0), c.id)
    expect(clipDurationS(out)).toBeGreaterThanOrEqual(1 / 30 - 1e-9)
  })

  it('is a no-op for an unknown clip id', () => {
    const seq = makeSeq([makeTrack({ clips: [makeClip()] })])
    expect(rateStretchGroup(seq, 'nope', 'out', 1)).toBe(seq)
  })

  it('updates the sequence duration when the last clip grows', () => {
    const c = makeClip({ startS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [c] })])
    expect(rateStretchGroup(seq, c.id, 'out', 6).durationS).toBeCloseTo(6)
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
    expect(collectSnapPoints(seq, { excludeClipIds: [dragged.id] })).toEqual([0, 5, 7])
  })
  it('excludes the whole link group, so a linked A/V pair cannot snap to itself', () => {
    // Regression: excluding only the grabbed clip left the linked audio
    // partner's stale edges in the set, and every drag magnetized back to its
    // own origin instead of to its neighbours across lanes.
    const v = makeClip({ startS: 1, outS: 2, linkId: 'g1' })
    const a = makeClip({ startS: 1, outS: 2, linkId: 'g1' })
    const neighbour = makeClip({ startS: 5, outS: 2 })
    const seq = makeSeq([
      makeTrack({ clips: [v, neighbour] }),
      makeTrack({ kind: 'audio', clips: [a] }),
    ])
    expect(collectSnapPoints(seq, { excludeClipIds: clipGroupIds(seq, v.id) })).toEqual([0, 5, 7])
  })
  it('gathers edges across lanes: V1 and audio clips are all magnets', () => {
    const seq = makeSeq([
      makeTrack({ clips: [makeClip({ startS: 2, outS: 2 })] }), // V1: 2..4
      makeTrack({ clips: [] }), // V2, the lane being dragged into
      makeTrack({ kind: 'audio', clips: [makeClip({ startS: 9, outS: 1 })] }), // A1: 9..10
    ])
    expect(collectSnapPoints(seq)).toEqual([0, 2, 4, 9, 10])
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
    expect(seq.markers).toEqual([{ id: markerId, t: 2, label: '', color: '#ffa946' }])
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

// ---------------------------------------------------------------------------
// Linked A/V groups (Vegas-style)

const videoAsset: MediaAsset = {
  id: 'vid',
  name: 'v.mp4',
  kind: 'video',
  blobKey: 'k',
  durationS: 6,
  hasAudio: true,
  hasVideo: true,
}

describe('addClipWithLinkedAudio', () => {
  const setup = () => {
    const v = makeTrack({ name: 'V1', kind: 'video' })
    const a = makeTrack({ name: 'A1', kind: 'audio' })
    return { v, a, seq: makeSeq([v, a]) }
  }

  it('creates a linked video + audio clip sharing a linkId at the same start', () => {
    const { v, a, seq } = setup()
    const { seq: next, videoClipId, audioClipId } = addClipWithLinkedAudio(seq, v.id, a.id, videoAsset, 2)
    const vc = findClip(next, videoClipId)!
    const ac = findClip(next, audioClipId)!
    expect(vc.track.kind).toBe('video')
    expect(ac.track.kind).toBe('audio')
    expect(vc.clip.linkId).toBeDefined()
    expect(vc.clip.linkId).toBe(ac.clip.linkId)
    expect(vc.clip.startS).toBe(ac.clip.startS)
    expect(clipEndS(vc.clip)).toBeCloseTo(clipEndS(ac.clip))
  })

  it('falls back to a standalone video clip (no link) when no audio track', () => {
    const { v, seq } = setup()
    const { seq: next, videoClipId, audioClipId } = addClipWithLinkedAudio(seq, v.id, null, videoAsset, 0)
    expect(audioClipId).toBe('')
    expect(findClip(next, videoClipId)!.clip.linkId).toBeUndefined()
  })

  it('places the pair at a start free on BOTH tracks', () => {
    const v = makeTrack({ name: 'V1', kind: 'video' })
    const a = makeTrack({
      name: 'A1',
      kind: 'audio',
      clips: [makeClip({ assetId: 'x', startS: 0, outS: 3 })],
    })
    const seq = makeSeq([v, a])
    const { seq: next, videoClipId } = addClipWithLinkedAudio(seq, v.id, a.id, videoAsset, 0)
    // Audio track is occupied [0,3); the 6s pair must start at/after 3.
    expect(findClip(next, videoClipId)!.clip.startS).toBeGreaterThanOrEqual(3 - 1e-9)
  })
})

describe('group operations', () => {
  const linked = () => {
    const v = makeTrack({ name: 'V1', kind: 'video' })
    const a = makeTrack({ name: 'A1', kind: 'audio' })
    const r = addClipWithLinkedAudio(makeSeq([v, a]), v.id, a.id, videoAsset, 1)
    return { ...r, vId: r.videoClipId, aId: r.audioClipId }
  }

  it('clipGroupIds returns both members of a link, or just the clip when unlinked', () => {
    const { seq, vId, aId } = linked()
    expect(clipGroupIds(seq, vId).sort()).toEqual([vId, aId].sort())
    const solo = makeClip()
    const s2 = makeSeq([makeTrack({ clips: [solo] })])
    expect(clipGroupIds(s2, solo.id)).toEqual([solo.id])
  })

  it('moveGroup shifts both members by the same delta', () => {
    const { seq, vId, aId } = linked()
    const v0 = findClip(seq, vId)!.clip.startS
    const a0 = findClip(seq, aId)!.clip.startS
    const track = findClip(seq, vId)!.track
    const next = moveGroup(seq, vId, track.id, v0 + 2)
    expect(findClip(next, vId)!.clip.startS).toBeCloseTo(v0 + 2)
    expect(findClip(next, aId)!.clip.startS).toBeCloseTo(a0 + 2)
  })

  it('deleteGroup removes both members', () => {
    const { seq, vId, aId } = linked()
    const next = deleteGroup(seq, vId)
    expect(findClip(next, vId)).toBeNull()
    expect(findClip(next, aId)).toBeNull()
  })

  it('trimGroup trims both members to the same edge', () => {
    const { seq, vId, aId } = linked()
    const assets = { vid: videoAsset }
    const next = trimGroup(seq, assets, vId, 'out', 4)
    expect(clipEndS(findClip(next, vId)!.clip)).toBeCloseTo(4)
    expect(clipEndS(findClip(next, aId)!.clip)).toBeCloseTo(4)
  })

  it('splitGroup splits both members and re-links the right halves as one group', () => {
    const { seq, vId, aId } = linked()
    const next = splitGroup(seq, vId, 3)
    // Both original halves stay linked together; both right halves link together.
    const leftGroup = clipGroupIds(next, vId).sort()
    expect(leftGroup).toEqual([vId, aId].sort())
    const vTrack = findClip(next, vId)!.track
    const rightV = vTrack.clips.find((c) => Math.abs(c.startS - 3) < 1e-6)!
    const rightGroup = clipGroupIds(next, rightV.id)
    expect(rightGroup).toHaveLength(2)
    expect(rightGroup).not.toContain(vId)
  })

  it('splitGroup hands back the SAME sequence when the cut is refused', () => {
    // It used to rebuild the object even when every member refused, which pushed
    // an undo step labelled "Split clip" that changed nothing, and hid the
    // refusal from the razor, which reports it by reference equality. On a
    // cut-dense timeline that is the razor appearing to stop working.
    const { seq, vId } = linked()
    expect(splitGroup(seq, vId, 0.001)).toBe(seq)
    expect(splitGroup(seq, vId, 1e6)).toBe(seq)
  })

  it('splitGroup is all or nothing, so a trimmed member cannot half-split the pair', () => {
    // Once one member has been trimmed on its own, the two can sit at different
    // distances from the cut. Splitting only the willing one would give its right
    // half a fresh linkId while the refused member kept the old one, and the pair
    // would stop being a pair.
    const { seq, vId, aId } = linked()
    const assets = { vid: videoAsset }
    // Pull the audio member's out edge in, so a cut near it is legal for the
    // video and refused for the audio.
    const trimmed = trimClipTo(seq, assets, aId, 'out', 2)
    const aEnd = clipEndS(findClip(trimmed, aId)!.clip)
    const vEnd = clipEndS(findClip(trimmed, vId)!.clip)
    expect(aEnd).toBeLessThan(vEnd)

    const out = splitGroup(trimmed, vId, aEnd - 0.001)
    expect(out).toBe(trimmed)
    // And the pair is intact: still one group, still two members.
    expect(clipGroupIds(out, vId).sort()).toEqual([vId, aId].sort())
  })
})

describe('setClipSpeed', () => {
  it('slowing a clip ripples the following clip right', () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 }) // dur 4
    const b = makeClip({ id: 'b', startS: 4, inS: 0, outS: 2 }) // dur 2
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const r = setClipSpeed(seq, 'a', 0.5) // dur → 8
    const [ra, rb] = r.tracks[0].clips
    expect(ra.speed).toBe(0.5)
    expect(clipEndS(ra)).toBeCloseTo(8)
    expect(rb.startS).toBeCloseTo(8) // rippled from 4 by +4
  })

  it('speeding up leaves the following clip in place (gap opens)', () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 })
    const b = makeClip({ id: 'b', startS: 4, inS: 0, outS: 2 })
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const r = setClipSpeed(seq, 'a', 2) // dur → 2
    const [ra, rb] = r.tracks[0].clips
    expect(ra.speed).toBe(2)
    expect(clipEndS(ra)).toBeCloseTo(2)
    expect(rb.startS).toBeCloseTo(4) // unchanged
  })

  it('negative speed reverses; duration uses the magnitude', () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    const r = setClipSpeed(seq, 'a', -2)
    expect(r.tracks[0].clips[0].speed).toBe(-2)
    expect(clipEndS(r.tracks[0].clips[0])).toBeCloseTo(2)
  })

  it('clamps the speed to [0.1, 8]', () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ clips: [a] })])
    expect(setClipSpeed(seq, 'a', 999).tracks[0].clips[0].speed).toBe(8)
    expect(setClipSpeed(seq, 'a', 0.001).tracks[0].clips[0].speed).toBeCloseTo(0.1)
    expect(setClipSpeed(seq, 'a', -999).tracks[0].clips[0].speed).toBe(-8)
  })

  it('a linked A/V group changes speed together', () => {
    const v = makeClip({ id: 'v', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    const au = makeClip({ id: 'au', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [au] })])
    const r = setClipSpeed(seq, 'v', 2)
    expect(r.tracks[0].clips[0].speed).toBe(2)
    expect(r.tracks[1].clips[0].speed).toBe(2)
  })
})

describe('setSequenceFormat / refitClipToFill (Shorts aspect switch)', () => {
  const landscape = { a: makeAsset({ id: 'a', width: 1920, height: 1080 }) }
  const clip16x9 = () => makeClip({ id: 'a', assetId: 'a', startS: 0, outS: 4 })
  // 16:9 source covering a 9:16 frame → scale = max/min of the fit ratios.
  const COVER_16x9_INTO_9x16 = 1920 / 1080 / (1080 / 1920) // ≈ 3.1605

  it('scales a 16:9 clip to COVER a 9:16 frame (fill + crop)', () => {
    const out = refitClipToFill(clip16x9(), landscape, 1080, 1920)
    expect(out.transform.scale).toBeCloseTo(COVER_16x9_INTO_9x16, 3)
    expect(out.transform.x).toBe(0)
    expect(out.transform.y).toBe(0)
  })

  it('a clip already matching the frame aspect keeps scale 1', () => {
    const out = refitClipToFill(clip16x9(), landscape, 1920, 1080)
    expect(out.transform.scale).toBeCloseTo(1, 6)
  })

  it('does not fight a clip that animates position (posX keyframes)', () => {
    const panned = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      keyframes: {
        scale: [{ t: 0, value: 1, ease: 'linear' }],
        posX: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 2, value: 0.3, ease: 'linear' },
        ],
      },
    })
    expect(refitClipToFill(panned, landscape, 1080, 1920, 1920, 1080)).toBe(panned)
  })

  it('refits a punch-in zoom by scaling its keyframes (16:9 → 9:16)', () => {
    const punch = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      keyframes: {
        scale: [
          { t: 0, value: 1, ease: 'linear' },
          { t: 2, value: 1.2, ease: 'easeInOut' },
        ],
      },
    })
    const out = refitClipToFill(punch, landscape, 1080, 1920, 1920, 1080)
    const kfs = out.keyframes?.scale ?? []
    expect(kfs).toHaveLength(2)
    expect(kfs[0].value).toBeCloseTo(COVER_16x9_INTO_9x16, 6)
    expect(kfs[1].value).toBeCloseTo(COVER_16x9_INTO_9x16 * 1.2, 6)
    expect(kfs[1].ease).toBe('easeInOut') // t/ease ride along untouched
    expect(out.transform.scale).toBeCloseTo(COVER_16x9_INTO_9x16, 6)
    expect(out.transform.x).toBe(0)
    expect(out.transform.y).toBe(0)
    // Input keyframes were not mutated.
    expect(punch.keyframes?.scale?.[0].value).toBe(1)
    expect(punch.keyframes?.scale?.[1].value).toBe(1.2)
  })

  it('punch-in round-trip 16:9 → 9:16 → 16:9 restores the keyframes', () => {
    const punch = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      keyframes: {
        scale: [
          { t: 0, value: 1, ease: 'linear' },
          { t: 2, value: 1.2, ease: 'easeInOut' },
        ],
      },
    })
    const seq = makeSeq([makeTrack({ clips: [punch] })])
    const shorts = setSequenceFormat(seq, landscape, 1080, 1920)
    const back = setSequenceFormat(shorts, landscape, 1920, 1080)
    const clip = back.tracks[0].clips[0]
    const kfs = clip.keyframes?.scale ?? []
    expect(kfs).toHaveLength(2)
    expect(kfs[0].value).toBeCloseTo(1, 6)
    expect(kfs[1].value).toBeCloseTo(1.2, 6)
    expect(clip.transform.scale).toBeCloseTo(1, 6)
  })

  it('leaves a hand-scaled keyframed clip alone (baseline is the author’s)', () => {
    const zoomed = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      keyframes: {
        scale: [
          { t: 0, value: 2, ease: 'linear' },
          { t: 2, value: 2.4, ease: 'linear' },
        ],
      },
    })
    const seq = makeSeq([makeTrack({ clips: [zoomed] })])
    const out = setSequenceFormat(seq, landscape, 1080, 1920)
    expect(out.tracks[0].clips[0]).toBe(zoomed)
  })

  it('leaves title clips alone (frame-relative already)', () => {
    const title = makeClip({ id: 't', startS: 0, outS: 4, title: { text: 'hi' } as never })
    expect(refitClipToFill(title, landscape, 1080, 1920)).toBe(title)
  })

  // slideIn/slideOut travel W/2 and riseUp/dropDown H*0.35, so they bake the
  // frame into their VALUES. A format switch left them travelling the old
  // frame's distance AND permanently disarmed retiming, because the
  // untouched-guard rebuilds its expectation from the CURRENT size.
  describe('a frame-relative preset across a format switch', () => {
    const slid = () => {
      const base = makeClip({
        id: 's',
        startS: 0,
        outS: 4,
        title: { text: 'hi' } as never,
        appearance: { in: 'slideIn', out: 'slideOut', durS: 0.5 },
      })
      return applyAppearanceToClip(base, base.appearance!, 1920, 1080)
    }

    it('rebakes the travel distance for the new frame', () => {
      const seq = makeSeq([makeTrack({ clips: [slid()] })])
      const out = setSequenceFormat(seq, landscape, 1080, 1920)
      // Travel is half the frame WIDTH: 960 landscape → 540 portrait.
      expect(channelKeyframes(out.tracks[0].clips[0], 'posX')[0].value).toBeCloseTo(-540, 6)
    })

    it('can still be retimed by a trim afterwards', () => {
      const seq = makeSeq([makeTrack({ clips: [slid()] })])
      const shorts = setSequenceFormat(seq, landscape, 1080, 1920)
      const c = shorts.tracks[0].clips[0]
      // A trim recompiles only while the keyframes still match the spec, which
      // is exactly what the stale bake used to make impossible. The exit is baked
      // at [D-d, D], so shortening 4s → 2s must move its last keyframe to t=2.
      const trimmed = retimeAppearance(c, { ...c, outS: 2 }, shorts.width, shorts.height)
      const posX = channelKeyframes(trimmed, 'posX')
      expect(posX[posX.length - 1].t).toBeCloseTo(2, 6)
    })
  })

  it('setSequenceFormat sets the new dimensions and refits every clip', () => {
    const seq = makeSeq([makeTrack({ clips: [clip16x9()] })])
    const out = setSequenceFormat(seq, landscape, 1080, 1920)
    expect(out.width).toBe(1080)
    expect(out.height).toBe(1920)
    expect(out.tracks[0].clips[0].transform.scale).toBeCloseTo(COVER_16x9_INTO_9x16, 3)
  })

  it('refit:false changes dimensions but leaves clip transforms untouched', () => {
    const seq = makeSeq([makeTrack({ clips: [clip16x9()] })])
    const out = setSequenceFormat(seq, landscape, 1080, 1920, false)
    expect(out.width).toBe(1080)
    expect(out.tracks[0].clips[0].transform.scale).toBe(1)
  })

  it('leaves a manually repositioned clip alone (x/y set by the author)', () => {
    const moved = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      transform: { ...defaultTransform(), x: 0.2, y: -0.1 },
    })
    const seq = makeSeq([makeTrack({ clips: [moved] })])
    const out = setSequenceFormat(seq, landscape, 1080, 1920)
    expect(out.width).toBe(1080)
    expect(out.tracks[0].clips[0]).toBe(moved)
  })

  it('leaves a manually scaled clip alone (scale set by the author)', () => {
    const scaled = makeClip({
      id: 'a',
      assetId: 'a',
      startS: 0,
      outS: 4,
      transform: { ...defaultTransform(), scale: 2 },
    })
    const seq = makeSeq([makeTrack({ clips: [scaled] })])
    const out = setSequenceFormat(seq, landscape, 1080, 1920)
    expect(out.tracks[0].clips[0]).toBe(scaled)
  })

  it('re-refits its OWN previous cover-fit when switching back (9:16 → 16:9)', () => {
    const seq = makeSeq([makeTrack({ clips: [clip16x9()] })])
    const shorts = setSequenceFormat(seq, landscape, 1080, 1920)
    expect(shorts.tracks[0].clips[0].transform.scale).toBeCloseTo(COVER_16x9_INTO_9x16, 3)
    const back = setSequenceFormat(shorts, landscape, 1920, 1080)
    expect(back.tracks[0].clips[0].transform.scale).toBeCloseTo(1, 6)
  })
})

describe('splitClipOnly (cut just the selected clip)', () => {
  const linkedPair = () => {
    const v = makeClip({ id: 'v', assetId: 'av', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    const a = makeClip({ id: 'a', assetId: 'av', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    return makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
  }

  it('splits ONLY the named clip; the linked partner is untouched', () => {
    const out = splitClipOnly(linkedPair(), 'v', 2)
    expect(out.tracks[0].clips).toHaveLength(2) // video cut
    expect(out.tracks[1].clips).toHaveLength(1) // audio left alone
    expect(out.tracks[1].clips[0].linkId).toBe('g')
  })

  it('gives each half its OWN link group, so they move independently', () => {
    const out = splitClipOnly(linkedPair(), 'v', 2)
    const [left, right] = out.tracks[0].clips
    expect(left.linkId).not.toBe(right.linkId)
    expect(clipGroupIds(out, left.id)).toEqual([left.id])
    expect(clipGroupIds(out, right.id)).toEqual([right.id])
  })

  it('keeps both halves LINKED so their audio never doubles the partner', () => {
    // A video clip without a linkId plays its own audio. Dropping the link
    // here would play the sound twice against the untouched partner clip.
    const out = splitClipOnly(linkedPair(), 'v', 2)
    const videoTrack = out.tracks[0]
    for (const c of videoTrack.clips) {
      expect(c.linkId).toBeDefined()
      expect(clipEmitsAudio(videoTrack, c)).toBe(false)
    }
    expect(clipEmitsAudio(out.tracks[1], out.tracks[1].clips[0])).toBe(true)
  })

  it('cutting the AUDIO half alone leaves the video whole', () => {
    const out = splitClipOnly(linkedPair(), 'a', 2)
    expect(out.tracks[1].clips).toHaveLength(2)
    expect(out.tracks[0].clips).toHaveLength(1)
  })

  it('an unlinked clip just splits, halves stay unlinked (they own their audio)', () => {
    const solo = makeClip({ id: 's', assetId: 'av', startS: 0, inS: 0, outS: 4 })
    const out = splitClipOnly(makeSeq([makeTrack({ clips: [solo] })]), 's', 2)
    expect(out.tracks[0].clips).toHaveLength(2)
    expect(out.tracks[0].clips.every((c) => c.linkId === undefined)).toBe(true)
  })

  it('honours the min-piece guard (no sliver, no stray relink)', () => {
    const seq = linkedPair()
    expect(splitClipOnly(seq, 'v', 0.001)).toBe(seq)
  })
})

describe('deleteScoped (one selection-aware Delete verb)', () => {
  const pair = () => {
    const v = makeClip({ id: 'v', assetId: 'av', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    const a = makeClip({ id: 'a', assetId: 'av', startS: 0, inS: 0, outS: 4, linkId: 'g' })
    return makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
  }

  it('the audio half of a linked pair deletes ALONE: video survives, still silent', () => {
    const out = deleteScoped(pair(), 'a')
    expect(out.tracks[1].clips).toHaveLength(0)
    expect(out.tracks[0].clips).toHaveLength(1)
    // The survivor keeps its linkId, so clipEmitsAudio keeps it video-only:
    // deleting the sound must not resurrect the clip's own (duplicate) audio.
    const survivor = out.tracks[0].clips[0]
    expect(survivor.linkId).toBe('g')
    expect(clipEmitsAudio(out.tracks[0], survivor)).toBe(false)
  })

  it('a VIDEO clip takes its linked audio with it (the everyday click-and-Del)', () => {
    const out = deleteScoped(pair(), 'v')
    expect(out.tracks[0].clips).toHaveLength(0)
    expect(out.tracks[1].clips).toHaveLength(0)
  })

  it('an unlinked audio clip (music/SFX) just deletes itself', () => {
    const solo = makeClip({ id: 's', assetId: 'av', startS: 0, inS: 0, outS: 4 })
    const seq = makeSeq([makeTrack({ kind: 'audio', clips: [solo] })])
    const out = deleteScoped(seq, 's')
    expect(out.tracks[0].clips).toHaveLength(0)
  })
})

describe('addTrack', () => {
  it('adds an audio track below the audio block, named A(n+1)', () => {
    const seq = makeSeq([
      makeTrack({ kind: 'video', name: 'V1' }),
      makeTrack({ kind: 'audio', name: 'A1' }),
      makeTrack({ kind: 'audio', name: 'A2' }),
    ])
    const r = addTrack(seq, 'audio')
    expect(r.tracks).toHaveLength(4)
    expect(r.tracks[3]).toMatchObject({ kind: 'audio', name: 'A3' })
  })

  it('adds a video track inside the video block (before the first audio), named V(n+1)', () => {
    const seq = makeSeq([
      makeTrack({ kind: 'video', name: 'V1' }),
      makeTrack({ kind: 'video', name: 'V2' }),
      makeTrack({ kind: 'audio', name: 'A1' }),
    ])
    const r = addTrack(seq, 'video')
    // Inserted at index 2 (just before A1), so audio stays after the video block.
    expect(r.tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'A1'])
    expect(r.tracks[2].kind).toBe('video')
  })

  it('names from the highest existing number, not the count', () => {
    const seq = makeSeq([makeTrack({ kind: 'audio', name: 'A5' })])
    expect(addTrack(seq, 'audio').tracks.at(-1)!.name).toBe('A6')
  })
})

describe('close gap', () => {
  const A = () => makeClip({ id: 'A', startS: 0, inS: 0, outS: 2 }) // ends 2
  const B = () => makeClip({ id: 'B', startS: 5, inS: 0, outS: 2 }) // gap 3 before it, ends 7
  const C = () => makeClip({ id: 'C', startS: 10, inS: 0, outS: 2 }) // gap 3 before it

  it('gapBefore measures the empty space before a clip', () => {
    const seq = makeSeq([makeTrack({ clips: [A(), B(), C()] })])
    expect(gapBefore(seq, 'B')).toBeCloseTo(3, 6)
    expect(gapBefore(seq, 'A')).toBe(0) // first clip, starts at 0
  })

  it('closeGapBefore slides the clip + everything after it left to butt the previous', () => {
    const seq = makeSeq([makeTrack({ clips: [A(), B(), C()] })])
    const r = closeGapBefore(seq, 'B')
    const clips = r.tracks[0].clips
    expect(clips.find((c) => c.id === 'B')!.startS).toBeCloseTo(2, 6)
    expect(clips.find((c) => c.id === 'C')!.startS).toBeCloseTo(7, 6) // rippled by the same 3
    expect(clips.find((c) => c.id === 'A')!.startS).toBe(0) // before it, untouched
  })

  it('closeGapBefore is a no-op when there is no gap', () => {
    const seq = makeSeq([makeTrack({ clips: [A(), makeClip({ id: 'B', startS: 2, inS: 0, outS: 2 })] })])
    expect(closeGapBefore(seq, 'B')).toBe(seq)
  })

  it('closeAllGaps butts every clip together, keeping the first in place', () => {
    const seq = makeSeq([makeTrack({ clips: [A(), B(), C()] })])
    const r = closeAllGaps(seq, seq.tracks[0].id)
    const starts = r.tracks[0].clips.sort((a, b) => a.startS - b.startS).map((c) => c.startS)
    expect(starts).toEqual([0, 2, 4])
  })
})

describe('close gap is link-group aware', () => {
  it('closeGapBefore moves a video clip AND its linked audio partner together', () => {
    const v0 = makeClip({ id: 'V0', startS: 0, inS: 0, outS: 2 }) // ends 2
    const v1 = makeClip({ id: 'V1', startS: 5, inS: 0, outS: 2, linkId: 'lg' }) // gap 3
    const a1 = makeClip({ id: 'A1', startS: 5, inS: 0, outS: 2, linkId: 'lg' }) // linked partner
    const seq = makeSeq([
      makeTrack({ kind: 'video', name: 'V1', clips: [v0, v1] }),
      makeTrack({ kind: 'audio', name: 'A1', clips: [a1] }),
    ])
    const r = closeGapBefore(seq, 'V1')
    const vid = r.tracks[0].clips.find((c) => c.id === 'V1')!
    const aud = r.tracks[1].clips.find((c) => c.id === 'A1')!
    expect(vid.startS).toBeCloseTo(2, 6)
    expect(aud.startS).toBeCloseTo(2, 6) // partner moved the same 3s, no A/V drift
  })
})

describe('linkGroupIndex', () => {
  it('collects every member of a link group in one pass, across tracks', () => {
    const seq = makeSeq([
      makeTrack({
        kind: 'video',
        clips: [
          makeClip({ id: 'V1', startS: 0, inS: 0, outS: 1, linkId: 'lg' }),
          makeClip({ id: 'SOLO', startS: 2, inS: 0, outS: 1 }),
        ],
      }),
      makeTrack({ kind: 'audio', clips: [makeClip({ id: 'A1', startS: 0, inS: 0, outS: 1, linkId: 'lg' })] }),
    ])
    const byLink = linkGroupIndex(seq)
    expect(byLink.get('lg')).toEqual(['V1', 'A1'])
    expect(byLink.size).toBe(1) // an unlinked clip contributes nothing
  })

  it('agrees with clipGroupIds for every clip, linked or not', () => {
    const seq = makeSeq([
      makeTrack({
        kind: 'video',
        clips: [
          makeClip({ id: 'V1', startS: 0, inS: 0, outS: 1, linkId: 'lg' }),
          makeClip({ id: 'SOLO', startS: 2, inS: 0, outS: 1 }),
        ],
      }),
      makeTrack({ kind: 'audio', clips: [makeClip({ id: 'A1', startS: 0, inS: 0, outS: 1, linkId: 'lg' })] }),
    ])
    const byLink = linkGroupIndex(seq)
    for (const track of seq.tracks) {
      for (const c of track.clips) {
        expect(byLink.get(c.linkId ?? '') ?? [c.id]).toEqual(clipGroupIds(seq, c.id))
      }
    }
  })
})

describe('closing gaps stays linear in the clip count', () => {
  // THE BUG. closeAllGaps and closeGapBefore called clipGroupIds once per clip,
  // and clipGroupIds is itself a findClip scan plus a full two-level scan, so the
  // tidy-up was O(n^2). Measured on this machine with the old code: 400 clips
  // 4.1ms, 1000 clips 6.3ms, 2000 clips 20.9ms, 4000 clips 93.2ms. With the
  // prebuilt link index: 2.2ms at 4000. Restore the old per-clip call and this
  // budget goes red.
  const BUDGET_MS = 40

  function packedPairs(n: number): ReturnType<typeof makeSeq> {
    const video = Array.from({ length: n }, (_, i) =>
      makeClip({ id: `v${i}`, startS: i * 1.0, inS: 0, outS: 0.5, linkId: `lg${i}` }),
    )
    const audio = Array.from({ length: n }, (_, i) =>
      makeClip({ id: `a${i}`, startS: i * 1.0, inS: 0, outS: 0.5, linkId: `lg${i}` }),
    )
    return makeSeq([
      makeTrack({ kind: 'video', name: 'V1', clips: video }),
      makeTrack({ kind: 'audio', name: 'A1', clips: audio }),
    ])
  }

  it('closeAllGaps tidies 4000 linked clips inside the frame budget', () => {
    const seq = packedPairs(4000)
    const t0 = performance.now()
    const r = closeAllGaps(seq, seq.tracks[0].id)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(BUDGET_MS)
    // and it is still correct: every clip butted against the last, partners with them
    expect(r.tracks[0].clips[3999].startS).toBeCloseTo(1999.5, 6)
    expect(r.tracks[1].clips[3999].startS).toBeCloseTo(1999.5, 6)
  })

  it('closeGapBefore ripples 4000 linked clips inside the same budget', () => {
    const seq = packedPairs(4000)
    const t0 = performance.now()
    const r = closeGapBefore(seq, 'v1')
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(BUDGET_MS)
    expect(r.tracks[0].clips[1].startS).toBeCloseTo(0.5, 6)
    expect(r.tracks[1].clips[1].startS).toBeCloseTo(0.5, 6)
  })
})

describe('linked A/V groups stay in sync', () => {
  const find = (seq: Sequence, id: string) => seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

  it('moveGroup refuses the whole move when a partner cannot take the delta', () => {
    // V at 0-4 on V1; its linked audio A at 0-4 on A1, plus music M at 5-9 on A1.
    // Dragging V to 6 leaves no 4s hole at 6 on A1, so resolveStart would have
    // relocated A to 9, three seconds away from its own picture.
    const v = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const a = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const m = makeClip({ startS: 5, outS: 4 })
    const vTrack = makeTrack({ clips: [v] })
    const aTrack = makeTrack({ kind: 'audio', clips: [a, m] })
    const seq = makeSeq([vTrack, aTrack])

    const out = moveGroup(seq, v.id, vTrack.id, 6)
    expect(find(out, v.id).startS).toBe(0) // nothing moved at all
    expect(find(out, a.id).startS).toBe(0)
    expect(find(out, m.id).startS).toBe(5)
  })

  it('moveGroup still moves the pair together when there IS room', () => {
    const v = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const a = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const vTrack = makeTrack({ clips: [v] })
    const aTrack = makeTrack({ kind: 'audio', clips: [a] })
    const out = moveGroup(makeSeq([vTrack, aTrack]), v.id, vTrack.id, 6)
    expect(find(out, v.id).startS).toBe(6)
    expect(find(out, a.id).startS).toBe(6)
  })

  it('slipGroup slips BOTH halves, so the picture never runs ahead of the voice', () => {
    const v = makeClip({ startS: 0, inS: 2, outS: 6, linkId: 'g' })
    const a = makeClip({ startS: 0, inS: 2, outS: 6, linkId: 'g' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
    const out = slipGroup(seq, ASSETS, v.id, 1)
    expect(find(out, v.id).inS).toBeCloseTo(3, 6)
    expect(find(out, a.id).inS).toBeCloseTo(3, 6)
    expect(find(out, v.id).outS).toBeCloseTo(find(out, a.id).outS, 6)
    // and it is still a slip: position and length untouched
    expect(find(out, v.id).startS).toBe(0)
    expect(clipDurationS(find(out, v.id))).toBeCloseTo(4, 6)
  })

  it('slipGroup clamps to the TIGHTEST member so the halves cannot diverge', () => {
    // The audio half has only 0.5s of tail handle left; the video has 4s.
    const v = makeClip({ startS: 0, inS: 2, outS: 6, linkId: 'g' })
    const a = makeClip({ startS: 0, inS: 2, outS: 9.5, linkId: 'g' })
    const seq = makeSeq([makeTrack({ clips: [v] }), makeTrack({ kind: 'audio', clips: [a] })])
    const out = slipGroup(seq, ASSETS, v.id, 3)
    expect(find(out, v.id).inS).toBeCloseTo(2.5, 6)
    expect(find(out, a.id).inS).toBeCloseTo(2.5, 6)
  })

  it('pasting only ONE half of a pair drops the link, so the copy still has sound', () => {
    const v = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const a = makeClip({ startS: 0, outS: 4, linkId: 'g' })
    const vTrack = makeTrack({ clips: [v] })
    const seq = makeSeq([vTrack, makeTrack({ kind: 'audio', clips: [a] })])

    const lone = pasteClips(seq, serializeClips(seq, [v.id]), 5)
    const pasted = find(lone.seq, lone.newIds[0])
    expect(pasted.linkId).toBeUndefined()
    expect(clipEmitsAudio(vTrack, pasted)).toBe(true)

    // The whole pair still pastes LINKED, to each other and not to the source.
    const both = pasteClips(seq, serializeClips(seq, [v.id, a.id]), 5)
    const [pv, pa] = both.newIds.map((id) => find(both.seq, id))
    expect(pv.linkId).toBeDefined()
    expect(pv.linkId).toBe(pa.linkId)
    expect(pv.linkId).not.toBe('g')
  })
})

describe('captions survive a format switch', () => {
  const captionClip = (over: Partial<Clip> = {}): Clip =>
    makeClip({
      assetId: '',
      title: {
        text: 'diamonds',
        // A caption SAVED BY AN OLDER VERSION on purpose: the point of this test
        // is that a project made before the style was remeasured still rescales.
        fontFamily: 'Lilita One',
        fontSizePx: 87,
        color: '#ffffff',
        align: 'center',
        vAlign: 'bottom',
        bold: true,
        italic: false,
        lineHeight: 1.1,
        offsetXPx: 0,
        offsetYPx: -21,
        outline: { color: '#000000', widthPx: 5 },
      },
      ...over,
    })

  it('rescales caption metrics with the frame when switching 16:9 → 9:16', () => {
    // Caption first, THEN hit the Look. That is the natural order, since the Look is
    // the "make it a Short" button. The caption used to be left at its
    // 1080-frame size inside a 1920-tall frame: half the intended size, thin
    // outline, wrong height, forty clips to fix by hand.
    const c = captionClip()
    const seq = makeSeq([makeTrack({ clips: [c] })], { width: 1920, height: 1080 })
    const out = setSequenceFormat(seq, {}, 1080, 1920)
    const title = out.tracks[0].clips[0].title!
    const ratio = 1920 / 1080
    expect(title.fontSizePx).toBe(Math.round(87 * ratio))
    expect(title.offsetYPx).toBe(Math.round(-21 * ratio))
    expect(title.outline!.widthPx).toBe(Math.round(5 * ratio))
    // Style is untouched: only the measurements move.
    expect(title.text).toBe('diamonds')
    expect(title.vAlign).toBe('bottom')
  })

  it('is reversible: switching back restores the original metrics', () => {
    const c = captionClip()
    const seq = makeSeq([makeTrack({ clips: [c] })], { width: 1920, height: 1080 })
    const vertical = setSequenceFormat(seq, {}, 1080, 1920)
    const back = setSequenceFormat(vertical, {}, 1920, 1080)
    const title = back.tracks[0].clips[0].title!
    expect(title.fontSizePx).toBe(87)
    expect(title.outline!.widthPx).toBe(5)
  })

  it('leaves a title alone when the frame size did not change', () => {
    const c = captionClip()
    const seq = makeSeq([makeTrack({ clips: [c] })], { width: 1920, height: 1080 })
    const out = setSequenceFormat(seq, {}, 1920, 1080)
    expect(out.tracks[0].clips[0]).toBe(c) // same reference: nothing rebuilt
  })
})

// ---------------------------------------------------------------------------
// Appearance animations follow the clip's length

describe('trim/speed edits retime a clip appearance', () => {
  // A 5s title with a 0.5s fade out: the exit window sits at [4.5, 5].
  const fadedTitle = (): Clip =>
    applyAppearanceToClip(newTitleClip(defaultTitleDef('Hi'), 0, 5), { out: 'fadeOut', durS: 0.5 }, 1920, 1080)

  const seqWith = (clips: Clip[]): Sequence => makeSeq([makeTrack({ clips })])
  const only = (seq: Sequence): Clip => seq.tracks[0].clips[0]

  it('trimming the out edge LONGER moves the fade with it (was: invisible tail)', () => {
    const seq = seqWith([fadedTitle()])
    // A title has no source bounds, so the out edge can be dragged past 5s.
    const out = only(trimClipTo(seq, ASSETS, only(seq).id, 'out', 8))
    expect(clipDurationS(out)).toBeCloseTo(8, 5)
    expect(resolveChannel(out, 'opacity', 6)).toBeCloseTo(1, 5)
    expect(resolveChannel(out, 'opacity', 8)).toBeCloseTo(0, 5)
  })

  it('trimming the out edge SHORTER lands the fade on the new end', () => {
    const seq = seqWith([fadedTitle()])
    const out = only(trimClipTo(seq, ASSETS, only(seq).id, 'out', 3))
    expect(resolveChannel(out, 'opacity', 2)).toBeCloseTo(1, 5)
    expect(resolveChannel(out, 'opacity', 3)).toBeCloseTo(0, 5)
  })

  it('ripple trim retimes it too', () => {
    const seq = seqWith([fadedTitle()])
    const out = only(rippleTrimTo(seq, ASSETS, only(seq).id, 'out', 2))
    expect(resolveChannel(out, 'opacity', 1)).toBeCloseTo(1, 5)
    expect(resolveChannel(out, 'opacity', 2)).toBeCloseTo(0, 5)
  })

  it('a speed change retimes it', () => {
    const seq = seqWith([fadedTitle()])
    const out = only(setClipSpeed(seq, only(seq).id, 2)) // 5s -> 2.5s
    expect(resolveChannel(out, 'opacity', 1.5)).toBeCloseTo(1, 5)
    expect(resolveChannel(out, 'opacity', 2.5)).toBeCloseTo(0, 5)
  })

  it('a roll edit retimes both sides', () => {
    const left = fadedTitle()
    const right = applyAppearanceToClip(
      newTitleClip(defaultTitleDef('Two'), 5, 5),
      { out: 'fadeOut', durS: 0.5 },
      1920,
      1080,
    )
    const seq = seqWith([left, right])
    const rolled = rollEditTo(seq, ASSETS, left.id, right.id, 7)
    const [l, r] = rolled.tracks[0].clips
    expect(resolveChannel(l, 'opacity', 6)).toBeCloseTo(1, 5)
    expect(resolveChannel(l, 'opacity', 7)).toBeCloseTo(0, 5)
    expect(resolveChannel(r, 'opacity', 2)).toBeCloseTo(1, 5)
    expect(resolveChannel(r, 'opacity', 3)).toBeCloseTo(0, 5)
  })

  it('splitting gives the entrance to the left half and the exit to the right', () => {
    const clip = applyAppearanceToClip(
      newTitleClip(defaultTitleDef('Hi'), 0, 5),
      { in: 'fadeIn', out: 'fadeOut', durS: 0.5 },
      1920,
      1080,
    )
    const [l, r] = splitClip(seqWith([clip]), clip.id, 2).tracks[0].clips
    expect(l.appearance).toEqual({ in: 'fadeIn', durS: 0.5 })
    expect(r.appearance).toEqual({ out: 'fadeOut', durS: 0.5 })
    // The motion itself is unchanged by the cut: fade in at the head, out at the tail.
    expect(resolveChannel(l, 'opacity', 0)).toBeCloseTo(0, 5)
    expect(resolveChannel(l, 'opacity', 2)).toBeCloseTo(1, 5)
    expect(resolveChannel(r, 'opacity', 0)).toBeCloseTo(1, 5)
    expect(resolveChannel(r, 'opacity', 3)).toBeCloseTo(0, 5)
    // ...and each half now retimes on its own.
    const grown = splitClip(seqWith([clip]), clip.id, 2).tracks[0].clips[1]
    const seq2 = makeSeq([makeTrack({ clips: [grown] })])
    const stretched = seq2.tracks[0].clips[0]
    const trimmed = trimClipTo(seq2, ASSETS, stretched.id, 'out', 8).tracks[0].clips[0]
    expect(resolveChannel(trimmed, 'opacity', 4)).toBeCloseTo(1, 5)
    expect(resolveChannel(trimmed, 'opacity', 6)).toBeCloseTo(0, 5)
  })

  it('leaves a clip with no appearance untouched', () => {
    const plain = newTitleClip(defaultTitleDef('Hi'), 0, 5)
    const seq = seqWith([plain])
    const out = only(trimClipTo(seq, ASSETS, plain.id, 'out', 8))
    expect(out.keyframes ?? {}).toEqual({})
    expect(out.appearance).toBeUndefined()
  })
})

describe('clearSpan (the overwrite edit)', () => {
  // Without this every placement went through resolveStart, which hunts for the
  // nearest gap that FITS. On a packed timeline no interior gap fits, so a drag
  // snapped back where it started and a drop landed at the end of the sequence.
  const packed = () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 }) // 0 to 4
    const b = makeClip({ id: 'b', startS: 4, inS: 0, outS: 4 }) // 4 to 8
    const c = makeClip({ id: 'c', startS: 8, inS: 0, outS: 4 }) // 8 to 12
    const track = makeTrack({ clips: [a, b, c] })
    return { seq: makeSeq([track]), trackId: track.id }
  }
  const clipsOf = (s: Sequence, trackId: string) => s.tracks.find((t) => t.id === trackId)!.clips
  const spans = (s: Sequence, trackId: string) =>
    clipsOf(s, trackId).map((c) => [Number(c.startS.toFixed(6)), Number(clipEndS(c).toFixed(6))])

  it('there was no way to do this before: resolveStart sends a drop to the END', () => {
    // The bug, stated as a test. A 4s clip into a fully packed 0 to 12 track has
    // no interior gap that fits, so the only candidate is the open end.
    const { seq, trackId } = packed()
    const track = seq.tracks.find((t) => t.id === trackId)!
    expect(resolveStart(track, 4, 4)).toBe(12)
  })

  it('drops a clip that is wholly inside the span', () => {
    const { seq, trackId } = packed()
    const out = clearSpan(seq, trackId, 4, 8)
    expect(clipsOf(out, trackId).map((c) => c.id)).toEqual(['a', 'c'])
    expect(spans(out, trackId)).toEqual([[0, 4], [8, 12]])
  })

  it('trims a clip that overlaps one edge, keeping the part outside', () => {
    const { seq, trackId } = packed()
    const out = clearSpan(seq, trackId, 2, 6)
    // a keeps 0 to 2, b keeps 6 to 8, c untouched.
    expect(spans(out, trackId)).toEqual([[0, 2], [6, 8], [8, 12]])
  })

  it('punches a hole through a clip that straddles BOTH edges', () => {
    const one = makeClip({ id: 'solo', startS: 0, inS: 0, outS: 10 })
    const track = makeTrack({ clips: [one] })
    const seq = makeSeq([track])
    const out = clearSpan(seq, track.id, 3, 6)
    expect(spans(out, track.id)).toEqual([[0, 3], [6, 10]])
  })

  it('carries source times through the trim, so the picture does not shift', () => {
    const one = makeClip({ id: 'solo', startS: 0, inS: 5, outS: 15 }) // src 5..15
    const track = makeTrack({ clips: [one] })
    const out = clearSpan(makeSeq([track]), track.id, 4, 6)
    const [left, right] = clipsOf(out, track.id)
    expect(left.inS).toBeCloseTo(5, 9)
    expect(left.outS).toBeCloseTo(9, 9) // 4s of source consumed
    expect(right.startS).toBeCloseTo(6, 9)
    expect(right.inS).toBeCloseTo(11, 9) // 6s consumed at speed 1
  })

  it('never overwrites the clip being moved, or anything in its link group', () => {
    const { seq, trackId } = packed()
    const out = clearSpan(seq, trackId, 0, 12, ['b'])
    expect(clipsOf(out, trackId).map((c) => c.id)).toEqual(['b'])
  })

  it('leaves the track alone when nothing overlaps, and on an empty span', () => {
    const { seq, trackId } = packed()
    expect(spans(clearSpan(seq, trackId, 20, 24), trackId)).toEqual([[0, 4], [4, 8], [8, 12]])
    expect(clearSpan(seq, trackId, 5, 5)).toBe(seq)
    expect(clearSpan(seq, trackId, 5, 4)).toBe(seq)
  })

  it('always leaves clips sorted and non-overlapping, which the resolver assumes', () => {
    const { seq, trackId } = packed()
    for (const [s, e] of [[1, 3], [3.5, 8.5], [0, 12], [7, 20], [2, 2.01]]) {
      const cl = clipsOf(clearSpan(seq, trackId, s, e), trackId)
      for (let i = 1; i < cl.length; i++) {
        expect(cl[i].startS).toBeGreaterThanOrEqual(clipEndS(cl[i - 1]) - 1e-6)
      }
    }
  })
})

describe('addClipFromAsset with overwrite (his complaint, end to end)', () => {
  const packedTrack = () => {
    const a = makeClip({ id: 'a', startS: 0, inS: 0, outS: 4 })
    const b = makeClip({ id: 'b', startS: 4, inS: 0, outS: 4 })
    const t = makeTrack({ clips: [a, b] })
    return { seq: makeSeq([t]), trackId: t.id }
  }
  const asset: MediaAsset = {
    id: 'newvid', name: 'new', kind: 'video', blobKey: 'k',
    durationS: 2, hasAudio: false, hasVideo: true,
  }

  it('WITHOUT overwrite it still lands at the end, which is the old behaviour', () => {
    const { seq, trackId } = packedTrack()
    const { seq: out, clipId } = addClipFromAsset(seq, trackId, asset, 2)
    const placed = findClip(out, clipId)!.clip
    expect(placed.startS).toBe(8) // dumped after everything, not at 2
  })

  it('WITH overwrite it lands exactly where he dropped it', () => {
    const { seq, trackId } = packedTrack()
    const { seq: out, clipId } = addClipFromAsset(seq, trackId, asset, 2, { overwrite: true })
    const placed = findClip(out, clipId)!.clip
    expect(placed.startS).toBe(2)
    const spans = out.tracks
      .find((t) => t.id === trackId)!
      .clips.map((c) => [Number(c.startS.toFixed(6)), Number(clipEndS(c).toFixed(6))])
    // a is trimmed to 0..2, the new clip owns 2..4, b is untouched.
    expect(spans).toEqual([[0, 2], [2, 4], [4, 8]])
  })
})

// A sequence was born at 30 fps and nothing in the app could ever change it, so
// a 60 fps recording was edited AND EXPORTED at 30. Half his frames, thrown
// away silently, on the rate most phones and every screen recorder default to.
describe('adoptFrameRate', () => {
  const empty = () => makeSeq([makeTrack(), makeTrack({ kind: 'audio' })])

  it('the first video onto an empty timeline sets the rate', () => {
    expect(adoptFrameRate(empty(), makeAsset({ fps: 60 })).fps).toBe(60)
  })

  it('leaves a timeline that already has work on it alone', () => {
    const used = makeSeq([makeTrack({ clips: [makeClip()] })])
    expect(adoptFrameRate(used, makeAsset({ fps: 60 })).fps).toBe(30)
  })

  it('does not move when the source rate is unknown', () => {
    expect(adoptFrameRate(empty(), makeAsset({ fps: undefined })).fps).toBe(30)
  })

  it('audio and stills never set the rate', () => {
    expect(adoptFrameRate(empty(), makeAsset({ kind: 'audio', fps: 60 })).fps).toBe(30)
    expect(adoptFrameRate(empty(), makeAsset({ kind: 'image', fps: 60 })).fps).toBe(30)
  })

  it('hands back the SAME sequence when nothing changes, so no edit is recorded', () => {
    const seq = empty()
    expect(adoptFrameRate(seq, makeAsset({ fps: 30 }))).toBe(seq)
    expect(adoptFrameRate(seq, makeAsset({ kind: 'audio' }))).toBe(seq)
  })

  it('reaches the timeline through the real add paths', () => {
    const seq = empty()
    const vTrack = seq.tracks[0]
    const aTrack = seq.tracks[1]
    expect(addClipFromAsset(seq, vTrack.id, makeAsset({ fps: 50 }), 0).seq.fps).toBe(50)
    expect(
      addClipWithLinkedAudio(seq, vTrack.id, aTrack.id, makeAsset({ fps: 59.94 }), 0).seq.fps,
    ).toBe(59.94)
  })
})
