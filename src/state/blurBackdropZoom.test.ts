// The blur band's tightness, per sequence. His ask, 2026-08-16: "make it so I
// can change it each single time."

import { beforeEach, describe, expect, it } from 'vitest'
import { BACKDROP_ZOOM, BLUR_BACKDROP_ZOOM } from '../engine/render/resolve'
import { activeSequence, newProject } from '../engine/types'
import { setActiveSequenceBlurBackdropZoom, useStore } from './store'

const seq = () => activeSequence(useStore.getState().project)

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('blur band tightness', () => {
  it('starts unset, so every project made before this reads the same', () => {
    // Undefined, NOT 1.4 written in. A stored default would mean an older file
    // and a new one disagree about what "untouched" means.
    expect(seq().blurBackdropZoom).toBeUndefined()
  })

  it('keeps the number he sets', () => {
    setActiveSequenceBlurBackdropZoom(1.8)
    expect(seq().blurBackdropZoom).toBe(1.8)
  })

  it('holds it inside the envelope', () => {
    setActiveSequenceBlurBackdropZoom(99)
    expect(seq().blurBackdropZoom).toBe(BLUR_BACKDROP_ZOOM.max)
    setActiveSequenceBlurBackdropZoom(0)
    expect(seq().blurBackdropZoom).toBe(BLUR_BACKDROP_ZOOM.min)
  })

  it('is undoable, because it changes what the video looks like', () => {
    setActiveSequenceBlurBackdropZoom(2)
    useStore.getState().undo()
    expect(seq().blurBackdropZoom).toBeUndefined()
  })

  it('folds a drag into ONE undo step rather than forty', () => {
    // A scrub fires a commit per pixel. Without the merge key, pulling the band
    // across its range would bury every edit before it under the drag.
    setActiveSequenceBlurBackdropZoom(1.5)
    setActiveSequenceBlurBackdropZoom(1.6)
    setActiveSequenceBlurBackdropZoom(1.7)
    useStore.getState().undo()
    expect(seq().blurBackdropZoom).toBeUndefined()
  })

  it('writes nothing when the value did not move', () => {
    setActiveSequenceBlurBackdropZoom(BACKDROP_ZOOM)
    const before = useStore.getState().project
    setActiveSequenceBlurBackdropZoom(BACKDROP_ZOOM)
    expect(useStore.getState().project).toBe(before)
  })
})
