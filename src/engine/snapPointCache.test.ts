import { describe, expect, it } from 'vitest'
import { createSnapPointCache } from './snapPointCache'
import { collectSnapPoints, recomputeDuration } from './timeline'
import { defaultTransform, type Clip, type Sequence, type Track } from './types'

let n = 0
const uid = (p: string) => `${p}${++n}`

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

const busySeq = () => {
  const dragged = makeClip({ startS: 4, outS: 2 })
  const others = Array.from({ length: 40 }, (_, i) => makeClip({ startS: 10 + i * 3, outS: 2 }))
  return { seq: makeSeq([makeTrack({ clips: [dragged, ...others] })]), draggedId: dragged.id }
}

describe('the snap point cache', () => {
  it('returns exactly what collectSnapPoints returns, sort and all', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    expect(cache.points(seq, [draggedId], 7)).toEqual(
      collectSnapPoints(seq, { excludeClipIds: [draggedId], playheadS: 7 }),
    )
  })

  it('asks for the same answer with no seed and gets the unexcluded list', () => {
    const { seq } = busySeq()
    const cache = createSnapPointCache()

    expect(cache.points(seq, [], 7)).toEqual(collectSnapPoints(seq, { playheadS: 7 }))
  })

  // The point of the whole file. One drag fires hundreds of pointermoves and
  // every one of them used to walk every clip on every track and sort the
  // result. Without the cache this reads 200.
  it('walks the sequence ONCE across a whole drag, not once per pointer move', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    for (let i = 0; i < 200; i++) cache.points(seq, [draggedId], 7)

    expect(cache.computations()).toBe(1)
  })

  it('hands back the identical array, so callers cannot see the difference', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    expect(cache.points(seq, [draggedId], 7)).toBe(cache.points(seq, [draggedId], 7))
  })

  // The three things that genuinely invalidate it. Each must recompute, or a
  // drag would snap against a stale timeline, which is far worse than slow.
  it('recomputes when the playhead moves, because the playhead is a snap point', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    cache.points(seq, [draggedId], 7)
    const moved = cache.points(seq, [draggedId], 9)

    expect(cache.computations()).toBe(2)
    expect(moved).toContain(9)
    expect(moved).not.toContain(7)
  })

  it('recomputes when a different clip is dragged', () => {
    const { seq, draggedId } = busySeq()
    const other = seq.tracks[0].clips[3].id
    const cache = createSnapPointCache()

    cache.points(seq, [draggedId], 7)
    cache.points(seq, [other], 7)

    expect(cache.computations()).toBe(2)
    expect(cache.points(seq, [other], 7)).toEqual(
      collectSnapPoints(seq, { excludeClipIds: [other], playheadS: 7 }),
    )
  })

  it('recomputes when the sequence itself changes', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    cache.points(seq, [draggedId], 7)
    const edited = makeSeq([makeTrack({ clips: [...seq.tracks[0].clips, makeClip({ startS: 99 })] })])
    const after = cache.points(edited, [draggedId], 7)

    expect(cache.computations()).toBe(2)
    expect(after).toContain(99)
  })

  it('starts cold again after a reset', () => {
    const { seq, draggedId } = busySeq()
    const cache = createSnapPointCache()

    cache.points(seq, [draggedId], 7)
    cache.reset()
    cache.points(seq, [draggedId], 7)

    expect(cache.computations()).toBe(2)
  })
})
