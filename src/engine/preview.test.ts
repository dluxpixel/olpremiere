// Pure window math for the transition pre-roll (preview.ts). The impure parts
// (pooled elements, GL, the frame cache runtime) need a browser; the pair
// windows and pre-roll horizon are plain data and are pinned here. They must
// mirror resolve.ts's pair-transition rules exactly.

import { describe, expect, it } from 'vitest'
import { TRANSITION_PRE_ROLL_S, pairTransitionWindow, transitionWindowsNear } from './preview'
import type { Clip, Sequence, Track } from './types'

const clip = (o: Partial<Clip> & Pick<Clip, 'id' | 'assetId' | 'startS' | 'inS' | 'outS'>): Clip => ({
  speed: 1,
  enabled: true,
  transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0, anchorY: 0, crop: { t: 0, r: 0, b: 0, l: 0 } },
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...o,
})

const track = (clips: Clip[], o: Partial<Track> = {}): Track => ({
  id: 'T1',
  kind: 'video',
  name: 'V1',
  height: 48,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
  ...o,
})

const seq = (tracks: Track[], fps = 30): Sequence => ({
  id: 'S1',
  name: 'Seq',
  fps,
  width: 1080,
  height: 1920,
  sampleRate: 48000,
  durationS: 0,
  tracks,
  markers: [],
})

// A [0,2) out of source 0..2, B [2,4) out of source 5..7, same or different asset.
const a = clip({ id: 'a', assetId: 'x', startS: 0, inS: 0, outS: 2 })
const b = clip({
  id: 'b',
  assetId: 'x',
  startS: 2,
  inS: 5,
  outS: 7,
  transitionIn: { type: 'crossDissolve', durationS: 0.5 },
})

describe('pairTransitionWindow', () => {
  it('builds the window at the incoming head with outgoing source times past the cut', () => {
    const w = pairTransitionWindow(a, b, 30)
    expect(w).toEqual({
      startS: 2,
      endS: 2.5,
      fromAssetId: 'x',
      toAssetId: 'x',
      fromSourceStartS: 2, // a.inS + 2s: the cut, then past a.outS into handle media
      fromSourceEndS: 2.5,
      toSourceStartS: 5,
    })
  })

  it("B's transitionIn wins over A's transitionOut (resolver rule)", () => {
    const a2 = { ...a, transitionOut: { type: 'wipeLeft', durationS: 1 } }
    expect(pairTransitionWindow(a2, b, 30)?.endS).toBe(2.5) // B's 0.5 governs
    const bPlain = { ...b, transitionIn: undefined }
    expect(pairTransitionWindow(a2, bPlain, 30)?.endS).toBe(3) // falls back to A's 1s
  })

  it('clamps the duration to the shorter clip and floors it at one frame', () => {
    const long = { ...b, transitionIn: { type: 'crossDissolve', durationS: 99 } }
    expect(pairTransitionWindow(a, long, 30)?.endS).toBe(4) // min(durA, durB) = 2
    const zero = { ...b, transitionIn: { type: 'crossDissolve', durationS: 0 } }
    expect(pairTransitionWindow(a, zero, 30)?.endS).toBeCloseTo(2 + 1 / 30, 10)
  })

  it('returns null without adjacency, without a transition, or with a disabled/adjustment side', () => {
    expect(pairTransitionWindow(a, { ...b, startS: 2.1 }, 30)).toBeNull()
    expect(pairTransitionWindow(a, { ...b, transitionIn: undefined }, 30)).toBeNull()
    expect(pairTransitionWindow({ ...a, enabled: false }, b, 30)).toBeNull()
    expect(pairTransitionWindow({ ...a, adjustment: true }, b, 30)).toBeNull()
  })

  it('walks a reversed outgoing clip backward through the source', () => {
    const rev = clip({ id: 'r', assetId: 'x', startS: 0, inS: 0, outS: 2, speed: -1 })
    const w = pairTransitionWindow(rev, b, 30)
    expect(w?.fromSourceStartS).toBe(0) // outS - 2s of play
    expect(w?.fromSourceEndS).toBe(-0.5) // past the head; prefetch clamps at 0
  })

  it('respects |speed| on the outgoing source mapping and reverse on the incoming start', () => {
    const fast = clip({ id: 'f', assetId: 'x', startS: 0, inS: 0, outS: 4, speed: 2 }) // 2s on timeline
    const w = pairTransitionWindow(fast, b, 30)
    expect(w?.fromSourceStartS).toBe(4)
    expect(w?.fromSourceEndS).toBe(5) // 0.5s window at 2x
    const revIn = { ...b, speed: -1 }
    expect(pairTransitionWindow(a, revIn, 30)?.toSourceStartS).toBe(7) // reversed B starts at outS
  })
})

describe('transitionWindowsNear', () => {
  const s = seq([track([a, b])])

  it('sees a window once the playhead is within the pre-roll horizon', () => {
    expect(transitionWindowsNear(s, 2 - TRANSITION_PRE_ROLL_S - 0.1)).toHaveLength(0)
    expect(transitionWindowsNear(s, 2 - TRANSITION_PRE_ROLL_S + 0.01)).toHaveLength(1)
  })

  it('keeps the window while the playhead is inside it and drops it after', () => {
    expect(transitionWindowsNear(s, 2.3)).toHaveLength(1)
    expect(transitionWindowsNear(s, 2.5)).toHaveLength(0)
    expect(transitionWindowsNear(s, 2.6)).toHaveLength(0)
  })

  it('collects several short-clip windows inside one pre-roll', () => {
    const c0 = clip({ id: 'c0', assetId: 'x', startS: 0, inS: 0, outS: 0.4 })
    const c1 = clip({
      id: 'c1', assetId: 'x', startS: 0.4, inS: 1, outS: 1.4,
      transitionIn: { type: 'crossDissolve', durationS: 0.2 },
    })
    const c2 = clip({
      id: 'c2', assetId: 'x', startS: 0.8, inS: 2, outS: 2.4,
      transitionIn: { type: 'crossDissolve', durationS: 0.2 },
    })
    const windows = transitionWindowsNear(seq([track([c0, c1, c2])]), 0)
    expect(windows.map((w) => w.startS)).toEqual([0.4, 0.8])
  })

  it('ignores muted and audio tracks', () => {
    expect(transitionWindowsNear(seq([track([a, b], { muted: true })]), 2.1)).toHaveLength(0)
    expect(transitionWindowsNear(seq([track([a, b], { kind: 'audio' })]), 2.1)).toHaveLength(0)
  })

  it('is empty on an empty or single-clip track', () => {
    expect(transitionWindowsNear(seq([track([])]), 0)).toHaveLength(0)
    expect(transitionWindowsNear(seq([track([a])]), 0)).toHaveLength(0)
  })
})
