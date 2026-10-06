// The colour maths of the cinematic looks, proved without a GPU.
//
// lookMath.ts writes every look twice: as shader text (what the shared renderer
// runs, in the preview and the export alike) and as plain TypeScript (`applyLook`).
// These tests pin the TypeScript. The GPU render is scored against it, pixel for
// pixel, by the proof harness, so a number that holds here holds on screen.

import { describe, expect, it } from 'vitest'
import {
  CLARITY_RADIUS,
  HUE_ONES,
  HUE_ZEROS,
  LOOK_COMMON_GLSL,
  SKIN_HUE,
  applyLook,
  bandValue,
  buildCurve,
  curveFunctionGlsl,
  evalCurve,
  frameScale,
  glf,
  grainValue,
  grainWeight,
  hash32,
  hueDeg,
  lookCompanions,
  lookGlsl,
  lookHelpers,
  luma,
  rotateHue,
  skinWeight,
  tintDir,
  type LookContext,
  type LookSpec,
  type Vec3,
} from './lookMath'
import { LOOKS } from './looks'

/** A look that does nothing at all: every stage at its neutral value. */
const NEUTRAL: LookSpec = {
  id: 'neutral',
  label: 'Neutral',
  description: 'Nothing',
  exposure: 0,
  gain: [1, 1, 1],
  curve: [
    [0, 0],
    [1, 1],
  ],
  curveMix: 0,
  saturation: 1,
  hueSat: HUE_ONES,
  hueLum: HUE_ONES,
  hueShift: HUE_ZEROS,
  satShadows: 1,
  satHighlights: 1,
  mono: 0,
  monoWeights: [0.2126, 0.7152, 0.0722],
  shadowTint: { hue: 0, strength: 0 },
  highlightTint: { hue: 0, strength: 0 },
  skinProtect: 0,
  vignette: { amount: 0, size: 0.5, feather: 0.4 },
  grain: { amount: 0, size: 1.6 },
  clarity: 0,
}

const CTX: LookContext = { x: 540.5, y: 960.5, w: 1080, h: 1920, seed: 12 }

/** A seeded generator, so the random pixels are the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Skin as his iPhone records it under gym panels: light, tanned, medium and deep, lit and shaded. */
const SKIN: Vec3[] = [
  [0.87, 0.68, 0.58],
  [0.78, 0.56, 0.45],
  [0.66, 0.45, 0.35],
  [0.55, 0.38, 0.3],
  [0.42, 0.28, 0.21],
  [0.3, 0.2, 0.15],
  [0.92, 0.76, 0.66],
]

const hueGap = (a: number, b: number): number => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
const chroma = (c: Vec3): number => Math.max(...c) - Math.min(...c)

describe('the tone curve', () => {
  it('goes through every control point and never folds back', () => {
    for (const look of LOOKS) {
      const segs = buildCurve(look.curve)
      for (const [x, y] of look.curve) expect(evalCurve(segs, x), `${look.id} at ${x}`).toBeCloseTo(y, 6)
      let prev = -1
      for (let i = 0; i <= 1000; i++) {
        const y = evalCurve(segs, i / 1000)
        expect(y, `${look.id} falls at ${i / 1000}`).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = y
      }
    }
  })

  it('never overshoots its own end points (a monotone cubic, not a plain spline)', () => {
    for (const look of LOOKS) {
      const segs = buildCurve(look.curve)
      const lo = look.curve[0][1]
      const hi = look.curve[look.curve.length - 1][1]
      for (let i = 0; i <= 200; i++) {
        const y = evalCurve(segs, i / 200)
        expect(y).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(y).toBeLessThanOrEqual(hi + 1e-9)
      }
    }
  })

  it('is the identity when it is a straight line', () => {
    const segs = buildCurve(NEUTRAL.curve)
    for (let i = 0; i <= 20; i++) expect(evalCurve(segs, i / 20)).toBeCloseTo(i / 20, 9)
  })

  it('refuses points that go backwards', () => {
    expect(() =>
      buildCurve([
        [0, 0],
        [0.5, 0.5],
        [0.4, 0.6],
        [1, 1],
      ]),
    ).toThrow()
    expect(() =>
      buildCurve([
        [0, 0.5],
        [1, 0.2],
      ]),
    ).toThrow()
  })
})

describe('hue', () => {
  it('reads the six primaries where HSV puts them', () => {
    expect(hueDeg([1, 0, 0])).toBeCloseTo(0, 6)
    expect(hueDeg([1, 1, 0])).toBeCloseTo(60, 6)
    expect(hueDeg([0, 1, 0])).toBeCloseTo(120, 6)
    expect(hueDeg([0, 1, 1])).toBeCloseTo(180, 6)
    expect(hueDeg([0, 0, 1])).toBeCloseTo(240, 6)
    expect(hueDeg([1, 0, 1])).toBeCloseTo(300, 6)
    expect(hueDeg([0.4, 0.4, 0.4])).toBe(0)
  })

  it('reads a table exactly at its nodes and wraps from magenta back to red', () => {
    const t = [1, 2, 3, 4, 5, 6, 7]
    expect(bandValue(0, t)).toBe(1)
    expect(bandValue(30, t)).toBe(2)
    expect(bandValue(60, t)).toBe(3)
    expect(bandValue(120, t)).toBe(4)
    expect(bandValue(300, t)).toBe(7)
    expect(bandValue(330, t)).toBeCloseTo(4, 9)
    expect(bandValue(359.999, t)).toBeCloseTo(1, 3)
  })

  it('turns hue the way HSV does, keeping brightness', () => {
    const green: Vec3 = [0.2, 0.8, 0.2]
    const toCyan = rotateHue(green, 30)
    expect(hueDeg(toCyan)).toBeGreaterThan(130)
    expect(hueDeg(rotateHue(green, -30))).toBeLessThan(110)
    const y = (c: Vec3): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    expect(y(toCyan)).toBeCloseTo(y(green), 6)
    const same = rotateHue(green, 0)
    for (let k = 0; k < 3; k++) expect(same[k]).toBeCloseTo(green[k], 5)
  })

  it('tints without adding light: every tint direction has zero luma', () => {
    for (let h = 0; h < 360; h += 15) expect(Math.abs(luma(tintDir(h)))).toBeLessThan(2e-6)
  })
})

describe('skin', () => {
  it('knows skin of every shade', () => {
    for (const s of SKIN) expect(skinWeight(s), `${s}`).toBeGreaterThan(0.8)
  })

  it('does not mistake grey, the blue floor, the green turf or a black shirt for skin', () => {
    for (const c of [
      [0.5, 0.5, 0.5],
      [0.25, 0.3, 0.45],
      [0.3, 0.55, 0.25],
      [0.05, 0.05, 0.06],
      [0.9, 0.9, 0.92],
    ] as Vec3[]) {
      expect(skinWeight(c), `${c}`).toBeLessThan(0.05)
    }
  })

  it('sits on the skin line', () => {
    for (const s of SKIN) expect(hueGap(hueDeg(s), SKIN_HUE)).toBeLessThan(12)
  })
})

describe('grain', () => {
  it('is the same noise every time for the same pixel and frame, and new noise next frame', () => {
    expect(hash32(10, 20, 3)).toBe(hash32(10, 20, 3))
    expect(hash32(10, 20, 3)).not.toBe(hash32(10, 20, 4))
    expect(grainValue(100.5, 200.5, 1.6, 7)).toBe(grainValue(100.5, 200.5, 1.6, 7))
  })

  it('pins the hash bits the shader reproduces in uint arithmetic', () => {
    // The GLSL olkHash is the same three multiplies and xorshifts. If either side
    // changes, the GPU and the TypeScript stop making the same grain, and the
    // proof harness's pixel match breaks. Pinned so the change is deliberate.
    expect(hash32(0, 0, 0)).toBe(0)
    expect(hash32(1, 2, 3)).toBe(1546496667)
    expect(hash32(1079, 1919, 900)).toBe(3399183810)
  })

  it('averages to nothing, so it never brightens or darkens the picture', () => {
    let sum = 0
    let min = 9
    let max = -9
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const g = grainValue(x + 0.5, y + 0.5, 1.6, 5)
        sum += g
        min = Math.min(min, g)
        max = Math.max(max, g)
      }
    }
    expect(Math.abs(sum / 40000)).toBeLessThan(0.02)
    expect(min).toBeGreaterThanOrEqual(-1)
    expect(max).toBeLessThanOrEqual(1)
  })

  it('shows most in the middle tones, as on film', () => {
    expect(grainWeight(0.5)).toBe(1)
    expect(grainWeight(0)).toBeCloseTo(0.4, 9)
    expect(grainWeight(1)).toBeCloseTo(0.4, 9)
  })

  it('is sized on the frame short side, so a phone frame and a wide frame grain alike', () => {
    expect(frameScale(1080, 1920)).toBe(1)
    expect(frameScale(1920, 1080)).toBe(1)
    expect(frameScale(2160, 3840)).toBe(2)
  })
})

describe('a look on one pixel', () => {
  it('changes nothing at all at Amount 0, for every look', () => {
    const r = rng(1)
    for (const look of LOOKS) {
      for (let i = 0; i < 200; i++) {
        const c: Vec3 = [r(), r(), r()]
        const ctx = { ...CTX, x: r() * 1080, y: r() * 1920 }
        const out = applyLook(look, c, 0, ctx)
        expect(out[0]).toBe(c[0])
        expect(out[1]).toBe(c[1])
        expect(out[2]).toBe(c[2])
      }
    }
  })

  it('hands back an over-range colour untouched at Amount 0, and only ever grades into range', () => {
    // Brightness, exposure, contrast and saturation all run before a look and can
    // push a highlight past 1. A look keyframed in from 0 must change nothing at
    // 0, or a vignette after it sees that highlight cut to 1 the instant it lands.
    const over: Vec3[] = [
      [1.15, 1.2, 1.05],
      [-0.04, 0.5, 1.3],
    ]
    for (const look of LOOKS) {
      for (const c of over) {
        expect(applyLook(look, c, 0, CTX), look.id).toEqual([...c])
        for (const v of applyLook(look, c, 1, CTX)) {
          expect(v, look.id).toBeGreaterThanOrEqual(0)
          expect(v, look.id).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('changes nothing when every stage sits at neutral, even at full Amount', () => {
    const r = rng(2)
    for (let i = 0; i < 500; i++) {
      const c: Vec3 = [r(), r(), r()]
      const out = applyLook(NEUTRAL, c, 1, CTX)
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(c[k], 6)
    }
  })

  it('goes from the original to the full look in a straight line as Amount rises', () => {
    const c: Vec3 = [0.6, 0.45, 0.3]
    for (const look of LOOKS) {
      const full = applyLook(look, c, 1, CTX)
      const half = applyLook(look, c, 0.5, CTX)
      for (let k = 0; k < 3; k++) expect(half[k]).toBeCloseTo((c[k] + full[k]) / 2, 6)
    }
  })

  it('keeps skin a skin colour in every colour look, never grey, green or blue', () => {
    for (const look of LOOKS) {
      if (look.mono > 0) continue
      for (const s of SKIN) {
        const out = applyLook(look, s, 1, CTX)
        expect(hueGap(hueDeg(out), SKIN_HUE), `${look.id} turned skin ${s} to hue ${hueDeg(out)}`).toBeLessThan(22)
        // A drained look may take some colour out of skin, never all of it.
        expect(chroma(out), `${look.id} greyed out skin ${s}`).toBeGreaterThan(chroma(s) * 0.35)
      }
    }
  })

  it('holds the tints back on skin: the skin hold is what keeps teal off his arms', () => {
    const look = LOOKS.find((l) => l.id === 'tealOrange')!
    const unheld = { ...look, skinProtect: 0 }
    const shadowSkin: Vec3 = [0.42, 0.28, 0.21]
    const held = applyLook(look, shadowSkin, 1, CTX)
    const bare = applyLook(unheld, shadowSkin, 1, CTX)
    expect(hueGap(hueDeg(held), SKIN_HUE)).toBeLessThan(hueGap(hueDeg(bare), SKIN_HUE))
  })

  it('keeps black black and white bright in every look, so nothing washes out', () => {
    for (const look of LOOKS) {
      const black = applyLook(look, [0.02, 0.02, 0.02], 1, CTX)
      const white = applyLook(look, [0.97, 0.97, 0.97], 1, CTX)
      expect(luma(black), `${look.id} lifts black to ${luma(black)}`).toBeLessThan(0.1)
      expect(luma(white), `${look.id} sinks white to ${luma(white)}`).toBeGreaterThan(0.72)
    }
  })

  it('adds contrast through the middle tones (where muscle sits) in every gym look but the soft ones', () => {
    for (const look of LOOKS) {
      if (look.id === 'softFilm' || look.id === 'goldenHour' || look.id === 'film800T') continue
      const segs = buildCurve(look.curve)
      const slope = (evalCurve(segs, 0.55) - evalCurve(segs, 0.45)) / 0.1
      expect(slope, look.id).toBeGreaterThan(1.05)
    }
  })

  it('makes black and white truly grey', () => {
    const bw = LOOKS.find((l) => l.mono === 1)!
    const out = applyLook(bw, [0.7, 0.4, 0.2], 1, { ...CTX, x: 540, y: 960 })
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9)
    expect(Math.abs(out[1] - out[2])).toBeLessThan(1e-9)
  })

  it('darkens the corners and leaves the middle alone when a look has a vignette', () => {
    const look = { ...NEUTRAL, vignette: { amount: 0.5, size: 0.4, feather: 0.3 } }
    const mid = applyLook(look, [0.5, 0.5, 0.5], 1, CTX)
    const corner = applyLook(look, [0.5, 0.5, 0.5], 1, { ...CTX, x: 1, y: 1 })
    expect(mid[0]).toBeCloseTo(0.5, 9)
    expect(corner[0]).toBeLessThan(0.3)
  })
})

describe('the passes that read neighbours', () => {
  it('are none at Amount 0', () => {
    for (const look of LOOKS) expect(lookCompanions(look, 0)).toEqual([])
  })

  it('scale with Amount, so one slider turns the glow and the clarity down too', () => {
    for (const look of LOOKS) {
      const full = lookCompanions(look, 1)
      const half = lookCompanions(look, 0.5)
      expect(half.map((c) => c.type)).toEqual(full.map((c) => c.type))
      full.forEach((c, i) => {
        const key = c.type === 'lookClarity' ? 'amount' : 'strength'
        expect(half[i].params[key]).toBeCloseTo(c.params[key] / 2, 6)
      })
    }
  })

  it('carry clarity first, then halation, then bloom, as the look asks', () => {
    const film = LOOKS.find((l) => l.id === 'film800T')!
    expect(lookCompanions(film, 1).map((c) => c.type)).toEqual(['lookGlow', 'lookGlow'])
    expect(lookCompanions(film, 1)[0].params.tintR).toBeGreaterThan(lookCompanions(film, 1)[0].params.tintB)
    const moody = LOOKS.find((l) => l.id === 'moodyGym')!
    expect(lookCompanions(moody, 1)).toEqual([{ type: 'lookClarity', params: { amount: moody.clarity, radius: CLARITY_RADIUS } }])
  })
})

describe('the shader text', () => {
  it('always writes floats with a decimal point', () => {
    expect(glf(1)).toBe('1.0')
    expect(glf(-2)).toBe('-2.0')
    expect(glf(0.5)).toBe('0.5')
    expect(glf(0.0000004)).toBe('0.0')
    expect(glf(1e-6)).toBe('0.000001')
  })

  it('balances its braces and brackets for every look', () => {
    const count = (s: string, ch: string): number => s.split(ch).length - 1
    for (const look of LOOKS) {
      const text = [...lookHelpers(look), lookGlsl(look, 'u_fx0_amount')].join('\n')
      expect(count(text, '{'), look.id).toBe(count(text, '}'))
      expect(count(text, '('), look.id).toBe(count(text, ')'))
      expect(text).not.toMatch(/NaN|undefined|Infinity/)
    }
  })

  it('carries only the stages a look uses', () => {
    const bw = LOOKS.find((l) => l.id === 'blackWhite')!
    const moody = LOOKS.find((l) => l.id === 'moodyGym')!
    expect(lookGlsl(bw, 'a')).toContain('vec3(dot(olkV')
    expect(lookGlsl(moody, 'a')).not.toContain('vec3(dot(olkV')
    expect(lookGlsl(bw, 'a')).not.toContain('olkSkin')
    expect(lookGlsl(moody, 'a')).toContain('olkSkin')
    expect(lookGlsl(NEUTRAL, 'a')).not.toContain('olkGrain')
  })

  it('shares one copy of the common helpers between looks, and names each curve after its look', () => {
    const a = lookHelpers(LOOKS[0])
    const b = lookHelpers(LOOKS[1])
    expect(a[0]).toBe(LOOK_COMMON_GLSL)
    expect(b[0]).toBe(LOOK_COMMON_GLSL)
    expect(a[1]).toContain(`olkCurve_${LOOKS[0].id}(`)
    expect(a[1]).not.toBe(b[1])
  })

  it('reads the Amount uniform it is given and nothing else', () => {
    const text = lookGlsl(LOOKS[0], 'u_fx3_amount')
    expect(text).toContain(', u_fx3_amount)')
    expect(text).not.toMatch(/u_fx\d+_(?!amount)/)
  })

  it('mixes with the colour as it arrived and clamps only the graded side, so Amount 0 is exact', () => {
    for (const look of LOOKS) {
      const lines = lookGlsl(look, 'u_fx3_amount').trim().split('\n')
      expect(lines[lines.length - 1], look.id).toBe('c = mix(c, clamp(olkV, 0.0, 1.0), u_fx3_amount);')
    }
  })

  it('writes each curve segment the evaluator uses', () => {
    const segs = buildCurve(LOOKS[0].curve)
    const text = curveFunctionGlsl('f', segs)
    expect(text.match(/return /g)).toHaveLength(segs.length)
  })
})
