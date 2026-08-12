// The headroom number is the only warning he gets before an upscaled punch
// reaches an export.
//
// This file used to be punchPresets.test.ts and most of it tested code nothing
// called: the saved zoom chips died with the motion desk in v0.1.55 and the
// tests were the only thing still holding them up. Those went with the code.

import { describe, expect, it } from 'vitest'
import { headroomCeiling, overHeadroom } from './headroom'

describe('headroom', () => {
  it('is the source width over the sequence width', () => {
    // 4K into 1080p: he can punch to 200 percent before he is upscaling.
    expect(headroomCeiling(3840, 1920)).toBeCloseTo(2, 6)
    // Native 1080p: there is no headroom at all, and that is the warning.
    expect(headroomCeiling(1920, 1920)).toBeCloseTo(1, 6)
    expect(headroomCeiling(1280, 1920)).toBeCloseTo(1280 / 1920, 6)
  })

  it('says nothing when there is no source width to divide', () => {
    // A title clip renders at sequence resolution and carries no asset.
    expect(headroomCeiling(undefined, 1920)).toBeNull()
    expect(headroomCeiling(0, 1920)).toBeNull()
    expect(headroomCeiling(Number.NaN, 1920)).toBeNull()
    expect(headroomCeiling(3840, 0)).toBeNull()
  })

  it('flags the punch that only shows its softness on export', () => {
    // His actual case: a 1080p source pushed to 170 percent in a 1080p sequence.
    expect(overHeadroom(1.7, headroomCeiling(1920, 1920))).toBe(true)
    // The same 170 percent on 4K footage is still inside the source.
    expect(overHeadroom(1.7, headroomCeiling(3840, 1920))).toBe(false)
    // Sitting exactly on the ceiling is not over it.
    expect(overHeadroom(2, headroomCeiling(3840, 1920))).toBe(false)
  })

  it('never flags a clip whose headroom is unknown', () => {
    expect(overHeadroom(4, null)).toBe(false)
  })
})
