// Where TikTok and Instagram Reels cover the picture with their own buttons and words, so a
// short can be framed to stay clear of them. His ask, 2026-10-08: *"TikTok and Reels guides"*.
//
// Guides only. They are drawn over the preview (components/AppGuidesOverlay.tsx) and are never
// in the export.
//
// ⚠️ THE NUMBERS ARE ESTIMATES, AND SAY SO. TikTok publishes no pixel margins, only overlay
// files to look at. The figures below are the middle of what third parties measure on a
// 1080 x 1920 frame (poster.ly 160 top, 480 bottom, 120 right; thebrief.ai 130 top, 440 bottom;
// adnabu 160 top, 440 bottom; spilno 130 top, 480 bottom, 140 right). Meta's own Reels ad margins
// (14% top, 35% bottom, 6% right, which is 269, 672 and 65 px) are keep-clear margins for
// advertisers, wider than what the buttons actually cover, so they are not used here.
//
// Everything is anchored to the frame's edges and scaled by width, so a 720 x 1280 file gets the
// same guides at two thirds the size, rounded to whole pixels.

/** The two apps the guides can show. */
export type AppGuideApp = 'tiktok' | 'reels'

export const APP_GUIDE_APPS: readonly { key: AppGuideApp; label: string }[] = [
  { key: 'tiktok', label: 'TikTok' },
  { key: 'reels', label: 'Reels' },
]

/** How much of a 1080 x 1920 frame each app covers, in pixels, from the top, bottom and right edge. */
const MARGINS_1080 = {
  tiktok: { top: 150, bottom: 440, right: 130 },
  reels: { top: 220, bottom: 420, right: 120 },
} as const

/**
 * The Phone shape (1080 x 2112) stops where the app's 83 pt bottom bar begins, while the
 * published bottom margins are measured from the bottom of the screen. So the part of the
 * bottom margin that lies below the Phone frame is taken off: 83 pt * (1080 / 393 pt) = 228 px.
 */
const PHONE_BAR_1080 = 228
const PHONE_ASPECT = 1080 / 2112

/** Tall means 9:16 (0.5625) or Phone (0.5114) and anything between; a wide or square frame has no phone around it. */
const TALL_MIN = 0.5
const TALL_MAX = 0.62

/** Is this frame a tall one these guides make sense on? */
export function isTallFrame(w: number, h: number): boolean {
  if (!(w > 0) || !(h > 0)) return false
  const a = w / h
  return a >= TALL_MIN && a <= TALL_MAX
}

/** A rectangle on the frame, in the frame's own pixels. */
export interface GuideRegion {
  key: 'top' | 'bottom' | 'right'
  x: number
  y: number
  w: number
  h: number
  /** What the app puts there, in plain words. */
  label: string
}

/**
 * The three places the app covers: the band along the top, the band along the bottom and the
 * column of buttons down the right between them. They do not overlap. Null when the frame is
 * not tall, since the guides would mean nothing there.
 */
export function appGuideRegions(w: number, h: number, app: AppGuideApp): GuideRegion[] | null {
  if (!isTallFrame(w, h)) return null
  const k = w / 1080
  const m = MARGINS_1080[app]
  const phone = Math.abs(w / h - PHONE_ASPECT) < 1e-3
  const top = Math.round(m.top * k)
  const bottom = Math.round((phone ? m.bottom - PHONE_BAR_1080 : m.bottom) * k)
  const right = Math.round(m.right * k)
  return [
    { key: 'top', x: 0, y: 0, w, h: top, label: 'Top bar' },
    { key: 'bottom', x: 0, y: h - bottom, w, h: bottom, label: 'Caption and sound' },
    { key: 'right', x: w - right, y: top, w: right, h: h - top - bottom, label: 'Buttons' },
  ]
}

/** Why the guides are not on screen right now, for the button's tooltip; null when they are fine to show. */
export function appGuideHiddenReason(w: number, h: number): string | null {
  return isTallFrame(w, h) ? null : 'App guides are for tall videos. Switch the shape to 9:16 or Phone to see them.'
}
