// Freeze frame: the clip holds one source second for its whole length.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFrame } from '../engine/render/resolve'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  newProject,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { isClipFrozen, splitAtPlayhead, toggleClipFreeze } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)
const byId = (id: string): Clip => clips().find((c) => c.id === id)!

/** A plain video clip, 0..8s on the timeline, reading source 0..8. */
function seedVideo(): Clip {
  const asset: MediaAsset = {
    id: 'a1',
    name: 'take.mp4',
    kind: 'video',
    blobKey: 'asset/a1',
    durationS: 30,
    width: 1920,
    height: 1080,
    hasAudio: false,
    hasVideo: true,
  }
  const clip: Clip = {
    id: 'c1',
    assetId: 'a1',
    startS: 0,
    inS: 0,
    outS: 8,
    speed: 1,
    enabled: true,
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      rotationDeg: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      crop: { t: 0, r: 0, b: 0, l: 0 },
    },
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
  }
  useStore.getState().setProject({ ...newProject(), assets: { a1: asset } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)),
    }),
  )
  return clip
}

/** The source second the renderer would sample at sequence time t. */
function sourceAt(t: number): number {
  const op = resolveFrame(seq(), t).ops.find((o) => o.type === 'layer')
  return op && op.type === 'layer' ? op.layer.sourceTimeS : NaN
}

beforeEach(() => {
  seedVideo()
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('toggleClipFreeze', () => {
  it('holds the frame he is LOOKING at, not the clip start', () => {
    useStore.getState().setUI({ playheadS: 3 })
    toggleClipFreeze('c1')
    expect(byId('c1').freezeAtS).toBeCloseTo(3, 6)
  })

  it('serves that one source second for the whole clip', () => {
    // The feature in one assertion: time moves, the frame does not.
    useStore.getState().setUI({ playheadS: 3 })
    toggleClipFreeze('c1')
    expect(sourceAt(0)).toBeCloseTo(3, 6)
    expect(sourceAt(4)).toBeCloseTo(3, 6)
    expect(sourceAt(7.9)).toBeCloseTo(3, 6)
  })

  it('runs normally before it is frozen', () => {
    expect(sourceAt(0)).toBeCloseTo(0, 6)
    expect(sourceAt(4)).toBeCloseTo(4, 6)
  })

  it('gives the footage back on the second press', () => {
    useStore.getState().setUI({ playheadS: 3 })
    toggleClipFreeze('c1')
    expect(isClipFrozen(byId('c1'))).toBe(true)
    toggleClipFreeze('c1')
    expect(isClipFrozen(byId('c1'))).toBe(false)
    expect(sourceAt(4)).toBeCloseTo(4, 6)
  })

  it('leaves no key behind when it thaws, so the project file cannot lie', () => {
    toggleClipFreeze('c1')
    toggleClipFreeze('c1')
    expect(Object.hasOwn(byId('c1'), 'freezeAtS')).toBe(false)
  })

  it('holds the first frame when the playhead is off the clip', () => {
    // A time outside the source would decode nothing and show black.
    useStore.getState().setUI({ playheadS: 50 })
    toggleClipFreeze('c1')
    expect(byId('c1').freezeAtS).toBeCloseTo(0, 6)
  })

  it('is one undo press', () => {
    useStore.getState().setUI({ playheadS: 3 })
    toggleClipFreeze('c1')
    useStore.getState().undo()
    expect(isClipFrozen(byId('c1'))).toBe(false)
  })
})

// ⛔ THE REASON THE HELD TIME IS STORED RATHER THAN A FLAG. splitClip moves the
// right half's inS forward at the cut, so a flag meaning "hold inS" would make
// the two halves of a cut freeze show different frames.
describe('cutting a freeze', () => {
  it('leaves both halves holding the SAME frame', () => {
    useStore.getState().setUI({ playheadS: 2 })
    toggleClipFreeze('c1')

    useStore.getState().setUI({ playheadS: 5 })
    splitAtPlayhead()

    const pieces = clips()
    expect(pieces).toHaveLength(2)
    for (const p of pieces) expect(p.freezeAtS).toBeCloseTo(2, 6)
    // And the renderer agrees on both sides of the cut.
    expect(sourceAt(1)).toBeCloseTo(2, 6)
    expect(sourceAt(6)).toBeCloseTo(2, 6)
  })
})
