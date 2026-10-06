// @vitest-environment jsdom
//
// While playing the Inspector holds still, and it holds still on the frame it
// was showing. It used to read -1, which every field clamps to the clip's first
// frame, so a Scale on a moving clip jumped when he pressed space (2026-10-06).

import { describe, expect, it } from 'vitest'
import { newProject } from '../engine/types'
import { inspectorPlayheadS } from './Inspector'

const at = (playheadS: number, playing: boolean) => ({ ui: { playheadS, playing }, project: newProject() })

describe('inspectorPlayheadS', () => {
  it('reads the frame quantized playhead while paused', () => {
    expect(inspectorPlayheadS(at(2.0001, false))).toBeCloseTo(2, 6)
  })

  it('keeps the last paused frame while playing, however far the playhead runs', () => {
    inspectorPlayheadS(at(2, false))
    expect(inspectorPlayheadS(at(2.5, true))).toBe(2)
    expect(inspectorPlayheadS(at(4.5, true))).toBe(2)
    // And follows again the moment it pauses.
    expect(inspectorPlayheadS(at(4.5, false))).toBeCloseTo(4.5, 6)
  })
})
