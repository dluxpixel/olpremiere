// The frame shapes the monitor's picker offers, and which one a sequence IS. Pure, kept out of
// Monitor.tsx so the table and the matching rule are unit-testable without the React stack.

import type { CompactOption } from '../ui/CompactSelect'

/**
 * Aspect presets. Switching one reformats the sequence AND scales clips to fill (setActiveSequenceFormat).
 *
 * ⛔ `9:16 Shorts` STAYS EXACTLY AS IT WAS. Old projects are saved at 1080x1920 and YouTube Shorts wants
 * exactly that, so the new phone shape is an addition after it, never a replacement.
 *
 * ⛔ PHONE IS 1080 x 2112, AND THE NUMBER IS MEASURED, NOT PICKED (his ask, 2026-10-05: "find the exact
 * ratio of TikTok and Instagram because they use both the same one, and just give me that").
 * He posts from an iPhone, whose screen is 1179 x 2556 px. TikTok and Reels play a video in the screen
 * minus the 83 pt bottom bar, which is 1179 x 2307 device px, a ratio of 0.5111. A 1080x1920 file
 * (0.5625) is taller than that and wider than the area, so TikTok shrinks some of them with black above
 * and below and zooms others to fill, per video, on its own. Both kinds are STORED at exactly 576x1024,
 * so the file's size is not what it reacts to, its SHAPE is. A video that is exactly the area's shape
 * fills it whether the app fits it or fills it. In 1080 wide that is 2113.3 tall. 2112 is the nearest
 * height that is a whole number of 16 pixel rows (132 of them, which H.264 likes, and it is even, which
 * yuv420p needs), at a ratio of 0.51136, under a tenth of a percent off the measured one. Across
 * current iPhones the area runs 0.504 to 0.5125, so one shape serves them all.
 */
export const FORMATS = [
  { key: '16:9', short: '16:9', label: '16:9 Wide', w: 1920, h: 1080 },
  { key: '9:16', short: '9:16', label: '9:16 Shorts', w: 1080, h: 1920 },
  { key: 'phone', short: 'Phone', label: 'Phone screen: TikTok and Reels', w: 1080, h: 2112 },
  { key: '1:1', short: '1:1', label: '1:1 Square', w: 1080, h: 1080 },
] as const

/** Shown when the sequence is a shape no preset covers. Never selectable. */
export const CUSTOM_FORMAT_KEY = '__custom'

/** The closed select says "9:16" or "Phone"; the list says "9:16 Shorts" or "Phone screen: TikTok and Reels" (CompactSelect). */
export const FORMAT_OPTIONS: readonly CompactOption[] = FORMATS.map((f) => ({ value: f.key, short: f.short, long: f.label }))

/**
 * Which preset this sequence IS, by its actual shape.
 *
 * ⛔ IT USED TO ASK WHETHER h > w, WHICH IS NOT A RATIO. Any tall sequence that
 * was not exactly 9:16 read back as "9:16 Shorts": a 4:5 project showed the
 * wrong label in the one control that tells him what he is exporting, and
 * touching anything else in the row would have snapped it to a real 9:16.
 */
export function aspectKeyFor(w: number, h: number): string {
  if (!(w > 0) || !(h > 0)) return CUSTOM_FORMAT_KEY
  const a = w / h
  const hit = FORMATS.find((f) => Math.abs(f.w / f.h - a) < 1e-4)
  return hit ? hit.key : CUSTOM_FORMAT_KEY
}
