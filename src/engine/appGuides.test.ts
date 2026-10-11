import { describe, expect, it } from 'vitest'
import { APP_GUIDE_APPS, appGuideHiddenReason, appGuideRegions, isTallFrame } from './appGuides'

// The TikTok and Reels guides: where each app covers a tall picture. The numbers are estimates
// (appGuides.ts says where from), so these hold the SHAPE of the answer: the scaling, the Phone
// frame's bottom bar, the three areas never overlapping, and nothing at all on a wide frame.

const sizes = (w: number, h: number, app: 'tiktok' | 'reels') => {
  const r = appGuideRegions(w, h, app)!
  const by = (k: string) => r.find((x) => x.key === k)!
  return { top: by('top').h, bottom: by('bottom').h, right: by('right').w }
}

describe('appGuideRegions', () => {
  it('on 1080 x 1920 gives TikTok 150 / 440 / 130 and Reels 220 / 420 / 120', () => {
    expect(sizes(1080, 1920, 'tiktok')).toEqual({ top: 150, bottom: 440, right: 130 })
    expect(sizes(1080, 1920, 'reels')).toEqual({ top: 220, bottom: 420, right: 120 })
  })

  it('scales by width and rounds to whole pixels on 720 x 1280', () => {
    expect(sizes(720, 1280, 'tiktok')).toEqual({ top: 100, bottom: 293, right: 87 })
    expect(sizes(720, 1280, 'reels')).toEqual({ top: 147, bottom: 280, right: 80 })
  })

  it('on the Phone frame takes the 83 pt app bar off the bottom band', () => {
    expect(sizes(1080, 2112, 'tiktok')).toEqual({ top: 150, bottom: 212, right: 130 })
    expect(sizes(1080, 2112, 'reels')).toEqual({ top: 220, bottom: 192, right: 120 })
  })

  it('anchors to the frame edges', () => {
    const r = appGuideRegions(1080, 1920, 'tiktok')!
    expect(r.find((x) => x.key === 'top')).toMatchObject({ x: 0, y: 0, w: 1080 })
    expect(r.find((x) => x.key === 'bottom')).toMatchObject({ x: 0, y: 1920 - 440, w: 1080 })
    expect(r.find((x) => x.key === 'right')).toMatchObject({ x: 1080 - 130, y: 150, h: 1920 - 150 - 440 })
  })

  it('never overlaps: the bands and the column between them cover the frame exactly once', () => {
    for (const [w, h] of [[1080, 1920], [720, 1280], [1080, 2112]] as const) {
      for (const { key } of APP_GUIDE_APPS) {
        const r = appGuideRegions(w, h, key)!
        const area = r.reduce((n, x) => n + x.w * x.h, 0)
        const [t, b, c] = [r[0], r[1], r[2]]
        expect(t.y + t.h, `${w}x${h} ${key}`).toBeLessThanOrEqual(c.y)
        expect(c.y + c.h).toBeLessThanOrEqual(b.y)
        expect(area).toBeLessThan(w * h)
      }
    }
  })

  it('is null on a wide, square or empty frame', () => {
    expect(appGuideRegions(1920, 1080, 'tiktok')).toBeNull()
    expect(appGuideRegions(1080, 1080, 'reels')).toBeNull()
    expect(appGuideRegions(0, 0, 'reels')).toBeNull()
  })
})

describe('appGuideHiddenReason', () => {
  it('says why on a wide frame and nothing on a tall one', () => {
    expect(appGuideHiddenReason(1920, 1080)).toBe('App guides are for tall videos. Switch the shape to 9:16 or Phone to see them.')
    expect(appGuideHiddenReason(1080, 1920)).toBeNull()
    expect(appGuideHiddenReason(1080, 2112)).toBeNull()
  })

  it('has no em or en dash', () => {
    expect(appGuideHiddenReason(1, 1)).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('isTallFrame', () => {
  it('takes 9:16 and Phone, not 4:5 or 16:9', () => {
    expect(isTallFrame(1080, 1920)).toBe(true)
    expect(isTallFrame(1080, 2112)).toBe(true)
    expect(isTallFrame(1080, 1350)).toBe(false)
    expect(isTallFrame(1920, 1080)).toBe(false)
  })
})
