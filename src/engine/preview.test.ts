// Pure window math for the transition pre-roll (preview.ts). The impure parts
// (pooled elements, GL, the frame cache runtime) need a browser; the pair
// windows and pre-roll horizon are plain data and are pinned here. They must
// mirror resolve.ts's pair-transition rules exactly.

import { describe, expect, it } from 'vitest'
import {
  TRANSITION_PRE_ROLL_S,
  pairTransitionWindow,
  transitionWindowsNear,
  upcomingCutHeads,
  liveUploadCap,
  assetIdOfKey,
  incomingNeedsOwnElement,
  videoPoolKeyFor,
  TO_SIDE_SUFFIX,
} from './preview'
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
      fromClipId: 'a',
      toClipId: 'b',
      fromSourceStartS: 2, // a.inS + 2s: the cut, then past a.outS into handle media
      fromSourceEndS: 2.5,
      toSourceStartS: 5,
      toSourceEndS: 5.5,
    })
  })

  // BOTH sides are named, and per CLIP rather than per asset. A razored take is
  // one asset in two clips (the fixture above is exactly that: both are 'x'),
  // so an asset-keyed hold would hand the outgoing side the incoming side's
  // frame. The clip ids are what keep the two apart.
  it('names both clips, which is what a razored one-asset pair needs', () => {
    const w = pairTransitionWindow(a, b, 30)
    expect(w?.fromAssetId).toBe(w?.toAssetId)
    expect(w?.fromClipId).not.toBe(w?.toClipId)
  })

  // The incoming side gets an END time so its window can be decoded ahead, the
  // way the outgoing side always has been. Without it there is nothing to
  // prefetch and the first frames of every dissolve depend on a seek landing.
  it('maps the incoming source window, including |speed| and reverse', () => {
    const fastIn = { ...b, speed: 2 }
    const w = pairTransitionWindow(a, fastIn, 30)
    expect(w?.toSourceStartS).toBe(5)
    expect(w?.toSourceEndS).toBe(6) // 0.5s window at 2x
    const revIn = { ...b, speed: -1 }
    const r = pairTransitionWindow(a, revIn, 30)
    expect(r?.toSourceStartS).toBe(7) // reversed B starts at outS
    expect(r?.toSourceEndS).toBe(6.5) // and walks backward
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

describe('upcomingCutHeads', () => {
  // A PLAIN cut: two touching clips with no transition between them.
  const p0 = clip({ id: 'p0', assetId: 'x', startS: 0, inS: 0, outS: 2 })
  const p1 = clip({ id: 'p1', assetId: 'y', startS: 2, inS: 5, outS: 7 })
  const plain = seq([track([p0, p1])])

  it('THE BUG: a plain cut has no transition window, so only this sees it coming', () => {
    // transitionWindowsNear is blind here, because pairTransitionWindow returns
    // null without a transition. That is why the incoming element used to be
    // created cold AT the cut and the frame came out black.
    expect(transitionWindowsNear(plain, 1.5)).toHaveLength(0)
    expect(upcomingCutHeads(plain, 1.5).map((c) => c.id)).toEqual(['p1'])
  })

  it('only inside the pre-roll horizon, and never the clip already playing', () => {
    expect(upcomingCutHeads(plain, 2 - TRANSITION_PRE_ROLL_S - 0.1)).toHaveLength(0)
    expect(upcomingCutHeads(plain, 2 - TRANSITION_PRE_ROLL_S + 0.01).map((c) => c.id)).toEqual(['p1'])
    // At and past the cut, p1 is the one on screen, so there is nothing to warm.
    expect(upcomingCutHeads(plain, 2)).toHaveLength(0)
    expect(upcomingCutHeads(plain, 2.5)).toHaveLength(0)
  })

  it('collects EVERY head inside one horizon, which is the cut-dense case', () => {
    const many = seq([
      track(
        Array.from({ length: 8 }, (_, i) =>
          clip({ id: `k${i}`, assetId: `a${i}`, startS: i * 0.25, inS: 0, outS: 0.25 }),
        ),
      ),
    ])
    // Quarter-second cuts: several elements must be warm before the playhead
    // reaches them, which is exactly what the 12-element pool cap starved.
    expect(upcomingCutHeads(many, 0.1).length).toBeGreaterThan(3)
  })

  it('ignores disabled clips, adjustment layers, muted and non-video tracks', () => {
    const off = clip({ id: 'off', assetId: 'y', startS: 2, inS: 0, outS: 1, enabled: false })
    expect(upcomingCutHeads(seq([track([p0, off])]), 1.5)).toHaveLength(0)

    const adj = clip({ id: 'adj', assetId: 'y', startS: 2, inS: 0, outS: 1, adjustment: true })
    expect(upcomingCutHeads(seq([track([p0, adj])]), 1.5)).toHaveLength(0)

    expect(upcomingCutHeads(seq([track([p0, p1], { muted: true })]), 1.5)).toHaveLength(0)
    expect(upcomingCutHeads(seq([track([p0, p1], { kind: 'audio' })]), 1.5)).toHaveLength(0)
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

describe('what the live preview actually uploads', () => {
  // PROFILED 2026-07-29: during playback `texSubImage2D` was 37% of every sample
  // taken while our own JavaScript was 1.3%. The preview was not slow because of
  // resolve or effects; it handed the renderer a full-size video frame to upload
  // sixty times a second. Measured end to end on a real 1080p clip: 26fps to
  // 29fps on one continuous clip, and 19fps to 28fps on a run of short cuts,
  // where gaps long enough to see went from about 50 per six seconds to 7.

  it('stops uploading 1080 lines into a 700 line monitor', () => {
    // THE case that was slow: a 1080p source sits exactly ON the Full-quality
    // 1080 cap, so the tier scaled nothing at all.
    expect(liveUploadCap(1080, undefined, 694)).toBe(694)
  })

  it('never upscales', () => {
    // A source smaller than the monitor is uploaded as it is; growing it would
    // cost more and show nothing new.
    expect(liveUploadCap(480, undefined, 1080)).toBeUndefined()
    expect(liveUploadCap(720, undefined, 720)).toBeUndefined()
  })

  it('follows the layer ZOOM, so a punch-in stays sharp', () => {
    // A clip scaled up by its own transform samples MORE than one texel per
    // screen pixel. The real scale is known, so no fixed margin has to be guessed:
    // a fixed 1.25 margin measured WORSE on both sharpness and speed, because it
    // put the picture through two resamples instead of one.
    expect(liveUploadCap(2160, undefined, 1000, 1)).toBe(1000)
    expect(liveUploadCap(2160, undefined, 1000, 2)).toBe(2000)
    // Zooming OUT never buys a smaller upload than the monitor: the layer is
    // still sampled across the same screen, just smaller.
    expect(liveUploadCap(2160, undefined, 1000, 0.5)).toBe(1000)
  })

  it('still obeys the quality tier when the tier is the smaller one', () => {
    // Half quality on 4K: the tier says 540, the monitor would allow more, and
    // the tier has to win or the picker would do nothing during playback.
    expect(liveUploadCap(2160, 540, 1080)).toBe(540)
  })

  it('falls back to the tier alone before anything has been drawn', () => {
    expect(liveUploadCap(2160, 1080, 0)).toBe(1080)
    expect(liveUploadCap(1080, undefined, 0)).toBeUndefined()
  })
})

// WHICH ELEMENT EACH SIDE OF A TRANSITION PLAYS ON.
//
// Razoring one take leaves two clips on ONE asset. They used to share ONE pooled
// <video>, and the outgoing clip owns it because it has been playing it into the
// cut, so the incoming side had nowhere to get a picture: no element, no
// prefetch (an asset has one decode queue), and no held frame either, because a
// held frame is banked by being drawn and it has not been on screen yet.
//
// MEASURED 2026-08-13: the incoming side drew NOTHING for 26 of 26 frames inside
// a two second window, the compositor correctly pinned the dissolve to the only
// side that had a picture, and on screen the fade simply did not happen. It
// failed about three runs in four. With its own element it passed 7 of 7,
// including three under deliberate load.
//
// e2e/transition-stale-frame.spec.ts is the standing proof in pixels. These pin
// the rule itself, so a refactor cannot quietly put the two sides back on one
// element and leave the pixels to notice months later.
describe('the element a transition side plays on', () => {
  const A = { clipId: 'a', assetId: 'take1' }
  const B = { clipId: 'b', assetId: 'take1' }
  const OTHER = { clipId: 'c', assetId: 'take2' }

  it('gives the incoming side its own element when both sides are one take', () => {
    expect(incomingNeedsOwnElement(A, B)).toBe(true)
    expect(videoPoolKeyFor(B.assetId, true)).not.toBe(videoPoolKeyFor(A.assetId, false))
  })

  it('leaves two different takes sharing nothing to fight over', () => {
    expect(incomingNeedsOwnElement(A, OTHER)).toBe(false)
    expect(videoPoolKeyFor(OTHER.assetId, false)).toBe(OTHER.assetId)
  })

  it('never splits a lone edge, whose two sides are the same clip', () => {
    // A transition on a clip with no neighbour uses that clip as its own other
    // side. There is no second clip, so there is nothing to give an element to,
    // and handing it one would break a transition that works.
    expect(incomingNeedsOwnElement(A, { clipId: 'a', assetId: 'take1' })).toBe(false)
  })

  it('can still name the asset a second element belongs to', () => {
    // disposePreviewAsset and the pause sweep both key by asset, so a pool key
    // that could not be read back would leak a decoder or pause a playing clip.
    const key = videoPoolKeyFor('take1', true)
    expect(key).toContain(TO_SIDE_SUFFIX)
    expect(assetIdOfKey(key)).toBe('take1')
    expect(assetIdOfKey('take1')).toBe('take1')
  })
})
