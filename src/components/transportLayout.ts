// How the Monitor's transport bar lays itself out at the width it has been given.
//
// ⛔ ONE ROW WAS NEVER GOING TO FIT (2026-10-03). Walking the app at 1280x720 for overlaps
// found the bar squeezed to nothing: the aspect picker and the camera pushed out of sight, the
// Preview select left as a bare arrow, and the total length half cut off. The monitor is 549px
// wide there. Clipping is not fitting: a control you cannot see is a control you cannot press.
//
// And on 2026-10-04 he asked for more on the bar (safe margins back, a labelled Loop) and less
// blank space in it (the two selects as wide as their short label). Measured at 1920x1080, where
// nothing is squeezed, the three groups are:
//
//   time       122  "0:00.00 / 0:01.97" (the stopwatch time, with the total length)
//   transport  156  five buttons, always on the exact centre of the bar (his ask, 2026-08-23)
//   tools      367  three groups, 303 of controls, two 12px gaps between groups, and 40 on the
//                   right for the full screen button pinned in the corner
//
// The one row needs equal columns either side of the transport, so it needs
// 2 x 367 + 156 + gaps and padding = 930. So the bar has three shapes, picked by the width it
// actually has:
//
//   one-row   930 and up: the bar as it always was, time, transport and tools in one 44px row.
//             That is a 1920 window with the default columns (1188). A 1600 window (868) is
//             not wide enough and takes two rows, which fit with nothing clipped.
//   two-rows  the time and the transport on the first row, still on the exact centre, and the
//             tools on a row of their own, whole and centred. Below 424px the total length is
//             dropped from the time, because two centred 122px time columns no longer fit beside
//             the transport; the time itself is never cut.
//   compact   narrower than the tools themselves (407px): the time and the transport share a
//             row, spread apart, and the tools wrap onto as many rows as they need. A 1024px
//             window with the default columns leaves 292px.
//
// A phone has its own few controls and always keeps the one row.

export type TransportTier = 'one-row' | 'two-rows' | 'compact'

/** Two columns of 367 beside the 156 transport, plus 16 of gap and 24 of padding, rounded up. */
export const ONE_ROW_MIN_PX = 930
/** The tools on their own row: 303 of controls, 24 between groups, 40 kept clear at each side. */
export const TWO_ROWS_MIN_PX = 407
/** Two centred 122px time columns beside the 156 transport, plus gaps and padding. */
export const FULL_TIMECODE_MIN_PX = 424

export function transportTier(widthPx: number, phone: boolean): TransportTier {
  // Not measured yet is the bar as it was, so the first paint never jumps.
  if (phone || !(widthPx > 0) || widthPx >= ONE_ROW_MIN_PX) return 'one-row'
  return widthPx >= TWO_ROWS_MIN_PX ? 'two-rows' : 'compact'
}

/** Does the time have room for "now / total", or only for "now"? */
export function showsTotalLength(tier: TransportTier, widthPx: number): boolean {
  if (tier === 'one-row') return true
  return tier === 'two-rows' && widthPx >= FULL_TIMECODE_MIN_PX
}

/** The bar's own classes for a tier. `relative` because the way out of full screen is pinned to its corner. */
export function barClasses(tier: TransportTier): string {
  if (tier === 'one-row') {
    return 'relative grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden border-t border-border bg-bg-panel px-3'
  }
  if (tier === 'two-rows') {
    return 'relative grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1 gap-y-1 border-t border-border bg-bg-panel px-2 pb-2 pt-1'
  }
  return 'relative flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border bg-bg-panel px-2 pb-2 pt-1'
}

/** The time group's classes. */
export function timeClasses(tier: TransportTier): string {
  return tier === 'compact'
    ? 'flex shrink-0 items-center gap-2 whitespace-nowrap'
    : 'flex min-w-0 shrink items-center gap-2 overflow-hidden whitespace-nowrap'
}

/** One group of tools: close together inside, wider apart between groups (the settings' own gap). */
export const groupClasses = 'flex shrink-0 items-center gap-1'

/**
 * The tools' classes. The 40px of padding on the right (both sides in the narrow shapes, so the
 * tools stay centred) is the corner the full screen button is pinned in: its 28px, the 8px it
 * sits in from the edge, and 4px of air.
 */
export function settingsClasses(tier: TransportTier): string {
  if (tier === 'one-row') return 'flex w-full min-w-0 items-center justify-end gap-x-3 overflow-hidden pr-10'
  if (tier === 'two-rows') return 'col-span-3 flex w-full min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-10'
  // Not centred here: at 292px the room is short by a few pixels, and keeping 40px clear on the left
  // as well would stand the camera on a row of its own.
  return 'flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 pl-2 pr-10'
}

/**
 * Where the full screen button sits: the bar's bottom right corner, 8px in from the right and 8px up
 * from the bottom, whatever shape the bar is in and the same in a window as on the full screen. 8px
 * up centres it on the single row of the wide bar, and the narrow shapes keep the same 8px of padding
 * under their last row, so it is level with the controls beside it in every one of them.
 */
export const pinnedClasses = 'absolute right-2 bottom-2'
