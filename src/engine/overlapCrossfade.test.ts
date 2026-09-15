// The Vegas gesture: drag an edge into the neighbour and the overlap is a
// crossfade. These pin the two directions, that a drag which stops short is
// the plain trim it always was, and the clamps the renderer would apply anyway.

import { describe, expect, it } from 'vitest'
import { overlapCrossfadeS, trimIntoNeighbour } from './overlapCrossfade'
import { findClip, recomputeDuration } from './timeline'
import { clipEndS, defaultTransform, type Clip, type MediaAsset, type Sequence, type Track } from './types'

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

const makeSeq = (tracks: Track[]): Sequence =>
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
  })

const AV: MediaAsset = { id: 'av', name: 'a.mp4', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const ASSETS = { av: AV }

/** A at 0 to 4 with media to spare on both sides, B right after it, also with spare media. */
function pair(): { seq: Sequence; a: Clip; b: Clip } {
  const a = makeClip({ startS: 0, inS: 1, outS: 5 }) // 4 s on the timeline, 5 s of media left after its out
  const b = makeClip({ startS: 4, inS: 3, outS: 7 }) // 4 s, 3 s of media before its in
  return { seq: makeSeq([makeTrack({ clips: [a, b] })]), a, b }
}

const clipOf = (seq: Sequence, id: string): Clip => findClip(seq, id)!.clip

describe('a drag that stops short of the neighbour', () => {
  it('is the plain trim, with no transition invented', () => {
    const { seq, a, b } = pair()
    const next = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 3)
    expect(clipEndS(clipOf(next, a.id))).toBe(3)
    expect(clipOf(next, b.id).transitionIn).toBeUndefined()
    expect(clipOf(next, a.id).transitionOut).toBeUndefined()
    expect(overlapCrossfadeS(seq, ASSETS, a.id, 'out', 3)).toBe(0)
  })

  it('parked exactly on the neighbour is still a plain trim', () => {
    const { seq, a } = pair()
    const short = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 3)
    const back = trimIntoNeighbour(short, ASSETS, a.id, 'out', 4)
    expect(clipEndS(clipOf(back, a.id))).toBe(4)
    expect(overlapCrossfadeS(short, ASSETS, a.id, 'out', 4)).toBe(0)
  })
})

describe("A's tail dragged into B", () => {
  it('leaves every clip where it was and gives the pair a dissolve the length of the overlap', () => {
    const { seq, a, b } = pair()
    const next = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 5)
    const na = clipOf(next, a.id)
    const nb = clipOf(next, b.id)
    expect(clipEndS(na)).toBe(4)
    expect(nb.startS).toBe(4)
    expect(nb.inS).toBe(3)
    expect(nb.transitionIn).toEqual({ type: 'crossDissolve', durationS: 1 })
    expect(overlapCrossfadeS(seq, ASSETS, a.id, 'out', 5)).toBe(1)
  })

  it("cannot dissolve longer than A has media past its out point", () => {
    const { seq, a, b } = pair()
    // A has 5 s of media after its out (asset 10 s, out at 5), and B is 4 s long.
    const next = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 20)
    expect(clipOf(next, b.id).transitionIn?.durationS).toBe(4)
  })

  it('keeps the kind of a transition the pair already had, and the field it lives in', () => {
    const { seq, a, b } = pair()
    const onA = {
      ...seq,
      tracks: [{ ...seq.tracks[0], clips: [{ ...a, transitionOut: { type: 'dipToBlack', durationS: 0.5 } }, b] }],
    }
    const next = trimIntoNeighbour(onA, ASSETS, a.id, 'out', 5.5)
    expect(clipOf(next, a.id).transitionOut).toEqual({ type: 'dipToBlack', durationS: 1.5 })
    expect(clipOf(next, b.id).transitionIn).toBeUndefined()
  })
})

describe("B's head dragged into A", () => {
  it('rolls the cut to where the edge went and dissolves over the rolled distance', () => {
    const { seq, a, b } = pair()
    const next = trimIntoNeighbour(seq, ASSETS, b.id, 'in', 3)
    const na = clipOf(next, a.id)
    const nb = clipOf(next, b.id)
    // A gives up its last second, B shows one second of earlier frames.
    expect(clipEndS(na)).toBe(3)
    expect(na.outS).toBe(4)
    expect(nb.startS).toBe(3)
    expect(nb.inS).toBe(2)
    expect(clipEndS(nb)).toBe(8)
    expect(nb.transitionIn).toEqual({ type: 'crossDissolve', durationS: 1 })
    expect(overlapCrossfadeS(seq, ASSETS, b.id, 'in', 3)).toBe(1)
  })

  it('stops where B runs out of earlier media', () => {
    const { seq, a, b } = pair()
    // B has 3 s of media before its in point, so the cut can roll to 1 at most.
    const next = trimIntoNeighbour(seq, ASSETS, b.id, 'in', -5)
    expect(clipOf(next, b.id).startS).toBe(1)
    expect(clipOf(next, b.id).inS).toBe(0)
    expect(clipEndS(clipOf(next, a.id))).toBe(1)
    expect(clipOf(next, b.id).transitionIn?.durationS).toBe(1)
  })

  it('never dissolves longer than the shorter clip', () => {
    const a = makeClip({ startS: 0, inS: 0, outS: 5 })
    const b = makeClip({ startS: 5, inS: 4, outS: 5 }) // one second long
    const seq = makeSeq([makeTrack({ clips: [a, b] })])
    const next = trimIntoNeighbour(seq, ASSETS, b.id, 'in', 2)
    const nb = clipOf(next, b.id)
    // The roll makes B 4 s long and A 2 s long: the dissolve is A's whole 2 s at most.
    expect(nb.transitionIn?.durationS).toBe(2)
  })
})

describe('what never gets a crossfade', () => {
  it('a hair of overlap from a wobble of the hand', () => {
    const { seq, a, b } = pair()
    const next = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 4.02)
    expect(clipOf(next, b.id).transitionIn).toBeUndefined()
  })

  it('a pair the renderer would never play: a disabled or adjustment neighbour', () => {
    const { seq, a, b } = pair()
    const off = { ...seq, tracks: [{ ...seq.tracks[0], clips: [a, { ...b, enabled: false }] }] }
    expect(clipOf(trimIntoNeighbour(off, ASSETS, a.id, 'out', 5), b.id).transitionIn).toBeUndefined()
    const adj = { ...seq, tracks: [{ ...seq.tracks[0], clips: [{ ...a, adjustment: true }, b] }] }
    expect(clipOf(trimIntoNeighbour(adj, ASSETS, b.id, 'in', 3), b.id).transitionIn).toBeUndefined()
    expect(clipOf(trimIntoNeighbour(adj, ASSETS, b.id, 'in', 3), b.id).startS).toBe(4)
  })

  it('an edge with no neighbour on that side', () => {
    const { seq, a, b } = pair()
    expect(clipEndS(clipOf(trimIntoNeighbour(seq, ASSETS, b.id, 'out', 9), b.id))).toBe(9)
    expect(overlapCrossfadeS(seq, ASSETS, a.id, 'in', -1)).toBe(0)
  })
})

describe('on an audio track', () => {
  it('the overlap sets the two fade handles instead, the way this app crossfades audio', () => {
    const a = makeClip({ startS: 0, inS: 1, outS: 5 })
    const b = makeClip({ startS: 4, inS: 3, outS: 7 })
    const seq = makeSeq([makeTrack({ kind: 'audio', name: 'A1', clips: [a, b] })])
    const next = trimIntoNeighbour(seq, ASSETS, a.id, 'out', 5)
    expect(clipOf(next, a.id).fadeOutS).toBe(1)
    expect(clipOf(next, b.id).fadeInS).toBe(1)
    expect(clipOf(next, b.id).transitionIn).toBeUndefined()
  })
})
