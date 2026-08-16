import { describe, expect, it } from 'vitest'

import { screenshotName } from './screenshot'

describe('screenshotName', () => {
  it('names a still by the frame it was taken on', () => {
    expect(screenshotName(0, 30)).toBe('Frame 00-00-00-00.png')
    expect(screenshotName(12 + 5 / 30, 30)).toBe('Frame 00-00-12-05.png')
    expect(screenshotName(3661.5, 60)).toBe('Frame 01-01-01-30.png')
  })

  it('carries no colon, which Windows cannot put in a filename', () => {
    // The whole reason the timecode is dashed. A colon here would come back as
    // an asset he cannot save or drag out of the app.
    expect(screenshotName(3725.25, 24)).not.toContain(':')
    expect(screenshotName(3725.25, 24)).toMatch(/^Frame \d\d-\d\d-\d\d-\d\d\.png$/)
  })

  it('reads the frame count against the sequence fps, not a fixed one', () => {
    // Half a second is frame 12 at 24 and frame 30 at 60. A still named by the
    // wrong fps would sort into the wrong place beside its neighbours.
    expect(screenshotName(0.5, 24)).toBe('Frame 00-00-00-12.png')
    expect(screenshotName(0.5, 60)).toBe('Frame 00-00-00-30.png')
  })
})
