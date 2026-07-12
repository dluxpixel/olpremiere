import { describe, expect, it } from 'vitest'

import { losslessBitrate, youtubeBitrate } from './bitrate'

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

describe('youtubeBitrate', () => {
  it('lands near 2× YouTube 1080p30 recommendation (~17 Mbps)', () => {
    // 1920×1080×30 × 0.28 = 17.418 Mbps (their rec is 8 Mbps)
    expect(youtubeBitrate(1920, 1080, 30)).toBe(17_418_240)
  })

  it('scales up for a 2K / 4K upload', () => {
    // 2560×1440×30 × 0.28 ≈ 31 Mbps (rec 16)
    expect(youtubeBitrate(2560, 1440, 30)).toBe(30_965_760)
    // 3840×2160×30 × 0.28 ≈ 70 Mbps (rec 35–45)
    expect(youtubeBitrate(3840, 2160, 30)).toBe(69_672_960)
  })

  it('floors at 12 Mbps (YouTube 1080p60 rec) for small rasters', () => {
    expect(youtubeBitrate(640, 360, 30)).toBe(12_000_000)
  })

  it('is ceiled so an 8K/high-fps timeline stays sane', () => {
    expect(youtubeBitrate(7680, 4320, 60)).toBe(120_000_000)
  })
})
