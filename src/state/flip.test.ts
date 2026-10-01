// His ask, 2026-10-01: "Please quickly add and release a feature where I can
// flip the video (I don't know if you know what I mean, like flip from right to
// left)." A per clip mirror, from the Inspector, the multi selection Inspector
// and the clip menu, one undo, and only ever written as true so older projects
// open exactly as they were.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveFrame } from '../engine/render/resolve'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { toggleClipsFlip } from './bulkEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

const ASSET = { id: 'a1', name: 'gameplay.mp4', kind: 'video', durationS: 10, width: 1920, height: 1080 } as MediaAsset

function seed(clip: Clip, trackIndex = 0): string {
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === trackIndex ? { ...t, clips: [...t.clips, clip] } : t)) }),
  )
  return clip.id
}

beforeEach(() => {
  const p = newProject()
  useStore.getState().setProject({ ...p, assets: { [ASSET.id]: ASSET } })
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('flip left to right', () => {
  it('mirrors every selected picture as ONE undo, and back again', () => {
    const a = seed(newClipFromAsset(ASSET, 0))
    const b = seed(newClipFromAsset(ASSET, 10))
    toggleClipsFlip([a, b])
    expect(clipById(a).transform.flipH).toBe(true)
    expect(clipById(b).transform.flipH).toBe(true)
    expect(useStore.getState().undo()).toMatch(/Flip 2 clips/)
    expect(clipById(a).transform.flipH).toBeUndefined()
    expect(clipById(b).transform.flipH).toBeUndefined()
  })

  it('a mixed selection all flips; flipping back leaves the clip exactly as it was', () => {
    const a = seed(newClipFromAsset(ASSET, 0))
    const b = seed(newClipFromAsset(ASSET, 10))
    const before = clipById(a)
    toggleClipsFlip([a])
    toggleClipsFlip([a, b])
    expect(clipById(a).transform.flipH).toBe(true)
    expect(clipById(b).transform.flipH).toBe(true)
    toggleClipsFlip([a, b])
    // The key is gone, not false: an older project's clip and a flipped back
    // one are the same clip.
    expect(clipById(a)).toEqual(before)
    expect('flipH' in clipById(b).transform).toBe(false)
  })

  it('leaves titles alone: mirrored words would just be unreadable', () => {
    const title = seed(newTitleClip(defaultTitleDef('x'), 0, 2))
    toggleClipsFlip([title])
    expect(clipById(title).transform.flipH).toBeUndefined()
  })

  it('reaches the renderer, and an unflipped layer carries no flip at all', () => {
    const a = seed(newClipFromAsset(ASSET, 0))
    const layerAt = () => {
      const op = resolveFrame(seq(), 1).ops.find((o) => o.type === 'layer' && o.layer.clipId === a)
      if (!op || op.type !== 'layer') throw new Error('no layer for the clip')
      return op.layer
    }
    expect('flipH' in layerAt().transform).toBe(false)
    toggleClipsFlip([a])
    expect(layerAt().transform.flipH).toBe(true)
  })
})
