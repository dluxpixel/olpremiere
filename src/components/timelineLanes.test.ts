import { describe, expect, it } from 'vitest'
import { RULER_H } from './timelineGeometry'
import {
  buildLaneInfos,
  clipWindowS,
  laneAtY,
  laneHoverClass,
  lanesCursorClass,
  marqueeHitIds,
  modifierMods,
  silencedTest,
  timelineLengthS,
} from './timelineLanes'
import { makeClip, makeTrack } from './timelineTestFixtures'

describe('lane geometry', () => {
  const v2 = makeTrack({ height: 50 })
  const v1 = makeTrack({ height: 64 })
  const a1 = makeTrack({ kind: 'audio', height: 60 })
  const infos = buildLaneInfos([v2, v1], [a1])

  it('stacks video lanes under the ruler, then a 2px divider, then audio', () => {
    expect(infos.map((i) => i.top)).toEqual([RULER_H, RULER_H + 50, RULER_H + 50 + 64 + 2])
    expect(infos.map((i) => i.track)).toEqual([v2, v1, a1])
  })

  it('finds the lane under a y, top edge inclusive, bottom edge exclusive', () => {
    expect(laneAtY(infos, RULER_H - 1)).toBeNull()
    expect(laneAtY(infos, RULER_H)).toBe(v2)
    expect(laneAtY(infos, RULER_H + 49)).toBe(v2)
    expect(laneAtY(infos, RULER_H + 50)).toBe(v1)
    // The divider belongs to no lane.
    expect(laneAtY(infos, RULER_H + 50 + 64)).toBeNull()
    expect(laneAtY(infos, RULER_H + 50 + 64 + 2)).toBe(a1)
    expect(laneAtY(infos, 10_000)).toBeNull()
  })
})

describe('marquee hits', () => {
  const a = makeClip({ startS: 0, outS: 2 })
  const b = makeClip({ startS: 5, outS: 2 })
  const c = makeClip({ startS: 1, outS: 2 })
  const top = makeTrack({ height: 50, clips: [a, b] })
  const bottom = makeTrack({ height: 50, clips: [c] })
  const infos = buildLaneInfos([top, bottom], [])

  it('selects clips whose box touches the rectangle, in any drag direction', () => {
    // 10px/s: x 10..30 is 1s..3s, top lane only. b starts at 5s.
    expect(marqueeHitIds(infos, 10, { x0: 30, y0: RULER_H + 20, x1: 10, y1: RULER_H + 10 })).toEqual([a.id])
    expect(marqueeHitIds(infos, 10, { x0: 10, y0: RULER_H + 10, x1: 30, y1: RULER_H + 20 })).toEqual([a.id])
  })

  it('reaches into every lane the rectangle crosses', () => {
    const box = { x0: 15, y0: RULER_H + 10, x1: 60, y1: RULER_H + 70 }
    expect(marqueeHitIds(infos, 10, box)).toEqual([a.id, b.id, c.id])
  })

  it('counts a clip edge exactly on the rectangle edge as a hit', () => {
    // a ends at 2s = 20px.
    expect(marqueeHitIds(infos, 10, { x0: 20, y0: RULER_H, x1: 30, y1: RULER_H + 1 })).toEqual([a.id])
  })
})

describe('content size and the virtualization window', () => {
  it('is the sequence plus a minute, never under two minutes', () => {
    expect(timelineLengthS(0)).toBe(120)
    expect(timelineLengthS(60)).toBe(120)
    expect(timelineLengthS(100)).toBe(160)
  })

  it('renders everything before the first measure', () => {
    expect(clipWindowS(null, 60)).toEqual({ winStartS: -Infinity, winEndS: Infinity })
  })

  it('keeps one viewport of margin on each side', () => {
    expect(clipWindowS({ left: 1000, width: 500 }, 50)).toEqual({ winStartS: 10, winEndS: 40 })
  })
})

describe('silenced lanes', () => {
  it('follows mute when nothing is soloed', () => {
    const muted = makeTrack({ muted: true })
    const open = makeTrack()
    const test = silencedTest([muted, open])
    expect(test(muted)).toBe(true)
    expect(test(open)).toBe(false)
  })

  it('silences every lane but the soloed ones, mute or not', () => {
    const solo = makeTrack({ solo: true, muted: true })
    const other = makeTrack()
    const test = silencedTest([solo, other])
    expect(test(solo)).toBe(false)
    expect(test(other)).toBe(true)
  })
})

describe('class and dataset strings', () => {
  it('tints a hovered lane green when valid and red when not', () => {
    expect(laneHoverClass(null)).toBe('')
    expect(laneHoverClass({ valid: true })).toContain('ring-accent/50')
    expect(laneHoverClass({ valid: false })).toContain('ring-danger/50')
  })

  it('gives the lanes the cursor of the tool', () => {
    expect(lanesCursorClass('select', undefined)).toBe('')
    expect(lanesCursorClass('razor', 'move')).toBe('cursor-razor')
    expect(lanesCursorClass('hand', undefined)).toBe('cursor-grab')
    expect(lanesCursorClass('hand', 'hand')).toBe('cursor-grabbing')
  })

  it('names the held modifiers the way index.css expects', () => {
    expect(modifierMods(false, false)).toBe('')
    expect(modifierMods(true, false)).toBe('ctrl')
    expect(modifierMods(false, true)).toBe('alt')
    expect(modifierMods(true, true)).toBe('ctrl-alt')
  })
})
