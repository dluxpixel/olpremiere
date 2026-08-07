// The two things in the Motion block that can quietly lie to him: a saved chip
// read out of storage he filled months ago, and the headroom number that is the
// only warning he gets before an upscaled punch reaches an export.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEPTH_MAX,
  LEGACY_CURVE,
  LEGACY_RISE_FRAMES,
  MAX_ZOOM_PRESETS,
  ZOOM_PRESETS_KEY,
  headroomCeiling,
  loadPresets,
  overHeadroom,
  parsePresets,
  samePreset,
  savePresets,
  type ZoomPreset,
} from './punchPresets'

describe('the saved chip read shim', () => {
  it('reads bare numbers already in his browser forward into full moves', () => {
    expect(parsePresets('[1.15, 1.6]')).toEqual([
      { scale: 1.15, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
      { scale: 1.6, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
    ])
  })

  it('reads the new shape back unchanged', () => {
    const stored = '[{"scale":1.3,"riseFrames":9,"curve":"overshoot"}]'
    expect(parsePresets(stored)).toEqual([{ scale: 1.3, riseFrames: 9, curve: 'overshoot' }])
  })

  it('reads a mixed row, which is what an upgrade actually looks like', () => {
    expect(parsePresets('[1.25, {"scale":1.5,"riseFrames":12,"curve":"settle"}]')).toEqual([
      { scale: 1.25, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
      { scale: 1.5, riseFrames: 12, curve: 'settle' },
    ])
  })

  it('falls back rather than handing a punch an unknown curve or a missing rise', () => {
    expect(parsePresets('[{"scale":1.4,"curve":"bouncyThing"}]')).toEqual([
      { scale: 1.4, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
    ])
  })

  it('drops entries with no depth to punch to, and never throws on junk', () => {
    expect(parsePresets('["1.2", null, {"riseFrames":5}, {"scale":"deep"}]')).toEqual([])
    expect(parsePresets('not json at all')).toEqual([])
    expect(parsePresets('{"scale":1.2}')).toEqual([])
    expect(parsePresets(null)).toEqual([])
  })

  it('clamps a stored depth into the range the field can express', () => {
    expect(parsePresets('[99]')[0].scale).toBe(DEPTH_MAX)
    expect(parsePresets('[{"scale":1.2,"riseFrames":0}]')[0].riseFrames).toBe(1)
  })

  it('keeps the newest chips when storage holds more than the row does', () => {
    const many = JSON.stringify([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8])
    const read = parsePresets(many)
    expect(read).toHaveLength(MAX_ZOOM_PRESETS)
    expect(read[read.length - 1].scale).toBeCloseTo(1.8, 6)
  })

  it('calls two chips the same move only when all three numbers match', () => {
    const a: ZoomPreset = { scale: 1.2, riseFrames: 5, curve: 'snapIn' }
    expect(samePreset(a, { ...a })).toBe(true)
    expect(samePreset(a, { ...a, riseFrames: 6 })).toBe(false)
    expect(samePreset(a, { ...a, curve: 'settle' })).toBe(false)
    expect(samePreset(a, { ...a, scale: 1.4 })).toBe(false)
  })
})

describe('the chips through real storage', () => {
  const bag = new Map<string, string>()

  beforeEach(() => {
    bag.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
    })
  })

  afterEach(() => void vi.unstubAllGlobals())

  it('round-trips a saved move under the key his old presets are already under', () => {
    const list: ZoomPreset[] = [{ scale: 1.7, riseFrames: 12, curve: 'windUp' }]
    savePresets(list)
    expect(bag.has(ZOOM_PRESETS_KEY)).toBe(true)
    expect(loadPresets()).toEqual(list)
  })

  it('upgrades the legacy row in place when it is read', () => {
    bag.set(ZOOM_PRESETS_KEY, '[1.1, 1.4]')
    expect(loadPresets()).toEqual([
      { scale: 1.1, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
      { scale: 1.4, riseFrames: LEGACY_RISE_FRAMES, curve: LEGACY_CURVE },
    ])
  })
})

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
