import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatTimecode,
  formatTimecodeDelta,
  frameToTime,
  parseTimecode,
  quantizeToFrame,
  timeToFrame,
} from './timecode'

describe('formatTimecode', () => {
  it('formats zero', () => {
    expect(formatTimecode(0, 30)).toBe('0:00.00')
  })
  it('reads like a stopwatch, his example: 0:03.97 then 0:04.00', () => {
    // 2026-10-03: "It says 3:29, and then it goes to 4:00." The last frame of a
    // second and the first frame of the next must read as hundredths.
    expect(formatTimecode(119 / 30, 30)).toBe('0:03.97')
    expect(formatTimecode(120 / 30, 30)).toBe('0:04.00')
  })
  it('formats seconds with hundredths at 30fps', () => {
    expect(formatTimecode(1.5, 30)).toBe('0:01.50')
    expect(formatTimecode(4.4, 30)).toBe('0:04.40')
  })
  it('formats minutes, and hours only above an hour', () => {
    expect(formatTimecode(65.5, 30)).toBe('1:05.50')
    expect(formatTimecode(3661.5, 30)).toBe('1:01:01.50')
  })
  it('snaps to the nearest frame before it prints', () => {
    expect(formatTimecode(0.9999, 30)).toBe('0:01.00')
    expect(formatTimecode(0.0166, 30)).toBe('0:00.00')
    // 6.318 s is frame 189.54 at 30 fps: it reads as frame 190.
    expect(formatTimecode(6.318, 30)).toBe('0:06.33')
  })
  it('clamps negatives to zero', () => {
    expect(formatTimecode(-3, 30)).toBe('0:00.00')
  })
  it('carries into the next second at 24fps', () => {
    expect(formatTimecode(23 / 24, 24)).toBe('0:00.96')
    expect(formatTimecode(24 / 24, 24)).toBe('0:01.00')
  })
  it('never prints the same reading for two frames, at any common rate', () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100]) {
      const seen = new Set<string>()
      let last = -1
      for (let f = 0; f < fps * 70; f++) {
        const text = formatTimecode(f / fps, fps)
        expect(seen.has(text)).toBe(false)
        seen.add(text)
        const back = parseTimecode(text, fps)!
        expect(back).toBeGreaterThan(last)
        last = back
        // Typing back what a field shows lands on the very same frame.
        expect(Math.round(back * fps)).toBe(f)
      }
    }
  })
  it('shows thousandths above 100 fps, where a hundredth is longer than a frame', () => {
    expect(formatTimecode(1 / 120, 120)).toBe('0:00.008')
    expect(formatTimecode(2 / 120, 120)).toBe('0:00.017')
  })
})

describe('formatClock', () => {
  it('rounds whole units so a second can never read 100 hundredths', () => {
    expect(formatClock(59.999)).toBe('1:00.00')
    expect(formatClock(3599.996)).toBe('1:00:00.00')
  })
  it('drops the fraction at zero places', () => {
    expect(formatClock(65, 0)).toBe('1:05')
    expect(formatClock(3725, 0)).toBe('1:02:05')
  })
})

describe('formatTimecodeDelta', () => {
  it('says a change as signed seconds', () => {
    expect(formatTimecodeDelta(13 / 30, 30)).toBe('+0.43s')
    expect(formatTimecodeDelta(-1, 30)).toBe('-1.00s')
    expect(formatTimecodeDelta(0, 30)).toBe('+0.00s')
    expect(formatTimecodeDelta(12.5, 30)).toBe('+12.50s')
  })
  it('snaps to whole frames, like the edit it describes', () => {
    expect(formatTimecodeDelta(0.4401, 30)).toBe('+0.43s')
  })
  it('switches to a clock past a minute', () => {
    expect(formatTimecodeDelta(65.2, 30)).toBe('+1:05.20')
    expect(formatTimecodeDelta(-60, 30)).toBe('-1:00.00')
  })
})

describe('parseTimecode', () => {
  it('parses what the fields show now', () => {
    expect(parseTimecode('0:03.97', 30)).toBeCloseTo(3.97)
    expect(parseTimecode('1:05', 30)).toBeCloseTo(65)
    expect(parseTimecode('1:05.25', 30)).toBeCloseTo(65.25)
    expect(parseTimecode('1:01:01.50', 30)).toBeCloseTo(3661.5)
  })
  it('still parses the old full HH:MM:SS:FF, last group in frames', () => {
    expect(parseTimecode('01:01:01:15', 30)).toBeCloseTo(3661.5)
    expect(parseTimecode('00:00:03:29', 30)).toBeCloseTo(3 + 29 / 30)
  })
  it('reads two and three groups as a clock, the way the fields now print them', () => {
    expect(parseTimecode('01:15', 30)).toBeCloseTo(75)
    expect(parseTimecode('02:01:15', 30)).toBeCloseTo(7275)
  })
  it('parses plain seconds, with a point, a comma or a trailing s', () => {
    expect(parseTimecode('4.25', 30)).toBeCloseTo(4.25)
    expect(parseTimecode('4,25', 30)).toBeCloseTo(4.25)
    expect(parseTimecode('4.25s', 30)).toBeCloseTo(4.25)
    expect(parseTimecode('.5', 30)).toBeCloseTo(0.5)
    expect(parseTimecode('12', 30)).toBe(12)
  })
  it('rejects junk', () => {
    expect(parseTimecode('', 30)).toBeNull()
    expect(parseTimecode('abc', 30)).toBeNull()
    expect(parseTimecode('1:2:3:4:5', 30)).toBeNull()
    expect(parseTimecode('1:xx', 30)).toBeNull()
    expect(parseTimecode('1.5:20', 30)).toBeNull()
    expect(parseTimecode('00:00:03:29.5', 30)).toBeNull()
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
