/**
 * @vitest-environment jsdom
 *
 * A diamond dragged onto its neighbour stops one frame short of it, and the
 * LIVE draft stops at the same wall, so the diamond never jumps when he lets
 * go (the audit's FX-9; the review of 2026-10-07 found no test for the lane
 * half). Keyframes at 0.5, 1 and 2 s, the 1 s one a punch to 130 percent.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { channelKeyframes } from '../engine/effects/channels'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { KeyframeTrack } from './KeyframeTrack'
import { MotionRailContext, type MotionRailValue } from './MotionRail'

const PX_PER_S = 100
const FPS = 30

const clipNow = (): Clip => activeSequence(useStore.getState().project).tracks[0]!.clips[0]!

function punch(): Clip {
  const base = newTitleClip(defaultTitleDef('x'), 0, 5)
  const clip: Clip = {
    ...base,
    keyframes: { scale: [0.5, 1, 2].map((t, i) => ({ t, value: i === 1 ? 1.3 : 1, ease: 'linear' as const })) },
  }
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
  )
  return clip
}

/** A rail with a fixed zoom and nothing selected: all a lane reads. */
function rail(clip: Clip): MotionRailValue {
  const snap = (t: number) => Math.min(Math.max(Math.round(t * FPS) / FPS, 0), 5)
  return {
    clipId: clip.id,
    durS: 5,
    fps: FPS,
    pxPerS: PX_PER_S,
    startS: 0,
    viewW: 0,
    tToPx: (t) => t * PX_PER_S,
    pxToT: (px) => px / PX_PER_S,
    snapT: snap,
    snapDragT: snap,
    minGapS: 1 / FPS,
    selection: null,
    select: () => {},
    picked: new Set(),
    isPicked: () => false,
    picks: [],
    clearPicks: () => {},
    groupDeltaS: null,
    setGroupDelta: () => {},
    shiftPicks: () => {},
    lanesVisible: true,
  }
}

const diamondAt = (t: number): HTMLElement =>
  screen.getAllByTestId('keyframe').find((d) => d.getAttribute('data-kf-t') === t.toFixed(6))!

beforeEach(() => useStore.getState().setProject(newProject()))
afterEach(cleanup)

describe('dragging a diamond onto its neighbour', () => {
  it('stops one frame short live, and lands exactly there', () => {
    const clip = punch()
    render(
      <MotionRailContext.Provider value={rail(clip)}>
        <KeyframeTrack clip={clip} channel="scale" />
      </MotionRailContext.Provider>,
    )
    const wall = 1 - 1 / FPS
    fireEvent.pointerDown(diamondAt(0.5), { button: 0, clientX: 50 })
    // A full second to the right: well past the 1 s peak.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))
    })
    expect(parseFloat(diamondAt(0.5).style.left)).toBeCloseTo(wall * PX_PER_S, 6)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 150 }))
    })
    const kfs = channelKeyframes(clipNow(), 'scale').map((k) => [+k.t.toFixed(6), k.value])
    expect(kfs).toEqual([[+wall.toFixed(6), 1], [1, 1.3], [2, 1]])
  })
})
