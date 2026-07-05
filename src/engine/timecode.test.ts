import { describe, expect, it } from 'vitest'
import { formatTimecode, frameToTime, parseTimecode, quantizeToFrame, timeToFrame } from './timecode'

describe('formatTimecode', () => {
  it('formats zero', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
  })
  it('formats seconds and frames at 30fps', () => {
    expect(formatTimecode(1.5, 30)).toBe('00:00:01:15')
    expect(formatTimecode(4.4, 30)).toBe('00:00:04:12')
  })
  it('formats hours/minutes', () => {
    expect(formatTimecode(3661.5, 30)).toBe('01:01:01:15')
  })
  it('rounds to the nearest frame', () => {
    expect(formatTimecode(0.9999, 30)).toBe('00:00:01:00')
    expect(formatTimecode(0.0166, 30)).toBe('00:00:00:00')
  })
  it('clamps negatives to zero', () => {
    expect(formatTimecode(-3, 30)).toBe('00:00:00:00')
  })
  it('carries frames into seconds correctly at 24fps', () => {
    expect(formatTimecode(23 / 24, 24)).toBe('00:00:00:23')
    expect(formatTimecode(24 / 24, 24)).toBe('00:00:01:00')
  })
})

describe('parseTimecode', () => {
  it('parses full HH:MM:SS:FF', () => {
    expect(parseTimecode('01:01:01:15', 30)).toBeCloseTo(3661.5)
  })
  it('parses shorter forms', () => {
    expect(parseTimecode('01:15', 30)).toBeCloseTo(1.5) // SS:FF
    expect(parseTimecode('02:01:15', 30)).toBeCloseTo(121.5) // MM:SS:FF
  })
  it('parses plain seconds', () => {
    expect(parseTimecode('4.25', 30)).toBeCloseTo(4.25)
  })
  it('rejects junk', () => {
    expect(parseTimecode('', 30)).toBeNull()
    expect(parseTimecode('abc', 30)).toBeNull()
    expect(parseTimecode('1:2:3:4:5', 30)).toBeNull()
    expect(parseTimecode('1:xx', 30)).toBeNull()
  })
})

describe('frame math', () => {
  it('round-trips time ↔ frame', () => {
    expect(timeToFrame(1.5, 30)).toBe(45)
    expect(frameToTime(45, 30)).toBeCloseTo(1.5)
  })
  it('quantizes to the frame grid', () => {
    expect(quantizeToFrame(1.49, 30)).toBeCloseTo(45 / 30)
    expect(quantizeToFrame(1.516, 30)).toBeCloseTo(45 / 30)
  })
})
