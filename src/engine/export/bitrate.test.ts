import { describe, expect, it } from 'vitest'

import { losslessBitrate } from './bitrate'

describe('losslessBitrate', () => {
  it('scales with pixels × fps at ~0.5 bpp', () => {
    // 1920×1080×30 × 0.5 = 31.104 Mbps
    expect(losslessBitrate(1920, 1080, 30)).toBe(31_104_000)
  })

  it('never drops below the High preset (24 Mbps)', () => {
    // 640×360×30 × 0.5 ≈ 3.5 Mbps → floored
    expect(losslessBitrate(640, 360, 30)).toBe(24_000_000)
  })

  it('is ceiled so a 4K/60 timeline stays sane', () => {
    // 3840×2160×60 × 0.5 ≈ 249 Mbps → ceiled
    expect(losslessBitrate(3840, 2160, 60)).toBe(150_000_000)
  })
})
