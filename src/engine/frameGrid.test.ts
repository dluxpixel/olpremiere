// Edits stay on the frame grid, and a cut on the grid counts frames, 2026-10-03.
//
// His "strong until" project had every edit after a 2.5x clip sitting between
// two frames, and C refused the frame either side of each one without a word
// (src/state/cutOffGrid.test.ts drives that through the real key). This file
// pins the two halves of the fix in the engine: what a cut on the grid asks of
// a piece (canSplitClipAt), and every way in that used to leave an edge off the
// grid (a file's own length, a pasted picture at a paused playhead, a new speed,
// an edge dragged to the end of its media).

import { describe, expect, it } from 'vitest'
import {
  addClipFromAsset,
  addClipWithLinkedAudio,
  canSplitClipAt,
  clipDurationS,
  clipEndS,
  framesShown,
  recomputeDuration,
  rippleTrimTo,
  rollEditTo,
  setClipSpeed,
  splitClip,
  trimClipTo,
} from './timeline'
import { defaultTransform, type Clip, type MediaAsset, type Sequence, type Track } from './types'

const FPS = 30
const frameOf = (tS: number): number => tS * FPS
const onGrid = (tS: number): boolean => Math.abs(frameOf(tS) - Math.round(frameOf(tS))) < 1e-6

let n = 0
const clip = (over: Partial<Clip> = {}): Clip => ({
  id: `c${++n}`,
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
const track = (over: Partial<Track> = {}): Track => ({
  id: `t${++n}`,
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
const seqOf = (tracks: Track[]): Sequence =>
  recomputeDuration({ id: 's', name: 'S', fps: FPS, width: 1080, height: 1920, sampleRate: 48000, durationS: 0, tracks, markers: [] })
const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'av',
  name: 'a.mp4',
  kind: 'video',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: true,
  fps: 30,
  ...over,
})

describe('canSplitClipAt: a cut on the grid needs a frame each side, not 1/30 s', () => {
  it('a clip on the grid gets exactly the answer it always got', () => {
    const c = clip({ startS: 1, outS: 2 }) // frames 30 to 90
    for (let f = 25; f <= 95; f++) {
      const t = f / FPS
      const old = t >= c.startS + 1 / FPS && t <= clipEndS(c) - 1 / FPS
      expect(canSplitClipAt(c, FPS, t)).toBe(old)
    }
  })

  it('the frame before an off-grid end cuts: the right piece starts on the frame it shows', () => {
    // His rec3: 144.54 to 189.54. Frame 189 is the last frame it shows.
    const c = clip({ startS: 144.54 / FPS, inS: 19.370666666667056, outS: 22.370666666667056, speed: 2 })
    expect(framesShown(189 / FPS, clipEndS(c), FPS)).toBe(1)
    expect(canSplitClipAt(c, FPS, 189 / FPS)).toBe(true)
    const cut = splitClip(seqOf([track({ clips: [c] })]), c.id, 189 / FPS)
    expect(cut.tracks[0]!.clips).toHaveLength(2)
  })

  it('the frame after an off-grid start is the clip\'s first frame: nothing to cut there', () => {
    const c = clip({ startS: 189.54 / FPS, outS: 3 })
    expect(framesShown(c.startS, 190 / FPS, FPS)).toBe(0)
    expect(canSplitClipAt(c, FPS, 190 / FPS)).toBe(false)
    expect(canSplitClipAt(c, FPS, 191 / FPS)).toBe(true)
  })

  it('a cut OFF the grid (a word, a silence edge) keeps the length rule against slivers', () => {
    const c = clip({ startS: 0, outS: 4 })
    expect(canSplitClipAt(c, FPS, 0.001)).toBe(false)
    expect(canSplitClipAt(c, FPS, 0.02)).toBe(false)
    expect(canSplitClipAt(c, FPS, 1.2345)).toBe(true)
  })
})

describe('a clip placed from his media lands on the grid', () => {
  // His OBS recording: 33.083333 s at 60 fps, frame 992.5 of his 30 fps edit.
  const obs = asset({ id: 'rec', durationS: 33.083333, fps: 60 })
  // His edit already had clips, so its rate stays 30 (adoptFrameRate only
  // listens to the first video onto an EMPTY timeline).
  const editWith = (...tracks: Track[]): Sequence => seqOf([...tracks, track({ clips: [clip({ startS: 100 })] })])

  it('a file whose length is not whole frames ends on its last whole frame', () => {
    const s = editWith(track())
    const { seq, clipId } = addClipFromAsset(s, s.tracks[0]!.id, obs, 4)
    const c = seq.tracks[0]!.clips.find((x) => x.id === clipId)!
    expect(c.startS).toBe(4)
    expect(frameOf(clipEndS(c))).toBeCloseTo(120 + 992, 6)
    expect(c.outS).toBeLessThanOrEqual(obs.durationS)
  })

  it('a picture pasted at a playhead that rests between frames starts on a frame', () => {
    // A paused playhead sits wherever the transport stopped.
    const s = editWith(track())
    const pic = asset({ id: 'pic', kind: 'image', durationS: 0, hasAudio: false })
    const { seq, clipId } = addClipFromAsset(s, s.tracks[0]!.id, pic, 6.3187, { exact: true })
    const c = seq.tracks[0]!.clips.find((x) => x.id === clipId)!
    expect(frameOf(c.startS)).toBeCloseTo(190, 9)
    expect(clipDurationS(c)).toBe(5)
  })

  it('a clip added after one that ends between frames starts on the next frame', () => {
    // Flush against an off-grid end is where resolveStart lands it.
    const before = clip({ startS: 0, outS: 97.98 / FPS })
    const s = editWith(track({ clips: [before] }))
    const { seq, clipId } = addClipFromAsset(s, s.tracks[0]!.id, obs, 2)
    const c = seq.tracks[0]!.clips.find((x) => x.id === clipId)!
    expect(onGrid(c.startS)).toBe(true)
    expect(onGrid(clipEndS(c))).toBe(true)
  })

  it('a video with its sound: both halves start on a frame and run the same whole frames', () => {
    const s = editWith(track(), track({ kind: 'audio', name: 'A1' }))
    const { seq, videoClipId, audioClipId } = addClipWithLinkedAudio(s, s.tracks[0]!.id, s.tracks[1]!.id, obs, 1.01)
    const v = seq.tracks[0]!.clips.find((x) => x.id === videoClipId)!
    const a = seq.tracks[1]!.clips.find((x) => x.id === audioClipId)!
    for (const c of [v, a]) {
      expect(onGrid(c.startS)).toBe(true)
      expect(onGrid(clipEndS(c))).toBe(true)
    }
    expect(v.outS).toBe(a.outS)
    expect(v.startS).toBe(a.startS)
  })
})

describe('a new speed keeps the clip whole frames long', () => {
  it('his IMG_3080 at 2.5x ends on a frame, and so does everything it pushes', () => {
    // 15.8033 s of source at 2.5x is 189.64 frames.
    const img = clip({ id: 'img', startS: 0, inS: 5.8, outS: 21.603333 })
    const after = clip({ id: 'after', startS: 15.8033 + 1, outS: 2 })
    const s = setClipSpeed(seqOf([track({ clips: [img, after] })]), 'img', 2.5)
    const c = s.tracks[0]!.clips.find((x) => x.id === 'img')!
    expect(frameOf(clipEndS(c))).toBeCloseTo(189, 6)
    expect(c.outS).toBeLessThanOrEqual(21.603333)
    // Slowing down pushes what follows by whole frames too.
    const slow = setClipSpeed(seqOf([track({ clips: [clip({ id: 'x', startS: 0, outS: 1.01 }), clip({ id: 'y', startS: 1.01, outS: 1 })] })]), 'x', 0.7)
    const x = slow.tracks[0]!.clips.find((c2) => c2.id === 'x')!
    expect(onGrid(clipEndS(x))).toBe(true)
  })

  it('a reversed clip gives up the part frame at its tail, the start of its source', () => {
    const r = clip({ id: 'r', startS: 0, inS: 1, outS: 9, speed: -1 })
    const s = setClipSpeed(seqOf([track({ clips: [r] })]), 'r', -2.5)
    const c = s.tracks[0]!.clips[0]!
    expect(c.outS).toBe(9)
    expect(onGrid(clipEndS(c))).toBe(true)
  })
})

describe('an edge stopped by the end of its media stops on a frame', () => {
  // 10.0167 s of media: frame 300.5.
  const media = { av: asset({ durationS: 10.0167 }) }

  it('trim: dragging the tail past the end lands on the last whole frame', () => {
    const c = clip({ startS: 0, outS: 5 })
    const s = trimClipTo(seqOf([track({ clips: [c] })]), media, c.id, 'out', 20)
    const t = s.tracks[0]!.clips[0]!
    expect(frameOf(clipEndS(t))).toBeCloseTo(300, 6)
  })

  it('trim: dragging the head past the start of the source lands on a frame', () => {
    // inS 0.5 at 2.5x is 0.2 s of head room: from frame 62 that reaches 56.
    // At 0.505 it reaches 55.94, which the old clamp landed on.
    const c = clip({ startS: 62 / FPS, inS: 0.505, outS: 5, speed: 2.5 })
    const s = trimClipTo(seqOf([track({ clips: [c] })]), media, c.id, 'in', 0)
    expect(frameOf(s.tracks[0]!.clips[0]!.startS)).toBeCloseTo(56, 6)
  })

  it('a clip already off the grid can still be pulled out as far as it reaches', () => {
    const c = clip({ startS: 1.46 / FPS, inS: 0, outS: 5 })
    const s = trimClipTo(seqOf([track({ clips: [c] })]), media, c.id, 'in', 0)
    expect(s.tracks[0]!.clips[0]!.startS).toBe(c.startS)
  })

  it('ripple: the tail to the end of the media moves what follows by whole frames', () => {
    const c = clip({ id: 'c', startS: 0, outS: 5 })
    const next = clip({ id: 'next', startS: 5, outS: 2 })
    const s = rippleTrimTo(seqOf([track({ clips: [c, next] })]), media, 'c', 'out', 20)
    expect(onGrid(s.tracks[0]!.clips.find((x) => x.id === 'next')!.startS)).toBe(true)
  })

  it('roll: a cut rolled to the end of the left clip\'s media stops on a frame', () => {
    const left = clip({ id: 'l', startS: 0, outS: 5 })
    const right = clip({ id: 'r', startS: 5, inS: 0, outS: 10, assetId: 'big' })
    const assets = { ...media, big: asset({ id: 'big', durationS: 60 }) }
    const s = rollEditTo(seqOf([track({ clips: [left, right] })]), assets, 'l', 'r', 12)
    expect(onGrid(s.tracks[0]!.clips.find((x) => x.id === 'r')!.startS)).toBe(true)
  })
})
