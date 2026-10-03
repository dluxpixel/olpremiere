import { describe, expect, it } from 'vitest'

import {
  ampToDb,
  dbToFrac,
  METER_IDLE,
  METER_TICKS_DB,
  meterGradient,
  PEAK_HOLD_MS,
  stepMeter,
} from './levelMeter'

// ⛔ MIC-3, 2026-09-30. The old bar was full at -2.4 dBFS and always green, so a
// take that clipped looked the same as a good one. 5 of his 65 takes touched
// full scale. The meter reads in dBFS now.

const amp = (db: number) => 10 ** (db / 20)

describe('the scale', () => {
  it('runs -60 to 0 dBFS, with marks at -18, -12, -6 and 0', () => {
    expect(METER_TICKS_DB).toEqual([-18, -12, -6, 0])
    expect(dbToFrac(-60)).toBe(0)
    expect(dbToFrac(-90)).toBe(0)
    expect(dbToFrac(-Infinity)).toBe(0)
    expect(dbToFrac(-30)).toBeCloseTo(0.5, 9)
    expect(dbToFrac(0)).toBe(1)
  })

  it('is not full until full scale: -2.4 dBFS, where the old bar ran out, is 96%', () => {
    expect(dbToFrac(ampToDb(amp(-2.4)))).toBeCloseTo(0.96, 9)
  })

  it('green under -12, amber to -3, red above, in the app’s own colours', () => {
    const g = meterGradient()
    expect(g).toContain('var(--color-success) 0%, var(--color-success) 80%')
    expect(g).toContain('var(--color-warning) 80%, var(--color-warning) 95%')
    expect(g).toContain('var(--color-danger) 95%, var(--color-danger) 100%')
  })
})

describe('the ballistics', () => {
  it('the bar jumps to a peak at once and falls back at 20 dB a second', () => {
    let st = stepMeter(METER_IDLE, amp(-6), 1000)
    expect(st.barDb).toBeCloseTo(-6, 9)
    st = stepMeter(st, 0, 1500)
    expect(st.barDb).toBeCloseTo(-16, 9)
  })

  it('the peak line holds 1.5 s, then lets go to where the bar is', () => {
    let st = stepMeter(METER_IDLE, amp(-3), 0)
    st = stepMeter(st, amp(-20), 1000)
    expect(st.holdDb).toBeCloseTo(-3, 9)
    st = stepMeter(st, amp(-20), PEAK_HOLD_MS)
    expect(st.holdDb).toBeCloseTo(-3, 9)
    st = stepMeter(st, amp(-20), PEAK_HOLD_MS + 20)
    expect(st.holdDb).toBeCloseTo(st.barDb, 9)
    expect(st.holdDb).toBeLessThan(-3)
  })

  it('a higher peak takes the line straight up and restarts the hold', () => {
    let st = stepMeter(METER_IDLE, amp(-12), 0)
    st = stepMeter(st, amp(-1), 700)
    expect(st.holdDb).toBeCloseTo(-1, 9)
    expect(st.holdAtMs).toBe(700)
  })
})
