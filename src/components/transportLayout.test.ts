import { describe, expect, it } from 'vitest'
import {
  FULL_TIMECODE_MIN_PX,
  ONE_ROW_MIN_PX,
  TWO_ROWS_MIN_PX,
  barClasses,
  groupClasses,
  pinnedClasses,
  settingsClasses,
  showsTotalLength,
  timeClasses,
  transportTier,
} from './transportLayout'

// The monitor's transport bar and the widths that break it (2026-10-03, again 2026-10-04 with the
// tools he asked for). 1188px is the monitor of a 1920px window with the default columns, 868px a
// 1600px window's, 548px a 1280px window's, and 292px that of the app's minimum 1024px window.

describe('transportTier', () => {
  it('keeps the one row where all three groups and the pinned corner fit, which is a 1920px window', () => {
    expect(transportTier(1188, false)).toBe('one-row')
    expect(transportTier(1500, false)).toBe('one-row')
    expect(transportTier(ONE_ROW_MIN_PX, false)).toBe('one-row')
  })

  it('moves the tools to a row of their own where one row would clip them: 1600px and 1280px windows', () => {
    expect(transportTier(ONE_ROW_MIN_PX - 1, false)).toBe('two-rows')
    expect(transportTier(868, false)).toBe('two-rows') // 1600x900, default columns
    expect(transportTier(548, false)).toBe('two-rows') // 1280x720, default columns
    expect(transportTier(TWO_ROWS_MIN_PX, false)).toBe('two-rows')
  })

  it('wraps everything below that, down to the 292px the minimum window leaves', () => {
    expect(transportTier(TWO_ROWS_MIN_PX - 1, false)).toBe('compact')
    expect(transportTier(292, false)).toBe('compact')
  })

  it('never reshapes a phone, which has its own few controls, or a bar not measured yet', () => {
    expect(transportTier(300, true)).toBe('one-row')
    expect(transportTier(0, false)).toBe('one-row')
    expect(transportTier(Number.NaN, false)).toBe('one-row')
  })
})

describe('showsTotalLength', () => {
  it('shows "now / total" where the centred time column has the 180px it needs', () => {
    expect(showsTotalLength('one-row', 1188)).toBe(true)
    expect(showsTotalLength('two-rows', 548)).toBe(true) // the 1280px window keeps its total
    expect(showsTotalLength('two-rows', FULL_TIMECODE_MIN_PX)).toBe(true)
  })

  it('drops the total, never the time, where it does not', () => {
    expect(showsTotalLength('two-rows', FULL_TIMECODE_MIN_PX - 1)).toBe(false)
    expect(showsTotalLength('compact', 300)).toBe(false)
    // The tools need a bit less room than the full time does, so the total goes first.
    expect(TWO_ROWS_MIN_PX).toBeLessThan(FULL_TIMECODE_MIN_PX)
  })
})

describe('the classes of each shape', () => {
  it('leaves the wide bar as it was: a 44px grid of 1fr, auto, 1fr that clips instead of spilling', () => {
    const wide = barClasses('one-row')
    expect(wide).toContain('h-11')
    expect(wide).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]')
    expect(wide).toContain('overflow-hidden')
    expect(settingsClasses('one-row')).toContain('justify-end')
    expect(settingsClasses('one-row')).toContain('overflow-hidden')
  })

  it('lets the narrow shapes grow in height and clip nothing', () => {
    for (const tier of ['two-rows', 'compact'] as const) {
      expect(barClasses(tier)).not.toContain('h-11')
      expect(barClasses(tier)).not.toContain('overflow-hidden')
      expect(settingsClasses(tier)).not.toContain('overflow-hidden')
      expect(settingsClasses(tier)).toContain('flex-wrap')
      expect(settingsClasses(tier)).toContain('justify-center')
    }
  })

  it('keeps Play on the centre in two rows, by the same three columns, and drops that in the compact bar', () => {
    expect(barClasses('two-rows')).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]')
    expect(settingsClasses('two-rows')).toContain('col-span-3')
    expect(barClasses('compact')).toContain('flex-wrap')
    expect(timeClasses('compact')).toContain('shrink-0')
  })

  it('pins the way out of full screen to the bar corner in every shape, and keeps the tools clear of it', () => {
    // The corner is the bar's, whatever shape the bar is in, so every bar is the pin's container...
    for (const tier of ['one-row', 'two-rows', 'compact'] as const) {
      expect(barClasses(tier).split(' ')).toContain('relative')
      expect(pinnedClasses).toBe('absolute right-2 bottom-2')
      // Eight up from the bottom in all of them: 44px of bar centred, or 8px of padding under the last row.
      expect(barClasses(tier)).toMatch(tier === 'one-row' ? /h-11/ : /pb-2/)
    }
    // ...and the tools hold 40px back from it: its 28px, its 8px inset and 4px of air.
    expect(settingsClasses('one-row')).toContain('pr-10')
    expect(settingsClasses('two-rows')).toContain('px-10')
    expect(settingsClasses('compact')).toContain('pr-10')
  })

  it('puts a little more room between the tool groups than inside one', () => {
    expect(groupClasses).toContain('gap-1')
    expect(settingsClasses('one-row')).toContain('gap-x-3')
  })
})
