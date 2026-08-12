import { describe, expect, it } from 'vitest'
import { progressWithSides } from './glRenderer'

// A CROSS DISSOLVE FADED TO BLACK IN HIS SHIP GATE, 2026-08-12, and the reason
// was not the dissolve. Both sides of a live pair transition are composited
// premultiplied, so `mix(from, to, p)` against a side with NO TEXTURE scales the
// picture we do have by (1-p). The gate read rgb(0,29,0) decaying to (0,11,0)
// while the incoming clip was still cold.
//
// preview.ts already refuses to composite a side that cannot prove it is showing
// its own frame, and serves the last confident frame instead. This is the case
// where there is no last confident frame yet: nothing to hold, so the side is
// null, so the other side gets weighted toward nothing.
//
// The old line was `clamp01(op.progress)`, which is what every case below is
// measured against: with the outgoing side present and the incoming side
// missing, it asked for the caller's own progress and got a picture fading out.
const OLD = (p: number): number => (p < 0 ? 0 : p > 1 ? 1 : p)

const PAIR = true
const LONE = false

describe('a transition never weights toward a side with no picture', () => {
  it('holds the outgoing clip whole while the incoming side is still cold', () => {
    // Mid-dissolve is the worst point: half weight on a side that is not there.
    expect(progressWithSides(0.5, true, false, PAIR)).toBe(0)
    // And it is a real change, not a restatement of the old rule.
    expect(OLD(0.5)).toBe(0.5)
  })

  it('never lets the outgoing clip decay, at any point in the window', () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
      expect(progressWithSides(p, true, false, PAIR)).toBe(0)
    }
  })

  it('shows the incoming clip whole when the OUTGOING side is the missing one', () => {
    // The mirror case: weighting toward a missing `from` fades the incoming clip
    // UP from black instead of down to it, which is the same defect reversed.
    expect(progressWithSides(0.25, false, true, PAIR)).toBe(1)
    expect(progressWithSides(0, false, true, PAIR)).toBe(1)
  })

  it('leaves an ordinary transition exactly where the resolver put it', () => {
    // The overwhelmingly common case. Both sides have pictures, so this must be
    // the old behaviour to the bit, or every transition in the app changes.
    for (const p of [0, 0.1, 0.33, 0.5, 0.667, 0.9, 1]) {
      expect(progressWithSides(p, true, true, PAIR)).toBe(OLD(p))
    }
  })

  it('still clamps a progress the resolver reports outside the window', () => {
    expect(progressWithSides(-0.2, true, true, PAIR)).toBe(0)
    expect(progressWithSides(1.4, true, true, PAIR)).toBe(1)
  })

  it('does not invent a picture when NEITHER side has one', () => {
    // Nothing to protect: no texture on either side means the frame is
    // transparent whatever progress says, and lower tracks show through. Picking
    // a side here would be a rule with no picture behind it.
    for (const p of [0, 0.5, 1]) {
      expect(progressWithSides(p, false, false, PAIR)).toBe(OLD(p))
    }
  })
})

// ⛔ THE GATE CAUGHT THE FIRST CUT OF THIS FIX, on `a lone Dip to White dips
// through WHITE, not through black`, and it was right.
//
// A lone edge is a transition on a clip with NO neighbour, so `from` and `to`
// are the same clip and one side is a stand-in. Its empty side is not a picture
// we failed to prove: it is what the dip solid is weighted against, by design.
// The first cut forced progress to an end there, which deletes the dip.
//
// preview.ts guards PAIR transitions only, so a guarded null can only ever
// happen on a pair. These pin that the two rules meet on the same line.
describe('a lone edge is not a missing picture', () => {
  it('runs a lone dip exactly as the resolver asked, empty side and all', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(progressWithSides(p, false, true, LONE)).toBe(OLD(p))
      expect(progressWithSides(p, true, false, LONE)).toBe(OLD(p))
    }
  })

  it('holds the HALFWAY point of a lone dip, which is the frame that went red', () => {
    // At p = 0.5 a dip is fully on its solid. Forcing it to an end is what made
    // a Dip to White show no white at all.
    expect(progressWithSides(0.5, false, true, LONE)).toBe(0.5)
  })

  it('still clamps a lone edge reported outside its window', () => {
    expect(progressWithSides(-1, false, true, LONE)).toBe(0)
    expect(progressWithSides(2, false, true, LONE)).toBe(1)
  })
})
