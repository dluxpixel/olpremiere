// The timeline's transition marks. THE BUG these pin: a pair transition is
// stored on ONE clip, and the timeline drew it on that clip only, so the clip
// on the other side of the cut showed nothing while it was visibly dissolving.
// Both sides now read the renderer's own window, so neither side can advertise
// a length that will not play.

import { describe, expect, it } from 'vitest'
import { transitionMarkPx, transitionMarkSpans } from './transitionMarks'
import type { Clip } from './types'

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

const FPS = 30
// Two touching 2 s clips: A runs [0, 2), B runs [2, 4).
const a = clip({ id: 'a', assetId: 'x', startS: 0, inS: 0, outS: 2 })
const b = clip({ id: 'b', assetId: 'y', startS: 2, inS: 5, outS: 7 })

describe('transitionMarkSpans', () => {
  it('THE BUG: a transition owned by the OUTGOING clip marks the incoming clip too', () => {
    const aOut = { ...a, transitionOut: { type: 'crossDissolve', durationS: 0.5 } }
    // The owner keeps its tail mark, exactly as before.
    expect(transitionMarkSpans(aOut, undefined, b, FPS)).toEqual({ headS: 0, tailS: 0.5 })
    // ...and B, which owns nothing, now reports the 0.5 s of its own head that
    // the renderer really spends dissolving. It used to report 0.
    expect(transitionMarkSpans(b, aOut, undefined, FPS)).toEqual({ headS: 0.5, tailS: 0 })
  })

  it('marks both sides when the INCOMING clip owns the transition', () => {
    const bIn = { ...b, transitionIn: { type: 'crossDissolve', durationS: 0.75 } }
    expect(transitionMarkSpans(a, undefined, bIn, FPS).tailS).toBe(0.75)
    expect(transitionMarkSpans(bIn, a, undefined, FPS).headS).toBe(0.75)
  })

  it("both sides agree on ONE length when both fields are set: B's transitionIn wins", () => {
    const aOut = { ...a, transitionOut: { type: 'wipeLeft', durationS: 1 } }
    const bIn = { ...b, transitionIn: { type: 'crossDissolve', durationS: 0.5 } }
    // Not 1 s on A and 0.5 s on B: the resolver plays B's 0.5 s, so that is
    // what both marks say.
    expect(transitionMarkSpans(aOut, undefined, bIn, FPS).tailS).toBe(0.5)
    expect(transitionMarkSpans(bIn, aOut, undefined, FPS).headS).toBe(0.5)
  })

  it('clamps a pair to the SHORTER clip, not to the duration the user typed', () => {
    const long = clip({ id: 'L', assetId: 'x', startS: 0, inS: 0, outS: 5 })
    const shortIn = clip({ id: 'S', assetId: 'y', startS: 5, inS: 0, outS: 0.6 })
    const longOut = { ...long, transitionOut: { type: 'crossDissolve', durationS: 2 } }
    // min(5, 0.6) governs, so a 2 s dissolve really runs 0.6 s and neither mark
    // may claim 2 s.
    expect(transitionMarkSpans(longOut, undefined, shortIn, FPS).tailS).toBeCloseTo(0.6, 10)
    expect(transitionMarkSpans(shortIn, longOut, undefined, FPS).headS).toBeCloseTo(0.6, 10)
  })

  it('floors a pair at one frame', () => {
    const aOut = { ...a, transitionOut: { type: 'crossDissolve', durationS: 0 } }
    expect(transitionMarkSpans(b, aOut, undefined, FPS).headS).toBeCloseTo(1 / FPS, 10)
  })

  it('falls back to the lone-edge window across a gap, and marks only the owner', () => {
    const aOut = { ...a, transitionOut: { type: 'crossDissolve', durationS: 0.5 } }
    const gapped = { ...b, startS: 2.1 }
    // No pair forms, so this runs inside A against emptiness...
    expect(transitionMarkSpans(aOut, undefined, gapped, FPS).tailS).toBe(0.5)
    // ...and nothing crosses into the clip after the gap.
    expect(transitionMarkSpans(gapped, aOut, undefined, FPS).headS).toBe(0)
  })

  it('clamps a lone edge to the clip it lives in', () => {
    const aOut = { ...a, transitionOut: { type: 'crossDissolve', durationS: 99 } }
    expect(transitionMarkSpans(aOut, undefined, undefined, FPS).tailS).toBe(2)
    const aBoth = { ...aOut, transitionIn: { type: 'glitch', durationS: 0.25 } }
    expect(transitionMarkSpans(aBoth, undefined, undefined, FPS)).toEqual({ headS: 0.25, tailS: 2 })
  })

  it('forms no pair against a disabled or adjustment neighbour', () => {
    const aOut = { ...a, transitionOut: { type: 'crossDissolve', durationS: 0.5 } }
    for (const neighbour of [{ ...b, enabled: false }, { ...b, adjustment: true }]) {
      // The owner keeps its lone-edge mark, the neighbour gets nothing: the
      // renderer takes the same fallback.
      expect(transitionMarkSpans(aOut, undefined, neighbour, FPS).tailS).toBe(0.5)
      expect(transitionMarkSpans(neighbour, aOut, undefined, FPS).headS).toBe(0)
    }
  })

  it('reports nothing on a plain cut', () => {
    expect(transitionMarkSpans(a, undefined, b, FPS)).toEqual({ headS: 0, tailS: 0 })
    expect(transitionMarkSpans(b, a, undefined, FPS)).toEqual({ headS: 0, tailS: 0 })
  })
})

describe('transitionMarkPx', () => {
  it('caps each mark at half its OWN clip, so one transition can draw two widths', () => {
    // The 0.6 s pair above at 100 px/s: the 5 s outgoing clip has room for the
    // whole 60 px, the 0.6 s incoming clip is capped at its own half, 30 px.
    expect(transitionMarkPx({ headS: 0, tailS: 0.6 }, 100, 500)).toEqual({ headPx: 0, tailPx: 60 })
    expect(transitionMarkPx({ headS: 0.6, tailS: 0 }, 100, 60)).toEqual({ headPx: 30, tailPx: 0 })
  })

  it('keeps two marks on one short clip from crossing', () => {
    const px = transitionMarkPx({ headS: 1, tailS: 1 }, 100, 100)
    expect(px).toEqual({ headPx: 50, tailPx: 50 })
  })

  it('draws nothing for empty spans', () => {
    expect(transitionMarkPx({ headS: 0, tailS: 0 }, 100, 500)).toEqual({ headPx: 0, tailPx: 0 })
  })
})
