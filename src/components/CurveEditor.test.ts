import { describe, expect, it } from 'vitest'
import {
  CURVE_HELP,
  CUSTOM_HELP,
  EASE_HELP,
  EASE_ORDER,
  EASE_SEED,
  curveName,
  easeExplainer,
  formatCurve,
  parseCurveText,
  segmentHeader,
  velocitySamples,
} from './CurveEditor'
import { bezierEase } from '../engine/keyframes'
import { MOTION_CURVES } from '../engine/motion'

describe('curve editor helpers', () => {
  it('parses an easings.net paste', () => {
    expect(parseCurveText('0.16, 1, 0.3, 1')).toEqual([0.16, 1, 0.3, 1])
    expect(parseCurveText('cubic-bezier(0.34, 1.56, 0.64, 1)')).toEqual([0.34, 1.56, 0.64, 1])
    expect(parseCurveText(' 0.5 0 1 1 ')).toEqual([0.5, 0, 1, 1])
  })

  it('refuses anything that is not four numbers', () => {
    expect(parseCurveText('0.16, 1, 0.3')).toBeNull()
    expect(parseCurveText('0.16, 1, 0.3, 1, 2')).toBeNull()
    expect(parseCurveText('a, b, c, d')).toBeNull()
    expect(parseCurveText('')).toBeNull()
  })

  it('round-trips the motion table through the text field', () => {
    for (const c of Object.values(MOTION_CURVES)) {
      expect(parseCurveText(formatCurve(c))).toEqual([...c])
    }
  })

  it('reads the real numbers in the header', () => {
    expect(segmentHeader('scale', 1, 1.2, 5)).toBe('Zoom 100 to 120 over 5f')
    expect(segmentHeader('posX', 0, -12.5, 12)).toBe('Position X 0 to -12.5 over 12f')
  })

  it('samples 64 velocity points, normalized, front-loaded for a snap', () => {
    const v = velocitySamples((p) => bezierEase(MOTION_CURVES.snapIn, p))
    expect(v).toHaveLength(64)
    expect(Math.max(...v)).toBeCloseTo(1, 6)
    expect(v[0]).toBeGreaterThan(v[63])
  })

  it('seeds a handle pair for every named ease', () => {
    for (const seed of Object.values(EASE_SEED)) expect(seed).toHaveLength(4)
    expect(bezierEase(EASE_SEED.linear, 0.5)).toBeCloseTo(0.5, 6)
  })

  it('names the six curves back from their numbers', () => {
    for (const name of Object.keys(MOTION_CURVES) as (keyof typeof MOTION_CURVES)[]) {
      expect(curveName(MOTION_CURVES[name])).toBe(name)
    }
    expect(curveName(undefined)).toBeNull()
    expect(curveName([0.11, 0.22, 0.33, 0.44])).toBeNull()
  })

  it('explains the shape the renderer is actually running', () => {
    // No curve: the named ease, in words. This is "what is Lin".
    expect(easeExplainer(undefined, 'linear')).toMatch(/^Linear: constant speed/)
    // 'hold' is a step no bezier can express, so it has to be answerable here.
    expect(easeExplainer(undefined, 'hold')).toMatch(/^Hold: freeze on this value/)
    // A curve wins over the name, so the prose follows the curve.
    expect(easeExplainer(MOTION_CURVES.snapIn, 'linear')).toBe(CURVE_HELP.snapIn)
    expect(easeExplainer([0.11, 0.22, 0.33, 0.44], 'linear')).toBe(CUSTOM_HELP)
  })

  it('says something about every shape it offers', () => {
    for (const help of Object.values(EASE_HELP)) expect(help.length).toBeGreaterThan(20)
    for (const name of Object.keys(MOTION_CURVES) as (keyof typeof MOTION_CURVES)[]) {
      expect(CURVE_HELP[name].length).toBeGreaterThan(20)
    }
    expect(EASE_ORDER).toHaveLength(Object.keys(EASE_HELP).length)
  })
})
