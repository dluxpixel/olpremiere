import { describe, expect, it } from 'vitest'

import { screenshotName } from './screenshot'

describe('screenshotName', () => {
  it('names a still by the frame it was taken on', () => {
    expect(screenshotName(0, 30)).toBe('Frame 00-00-00.00.png')
    expect(screenshotName(12 + 5 / 30, 30)).toBe('Frame 00-00-12.17.png')
    expect(screenshotName(3661.5, 60)).toBe('Frame 01-01-01.50.png')
  })

  it('carries no colon, which Windows cannot put in a filename', () => {
    // The whole reason the clock is dashed. A colon here would come back as
    // an asset he cannot save or drag out of the app.
    expect(screenshotName(3725.25, 24)).not.toContain(':')
    expect(screenshotName(3725.25, 24)).toMatch(/^Frame \d\d-\d\d-\d\d\.\d\d\.png$/)
  })

  it('snaps to a frame of the sequence fps, not a fixed one', () => {
    // 0.51 s is frame 12 (0.50 s) at 24 and frame 31 (0.52 s) at 60. A still
    // named by the wrong fps would sort into the wrong place beside its neighbours.
    expect(screenshotName(0.51, 24)).toBe('Frame 00-00-00.50.png')
    expect(screenshotName(0.51, 60)).toBe('Frame 00-00-00.52.png')
  })

  it('sorts by time once past ten minutes, where an unpadded clock would not', () => {
    const names = [65, 605, 3600].map((t) => screenshotName(t, 30))
    expect([...names].sort()).toEqual(names)
  })
})
