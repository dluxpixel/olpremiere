// The sound must end where the picture ends. The video path rounds the range up
// to whole frames; the audio must follow that count, not round on its own.

import { describe, expect, it } from 'vitest'
import { audioFramesFor } from './audioRender'

describe('audioFramesFor', () => {
  it('matches the video frame count to within one sample', () => {
    // 3.21 s at 30 fps is 96.3 frames, so the video renders 97: 3.2333 s.
    // Audio on its own would have rendered 154 080 samples (3.21 s), 1120 short.
    const frames = audioFramesFor(3.21, 30, 48000)
    expect(frames).toBe(Math.round((97 / 30) * 48000))
    expect(Math.abs(frames / 48000 - 97 / 30)).toBeLessThan(1 / 48000)
  })

  it('is exact when the range is already whole frames', () => {
    expect(audioFramesFor(2, 30, 48000)).toBe(96000)
    expect(audioFramesFor(1, 25, 48000)).toBe(48000)
  })

  it('holds for fractional rates', () => {
    const fps = 29.97
    const frames = audioFramesFor(10, fps, 48000)
    const videoFrames = Math.ceil(10 * fps)
    expect(Math.abs(frames / 48000 - videoFrames / fps)).toBeLessThan(1 / 48000)
  })

  it('never returns less than one sample, and survives a zero rate', () => {
    expect(audioFramesFor(0, 30, 48000)).toBe(1600) // one frame of sound for a one frame picture
    expect(audioFramesFor(1, 0, 48000)).toBe(48000)
  })
})
