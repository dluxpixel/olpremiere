// @vitest-environment jsdom
//
// (jsdom because the replay registers its cancel listeners on `window`, which is
// the whole reason an interrupt can win the playhead back.)
//
// Where the playhead is left when the replay is over.
//
// His words, 2026-08-24: *"the keyframe that ends, but it's bugged. When the
// preview goes over it, it snaps right back into it, but in the export it's
// fine."* The replay ran the move out to its end and then handed the playhead
// back to where it had borrowed it from, which on the shelf is usually inside
// the move, so the picture jumped backwards the instant the move finished. The
// export never runs this file, which is why only the picture was wrong.
//
// ⛔ BOTH DIRECTIONS ARE PINNED HERE ON PURPOSE. The hand-back is CORRECT when he
// interrupts: the replay borrowed his playhead and a click means he wants it
// back, and a session that only saw the first test could "fix" that away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newTitleClip, type Clip } from '../engine/types'
import { playMovePreview, stopMovePreview } from './movePreview'
import { updateActiveSequence, useStore } from './store'

const CLIP_S = 4

/** rAF driven by hand: the replay's own clock is performance.now(). */
let frames: ((now: number) => void)[] = []
let nowMs = 0

function seedClip(): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), 0, CLIP_S)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  return activeSequence(useStore.getState().project).tracks[0].clips[0]
}

/** Run the loop forward by `ms` of wall clock, one frame at a time. */
function advance(ms: number): void {
  const step = 16
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    const due = frames
    frames = []
    nowMs += step
    for (const f of due) f(nowMs)
    if (due.length === 0) return
  }
}

const playheadS = (): number => useStore.getState().ui.playheadS

beforeEach(() => {
  frames = []
  nowMs = 0
  vi.stubGlobal('requestAnimationFrame', (cb: (n: number) => void): number => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
  stopMovePreview()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the move replay and the playhead', () => {
  it('leaves the playhead at the END of the move when the sweep finishes', () => {
    const clip = seedClip()
    // He is parked inside the clip, which is where picking a move off the shelf
    // usually finds him, and is exactly the position the old restore snapped
    // back to.
    useStore.getState().setUI({ playheadS: 1.5 })

    playMovePreview(clip.id)
    expect(playheadS()).toBeCloseTo(0, 3) // the sweep starts at the clip's head

    advance(CLIP_S * 1000 + 200)

    expect(useStore.getState().ui.previewingMove).toBe(false)
    // At the end of the move, not back inside it.
    expect(playheadS()).toBeCloseTo(CLIP_S, 3)
  })

  it('still hands the playhead back when he interrupts the sweep', () => {
    const clip = seedClip()
    useStore.getState().setUI({ playheadS: 1.5 })

    playMovePreview(clip.id)
    advance(500) // part way through
    expect(playheadS()).toBeGreaterThan(0)
    expect(playheadS()).toBeLessThan(CLIP_S)

    stopMovePreview() // stands in for his pointerdown / keydown / wheel

    expect(useStore.getState().ui.previewingMove).toBe(false)
    expect(playheadS()).toBeCloseTo(1.5, 3)
  })
})
