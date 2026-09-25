import { describe, expect, it } from 'vitest'
import { EDGE_ZONE_PX, edgeSpeedX, edgeSpeedY } from './timelineEdgeScroll'

const rect = { left: 100, right: 900, top: 50, bottom: 450 }

describe('edgeSpeedX', () => {
  it('is still away from the edges', () => {
    expect(edgeSpeedX(rect, 500)).toBe(0)
    expect(edgeSpeedX(rect, 100 + EDGE_ZONE_PX)).toBe(0)
    expect(edgeSpeedX(rect, 900 - EDGE_ZONE_PX)).toBe(0)
  })

  it('ramps from 4 to 20 px a frame toward either side', () => {
    expect(edgeSpeedX(rect, 100 + EDGE_ZONE_PX - 1)).toBeCloseTo(-(4 + 16 / EDGE_ZONE_PX))
    expect(edgeSpeedX(rect, 100)).toBe(-20)
    expect(edgeSpeedX(rect, 900)).toBe(20)
  })

  it('caps at 20 past the edge', () => {
    expect(edgeSpeedX(rect, 0)).toBe(-20)
    expect(edgeSpeedX(rect, 2000)).toBe(20)
  })
})

describe('edgeSpeedY', () => {
  it('is still away from the edges', () => {
    expect(edgeSpeedY(rect, 250)).toBe(0)
  })

  it('ramps from 2 to 10 px a frame, slower than sideways', () => {
    expect(edgeSpeedY(rect, 50)).toBe(-10)
    expect(edgeSpeedY(rect, 450)).toBe(10)
    expect(edgeSpeedY(rect, 450 - EDGE_ZONE_PX + 1)).toBeCloseTo(2 + 8 / EDGE_ZONE_PX)
    expect(edgeSpeedY(rect, -500)).toBe(-10)
  })
})
