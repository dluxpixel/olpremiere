// The maths behind the cinematic looks, written ONCE in two forms that must agree:
//
//   1. `lookGlsl` / `LOOK_COMMON_GLSL` / `curveFunctionGlsl` build the fragment
//      shader text the shared WebGL renderer runs. That renderer is the only thing
//      that draws, in the preview AND in the export, so the two cannot disagree.
//   2. `applyLook` is the same maths in plain TypeScript. It exists so the colour
//      maths can be unit tested without a GPU, and so a GPU render can be scored
//      against a second, independent implementation of the same numbers.
//
// Pure: no GL, no DOM, no store.
//
// WHAT `c` IS. Same as every effect in registry.ts: sRGB ENCODED, 0..1, NOT
// linear light. A look is one pass of per pixel colour work in that space, so it
// behaves the way a grade in any editor does.
//
// THE COLOUR PASS, in the order it runs (each stage is left out of the shader
// text, and skipped in `applyLook`, when the look leaves it at its neutral value):
//
//   white balance + exposure  ->  tone curve  ->  (find the skin)  ->
//   saturation (global, per hue, shadows and highlights)  ->  brightness per
//   hue  ->  hue shift  ->  black and white  ->  split toning  ->  vignette  ->
//   grain (here only in a look without clarity, see below)  ->  mix with the
//   original by the Amount slider
//
// SKIN IS FOUND ONCE, right after the curve, on colours the look has not drained
// yet, and that one weight holds back both the shadow and highlight draining and
// the split tones. Finding it later would miss exactly the skin a drained look
// has already greyed (the shadow side of an arm), which is the skin that most
// needs holding.
//
// The Amount slider is the last step: result = original + (graded - original) * amount,
// where the original is the colour as it ARRIVED, never clamped, so Amount 0 hands
// back exactly what came in. Because the vignette and the grain are INSIDE the graded
// picture, one slider turns the whole look up and down, not just its colour.
//
// Three parts of a look cannot be done one pixel at a time, because they read the
// pixels around it: CLARITY (local contrast, the thing that makes muscle lines
// read), HALATION (the red glow film gets round bright lights) and BLOOM (a soft
// overall glow). Those run as their own passes after the colour pass, in the same
// shared renderer, and `lookCompanions` says which and how strong.
//
// ⛔ A LOOK WITH CLARITY ADDS ITS GRAIN IN THE CLARITY PASS, AFTER THE DETAIL, not
// in the colour pass (`grainAfterClarity`). Clarity's detail band (about 16 px)
// holds the whole of a 1.6 to 1.8 px grain, so grain laid down before it came out
// sharpened: up to about 1.5x the grain asked for in Gritty's midtones and 1.35x
// in Moody Gym's, and `applyLook` could not see it. Film grain sits on the finished
// picture, so it goes on last. A look without clarity keeps it in the colour pass,
// where nothing after it reads neighbours to sharpen it.

/** RGB triple, 0..1 encoded. */
export type Vec3 = readonly [number, number, number]

/** A control point on the tone curve: encoded input, encoded output. */
export type CurvePoint = readonly [number, number]

/** Hue nodes the per hue tables are read at, in degrees (HSV hue, red = 0). */
export const HUE_NODES = [0, 30, 60, 120, 180, 240, 300] as const
export const HUE_BANDS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const

/** A per hue table: one number per entry of HUE_BANDS. */
export type HueTable = readonly [number, number, number, number, number, number, number]

/** Every band at 1: a per hue multiplier that changes nothing. */
export const HUE_ONES: HueTable = [1, 1, 1, 1, 1, 1, 1]
/** Every band at 0: a per hue shift that changes nothing. */
export const HUE_ZEROS: HueTable = [0, 0, 0, 0, 0, 0, 0]

/**
 * Light that bleeds or glows around bright areas, run by the renderer as its own
 * blur pass AFTER the colour pass (it has to read the neighbours, which a per
 * pixel colour pass cannot).
 */
export interface GlowSpec {
  /**
   * Spread, as a fraction of the frame's SHORT side, so it looks the same at any
   * shape and at any size up to the renderer's blur cap (lookGlowFbo says where).
   */
  radius: number
  /** Encoded luma above which a pixel starts to glow. */
  threshold: number
  /** How wide the ramp from nothing to full glow is, in encoded luma. */
  softness: number
  /** Colour of the glow, a multiplier per channel in light. */
  tint: Vec3
  /** Glow brightness, before the look's Amount. */
  strength: number
  /** 0 = the glow keeps the colour of what it comes from, 1 = it takes only the tint. */
  lumaTint: number
}

export interface TintSpec {
  /** HSV hue in degrees the tone is pushed toward. */
  hue: number
  /** How hard. 0.05 is clearly visible, 0.12 is a strong cast. */
  strength: number
}

export interface LookSpec {
  /** Slug, camelCase. The effect type is `look` + this with a capital first letter. */
  id: string
  label: string
  description: string

  /** Stops, applied after the white balance. */
  exposure: number
  /** Per channel gain, the white balance nudge. [1,1,1] leaves it alone. */
  gain: Vec3
  /** Master tone curve, sorted by x, first x 0 and last x 1. */
  curve: readonly CurvePoint[]
  /** 0 = the curve moves brightness only (colours stay true), 1 = per channel (film like, colours shift). */
  curveMix: number

  /** Global saturation multiplier. 1 leaves it alone. */
  saturation: number
  /** Saturation multiplier at each of HUE_NODES. */
  hueSat: HueTable
  /** Brightness multiplier at each of HUE_NODES, only on coloured pixels (greys never move). */
  hueLum: HueTable
  /** Degrees each of HUE_NODES is turned by. Positive moves red toward yellow, green toward cyan. */
  hueShift: HueTable
  /** Saturation multiplier deep in the shadows. */
  satShadows: number
  /** Saturation multiplier in the brightest highlights. */
  satHighlights: number

  /** 0..1 black and white. */
  mono: number
  /** How red, green and blue feed the black and white picture (like a colour filter on a B&W lens). */
  monoWeights: Vec3

  shadowTint: TintSpec
  highlightTint: TintSpec
  /** 0..1: how much of the split tones, and of the shadow and highlight draining, is held back on skin. */
  skinProtect: number

  /** Darkening toward the frame's edges. Distances are in frame halves: 0.5 is the middle of an edge. */
  vignette: { amount: number; size: number; feather: number }
  /** Amount is the peak size of the noise, `size` the grain in frame pixels on a 1080 short side. */
  grain: { amount: number; size: number }

  /** Local contrast boost (the muscle definition pass), 0 = off. */
  clarity: number
  /** Red glow round bright lights, the film look. Optional. */
  halation?: GlowSpec
  /** Soft overall glow. Optional. */
  bloom?: GlowSpec
}

/** Rec.709 luma, the weights every other effect in the app uses. */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722]
export const luma = (c: Vec3): number => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Round to the 6 decimals the shader text carries, so the TS mirror reads the SAME numbers. */
export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6

// ---------------------------------------------------------------------------
// Tone curve: a monotone cubic through the control points (Fritsch-Carlson), so
// an S curve can never overshoot or fold back on itself.

export interface CurveSegment {
  x0: number
  x1: number
  y0: number
  y1: number
  /** Slopes (dy/dx) at the two ends. */
  m0: number
  m1: number
}

export function buildCurve(points: readonly CurvePoint[]): CurveSegment[] {
  const n = points.length
  if (n < 2) throw new Error('A tone curve needs at least two points')
  const xs = points.map((p) => r6(p[0]))
  const ys = points.map((p) => r6(p[1]))
  for (let i = 1; i < n; i++) if (xs[i] <= xs[i - 1]) throw new Error('Tone curve x values must increase')
  for (let i = 1; i < n; i++) if (ys[i] < ys[i - 1]) throw new Error('Tone curve y values must not fall')
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const m: number[] = new Array<number>(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  // Fritsch-Carlson limiter: no segment may have end slopes more than 3x its secant.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[i] = tau * a * d[i]
      m[i + 1] = tau * b * d[i]
    }
  }
  const segs: CurveSegment[] = []
  for (let i = 0; i < n - 1; i++) {
    segs.push({ x0: xs[i], x1: xs[i + 1], y0: ys[i], y1: ys[i + 1], m0: r6(m[i]), m1: r6(m[i + 1]) })
  }
  return segs
}

/** Evaluate a built curve. Input is clamped to 0..1, like the shader does. */
export function evalCurve(segs: readonly CurveSegment[], xIn: number): number {
  const x = clamp01(xIn)
  let s = segs[segs.length - 1]
  for (let i = 0; i < segs.length - 1; i++) {
    if (x < segs[i].x1) {
      s = segs[i]
      break
    }
  }
  const h = s.x1 - s.x0
  const t = (x - s.x0) / h
  const t2 = t * t
  const t3 = t2 * t
  return (
    (2 * t3 - 3 * t2 + 1) * s.y0 +
    (t3 - 2 * t2 + t) * h * s.m0 +
    (-2 * t3 + 3 * t2) * s.y1 +
    (t3 - t2) * h * s.m1
  )
}

// ---------------------------------------------------------------------------
// Hue helpers.

/** HSV like hue of an encoded colour, degrees in [0, 360). Greys have no hue and read 0. */
export function hueDeg(c: Vec3): number {
  const x = 2 * c[0] - c[1] - c[2]
  const y = Math.sqrt(3) * (c[1] - c[2])
  if (Math.abs(x) + Math.abs(y) < 1e-6) return 0
  const h = (Math.atan2(y, x) * 180) / Math.PI
  return h < 0 ? h + 360 : h
}

/** Read a 7 entry per hue table at hue `h`, smoothly between the nodes (wrapping at red). */
export function bandValue(h: number, v: readonly number[]): number {
  const nodes = HUE_NODES
  for (let i = 0; i < 7; i++) {
    const lo = nodes[i]
    const hi = i === 6 ? 360 : nodes[i + 1]
    if (h < hi || i === 6) {
      const t = clamp01((h - lo) / (hi - lo))
      const s = t * t * (3 - 2 * t)
      return mix(v[i], v[(i + 1) % 7], s)
    }
  }
  return v[0]
}

/**
 * Centre of the skin hue band, degrees. Skin of every colour sits on one line
 * between red and yellow (the vectorscope skin line), which reads about 20 on this
 * hue scale; measured skin runs from about 8 to 38. So the band is full strength
 * within 10 of 20 and gone by 26 away.
 */
export const SKIN_HUE = 20
export const SKIN_FULL = 10
export const SKIN_EDGE = 26

/** 0..1: how much this colour reads as skin. Needs both the right hue and some colour. */
export function skinWeight(c: Vec3): number {
  const mx = Math.max(c[0], c[1], c[2])
  const mn = Math.min(c[0], c[1], c[2])
  const h = hueDeg(c)
  const d = Math.abs(((((h - SKIN_HUE + 180) % 360) + 360) % 360) - 180)
  return (1 - smoothstep(SKIN_FULL, SKIN_EDGE, d)) * smoothstep(0.03, 0.12, mx - mn)
}

/** A colour direction with no brightness in it, for a hue: what a tint adds, so it moves colour and not light. */
export function tintDir(hue: number): Vec3 {
  const r = hsvChannel(hue, 0)
  const g = hsvChannel(hue, 120)
  const b = hsvChannel(hue, 240)
  const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  return [r6(r - l), r6(g - l), r6(b - l)]
}

/** One channel of an HSV colour at full saturation and value: a trapezoid of the hue. */
function hsvChannel(hue: number, offset: number): number {
  const d = Math.abs(((((hue - offset + 180) % 360) + 360) % 360) - 180)
  return clamp01(2 - d / 60)
}

/**
 * Turn the hue by `deg` around the grey axis, keeping brightness (a YIQ rotation).
 * The way back from YIQ is the exact inverse of the way in (worked out, not the
 * rounded textbook numbers), so a turn of 0 hands back the very colour it got.
 * Positive degrees move a colour the same way positive HSV hue does: red toward
 * yellow, green toward cyan, blue toward magenta.
 */
export function rotateHue(c: Vec3, deg: number): Vec3 {
  const a = (-deg * Math.PI) / 180
  const cs = Math.cos(a)
  const sn = Math.sin(a)
  const Y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  const I = 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2]
  const Q = 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2]
  const I2 = I * cs - Q * sn
  const Q2 = I * sn + Q * cs
  return [Y + 0.956171 * I2 + 0.621433 * Q2, Y - 0.272689 * I2 - 0.646813 * Q2, Y - 1.103744 * I2 + 1.700623 * Q2]
}

// ---------------------------------------------------------------------------
// Grain: an integer hash, so the TypeScript mirror and every GPU make the SAME noise.

/** 32 bit hash of a grid cell and a frame seed. Same bits as the GLSL `uint` arithmetic. */
export function hash32(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 1597334677) ^ Math.imul(y | 0, 1274126177) ^ Math.imul(seed | 0, 2654435761)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h
}

const rand01 = (x: number, y: number, seed: number): number => hash32(x, y, seed) / 4294967296

/** Smooth value noise at grid position (px, py): 0..1, with the 3x^2 - 2x^3 blend. */
export function valueNoise(px: number, py: number, seed: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  let fx = px - ix
  let fy = py - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = rand01(ix, iy, seed)
  const b = rand01(ix + 1, iy, seed)
  const c = rand01(ix, iy + 1, seed)
  const d = rand01(ix + 1, iy + 1, seed)
  return mix(mix(a, b, fx), mix(c, d, fx), fy)
}

/** Grain value in about -1..1 for a frame position, two sizes blended so it reads as film and not as TV static. */
export function grainValue(xPx: number, yPx: number, sizePx: number, seed: number): number {
  const big = valueNoise(xPx / sizePx, yPx / sizePx, seed)
  const fine = valueNoise(xPx / (sizePx * 0.5) + 17.25, yPx / (sizePx * 0.5) + 17.25, seed + 1)
  return (0.62 * big + 0.38 * fine - 0.5) * 2
}

/** Grain shows most in the middle of the tone range and least in pure black and pure white, as on film. */
export const grainWeight = (l: number): number => mix(0.4, 1, 4 * l * (1 - l))

/**
 * A look's grain on one encoded pixel, NOT clamped: `amount` is the peak size of
 * the noise and `size` the grain in frame pixels on a 1080 short side. The same
 * noise, size and tone weighting wherever it is added: by the colour pass, or
 * last of all by the clarity pass (which clamps after), see `grainAfterClarity`.
 */
export function addGrain(v: Vec3, amount: number, size: number, ctx: LookContext): Vec3 {
  const s = Math.max(r6(size), 0.5) * frameScale(ctx.w, ctx.h)
  const g = grainValue(ctx.x, ctx.y, s, Math.max(Math.floor(ctx.seed), 0))
  const k = g * r6(amount) * 0.3 * grainWeight(clamp01(luma(v)))
  return [v[0] + k, v[1] + k, v[2] + k]
}

// ---------------------------------------------------------------------------
// The look itself, in TypeScript.

/** Where a pixel sits in the frame, for the parts of a look that depend on position. */
export interface LookContext {
  /** Pixel CENTRE in sequence pixels, y down (so the first pixel is 0.5, 0.5). */
  x: number
  y: number
  /** Sequence size. */
  w: number
  h: number
  /** The resolver's frame number: the grain moves each frame. */
  seed: number
}

/** White balance gain and exposure folded into one multiplier per channel. */
export function gainFactors(spec: LookSpec): Vec3 {
  const ev = Math.pow(2, r6(spec.exposure))
  return [r6(r6(spec.gain[0]) * ev), r6(r6(spec.gain[1]) * ev), r6(r6(spec.gain[2]) * ev)]
}

const isOne = (v: readonly number[]): boolean => v.every((x) => x === 1)
const isZero = (v: readonly number[]): boolean => v.every((x) => x === 0)

/** Which stages a look actually uses, so the shader only carries the ones it needs. */
export function lookStages(spec: LookSpec): {
  hueSat: boolean
  hueLum: boolean
  hueShift: boolean
  needsHue: boolean
  tints: boolean
  skin: boolean
} {
  const hueSat = !isOne(spec.hueSat)
  const hueLum = !isOne(spec.hueLum)
  const hueShift = !isZero(spec.hueShift)
  const tints = spec.shadowTint.strength !== 0 || spec.highlightTint.strength !== 0
  const zoneSat = spec.satShadows !== 1 || spec.satHighlights !== 1
  return { hueSat, hueLum, hueShift, needsHue: hueSat || hueLum || hueShift, tints, skin: spec.skinProtect > 0 && (tints || zoneSat) }
}

/**
 * True when the look's grain goes on in its clarity pass, after the detail, and
 * not in its colour pass: clarity would sharpen grain laid down before it (see the
 * header). Fixed per look, never per Amount, because the colour pass's shader is
 * compiled per stack shape and its text cannot change with a slider.
 */
export const grainAfterClarity = (spec: LookSpec): boolean => spec.clarity > 0 && spec.grain.amount > 0

const curveCache = new WeakMap<LookSpec, CurveSegment[]>()
function curveOf(spec: LookSpec): CurveSegment[] {
  let segs = curveCache.get(spec)
  if (!segs) {
    segs = buildCurve(spec.curve)
    curveCache.set(spec, segs)
  }
  return segs
}

/** The frame's short side over 1080: how much bigger grain and glows get on a bigger frame. */
export const frameScale = (w: number, h: number): number => Math.max(Math.min(w, h), 1) / 1080

/** The colour pass of a look on one encoded pixel. Mirrors `lookGlsl` line for line. */
export function applyLook(spec: LookSpec, rgb: Vec3, amount: number, ctx: LookContext): Vec3 {
  const segs = curveOf(spec)
  const st = lookStages(spec)
  const c0: Vec3 = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])]
  let v: [number, number, number] = [c0[0], c0[1], c0[2]]

  // White balance and exposure.
  const gk = gainFactors(spec)
  v = [v[0] * gk[0], v[1] * gk[1], v[2] * gk[2]]

  // Tone curve.
  {
    const l0 = luma(v)
    const shift = evalCurve(segs, l0) - l0
    const lumaOnly: Vec3 = [v[0] + shift, v[1] + shift, v[2] + shift]
    const perChannel: Vec3 = [evalCurve(segs, v[0]), evalCurve(segs, v[1]), evalCurve(segs, v[2])]
    const m = r6(spec.curveMix)
    v = [
      clamp01(mix(lumaOnly[0], perChannel[0], m)),
      clamp01(mix(lumaOnly[1], perChannel[1], m)),
      clamp01(mix(lumaOnly[2], perChannel[2], m)),
    ]
  }

  // Skin, found once on the colours as the curve left them.
  const hold = st.skin ? r6(spec.skinProtect) * skinWeight(v) : 0

  // Saturation. The shadow and highlight draining is held back on skin.
  const hue = st.needsHue ? hueDeg(v) : 0
  {
    const l1 = luma(v)
    const sm = st.hueSat ? bandValue(hue, spec.hueSat.map(r6)) : 1
    const lw = mix(
      mix(r6(spec.satShadows), 1, smoothstep(0, 0.3, l1)) * mix(1, r6(spec.satHighlights), smoothstep(0.65, 1, l1)),
      1,
      hold,
    )
    const s = r6(spec.saturation) * sm * lw
    v = [l1 + (v[0] - l1) * s, l1 + (v[1] - l1) * s, l1 + (v[2] - l1) * s]
  }

  // Brightness per hue, only where there is colour to read a hue from.
  if (st.hueLum) {
    const k = bandValue(hue, spec.hueLum.map(r6))
    const ch = Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2])
    const f = 1 + (k - 1) * smoothstep(0.04, 0.2, ch)
    v = [v[0] * f, v[1] * f, v[2] * f]
  }

  // Hue shift.
  if (st.hueShift) {
    const r = rotateHue(v, bandValue(hue, spec.hueShift.map(r6)))
    v = [r[0], r[1], r[2]]
  }

  // Black and white.
  if (spec.mono > 0) {
    const w = spec.monoWeights.map(r6)
    const g = v[0] * w[0] + v[1] * w[1] + v[2] * w[2]
    const m = r6(spec.mono)
    v = [mix(v[0], g, m), mix(v[1], g, m), mix(v[2], g, m)]
  }

  // Split toning, held back on skin.
  if (st.tints) {
    const l2 = luma(v)
    const wS = (1 - smoothstep(0, 0.6, l2)) * (1 - hold)
    const wH = smoothstep(0.4, 1, l2) * (1 - hold)
    const ds = tintDir(spec.shadowTint.hue)
    const dh = tintDir(spec.highlightTint.hue)
    const ss = r6(spec.shadowTint.strength)
    const hs = r6(spec.highlightTint.strength)
    v = [
      v[0] + ds[0] * ss * wS + dh[0] * hs * wH,
      v[1] + ds[1] * ss * wS + dh[1] * hs * wH,
      v[2] + ds[2] * ss * wS + dh[2] * hs * wH,
    ]
  }

  // Vignette, measured on the FRAME (so a punch in zoom never moves it), shaped like the frame.
  if (spec.vignette.amount > 0) {
    const px = ctx.x / ctx.w - 0.5
    const py = ctx.y / ctx.h - 0.5
    const d = Math.sqrt(px * px + py * py)
    const size = r6(spec.vignette.size)
    const m = smoothstep(size, size + Math.max(r6(spec.vignette.feather), 0.001), d)
    const k = 1 - r6(spec.vignette.amount) * m
    v = [v[0] * k, v[1] * k, v[2] * k]
  }

  // Grain, on the frame too, so it is the film's grain and not the picture's. A
  // look with clarity adds it in the clarity pass instead (grainAfterClarity).
  if (spec.grain.amount > 0 && !grainAfterClarity(spec)) {
    const g = addGrain(v, spec.grain.amount, spec.grain.size, ctx)
    v = [g[0], g[1], g[2]]
  }

  // Mixed with the colour as it ARRIVED (rgb, not c0) and not clamped after, the
  // same as the shader: Amount 0 hands back exactly what came in, over-range too.
  // The Amount itself is held to 0..1, as lookCompanions holds it: a keyframe
  // ease that overshoots (a snap) must not push the look past full or below off.
  const graded: Vec3 = [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])]
  const a = clamp01(amount)
  return [mix(rgb[0], graded[0], a), mix(rgb[1], graded[1], a), mix(rgb[2], graded[2], a)]
}

// ---------------------------------------------------------------------------
// The passes that read neighbours, as plain numbers for the renderer.

/** The params of a `lookClarity` pass. */
export interface ClarityParams {
  /** Local contrast gain at mid grey. */
  amount: number
  /** Blur radius, as a fraction of the frame's short side. */
  radius: number
  /** The look's grain, already scaled by its Amount, added AFTER the detail (grainAfterClarity). 0 or absent = none. */
  grain?: number
  /** That grain's size in frame pixels on a 1080 short side. */
  grainSize?: number
}

/** How far the clarity pass looks, as a fraction of the short side: about 16 px on a 1080 frame. */
export const CLARITY_RADIUS = 0.015

/**
 * The weakest pass the renderer draws: applyNeighborhood (glRenderer.ts) skips a
 * pass at or below it. lookCompanions leaves such a pass out as well, because
 * a pass in the stack at all sends the layer down the isolated FBO path, which
 * costs a full extra layer draw and blit per frame to change no pixels.
 */
export const PASS_FLOOR = 0.001

/** The neighbour passes a look runs after its colour pass, already scaled by its Amount. Empty at Amount 0. */
export function lookCompanions(spec: LookSpec, amount: number): { type: string; params: Record<string, number> }[] {
  const out: { type: string; params: Record<string, number> }[] = []
  const a = clamp01(amount)
  if (a <= 0) return out
  const clarity = r6(spec.clarity * a)
  if (grainAfterClarity(spec)) {
    // The pass also lays the look's grain down, last, so it runs for either.
    const grain = r6(spec.grain.amount * a)
    if (clarity > PASS_FLOOR || grain > PASS_FLOOR) {
      out.push({
        type: 'lookClarity',
        params: { amount: clarity, radius: CLARITY_RADIUS, grain, grainSize: r6(spec.grain.size) },
      })
    }
  } else if (clarity > PASS_FLOOR) {
    out.push({ type: 'lookClarity', params: { amount: clarity, radius: CLARITY_RADIUS } })
  }
  for (const g of [spec.halation, spec.bloom]) {
    if (!g || r6(g.strength * a) <= PASS_FLOOR) continue
    out.push({
      type: 'lookGlow',
      params: {
        strength: r6(g.strength * a),
        radius: g.radius,
        threshold: g.threshold,
        softness: g.softness,
        tintR: g.tint[0],
        tintG: g.tint[1],
        tintB: g.tint[2],
        lumaTint: g.lumaTint,
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The same maths as shader text.

/** A GLSL float literal. Always has a decimal point, so `1` cannot become an int. */
export function glf(x: number): string {
  const r = r6(x)
  const s = String(r)
  if (/e/i.test(s)) return r.toFixed(6)
  return s.includes('.') ? s : `${s}.0`
}

const glvec3 = (v: Vec3): string => `vec3(${glf(v[0])}, ${glf(v[1])}, ${glf(v[2])})`
const glarr7 = (v: readonly number[]): string => `float[7](${v.map(glf).join(', ')})`

/**
 * Functions every look shares, at global scope. Emitted once per shader however
 * many looks are in the stack (the renderer drops repeats of the same text).
 * Every name starts `olk` so nothing in another effect's body can collide with it.
 */
export const LOOK_COMMON_GLSL = `
float olkLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float olkHue(vec3 c) {
  float x = 2.0 * c.r - c.g - c.b;
  float y = 1.7320508 * (c.g - c.b);
  if (abs(x) + abs(y) < 0.000001) return 0.0;
  float h = degrees(atan(y, x));
  return h < 0.0 ? h + 360.0 : h;
}
float olkBand(float h, float v[7]) {
  float lo = 0.0; float hi = 30.0; int i = 0;
  if (h >= 300.0) { lo = 300.0; hi = 360.0; i = 6; }
  else if (h >= 240.0) { lo = 240.0; hi = 300.0; i = 5; }
  else if (h >= 180.0) { lo = 180.0; hi = 240.0; i = 4; }
  else if (h >= 120.0) { lo = 120.0; hi = 180.0; i = 3; }
  else if (h >= 60.0) { lo = 60.0; hi = 120.0; i = 2; }
  else if (h >= 30.0) { lo = 30.0; hi = 60.0; i = 1; }
  float t = clamp((h - lo) / (hi - lo), 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  return mix(v[i], v[i == 6 ? 0 : i + 1], t);
}
float olkSkin(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = abs(mod(olkHue(c) - ${glf(SKIN_HUE)} + 180.0, 360.0) - 180.0);
  return (1.0 - smoothstep(${glf(SKIN_FULL)}, ${glf(SKIN_EDGE)}, d)) * smoothstep(0.03, 0.12, mx - mn);
}
vec3 olkRotate(vec3 c, float deg) {
  float a = radians(-deg);
  float cs = cos(a);
  float sn = sin(a);
  float Y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  float I = 0.596 * c.r - 0.274 * c.g - 0.322 * c.b;
  float Q = 0.211 * c.r - 0.523 * c.g + 0.312 * c.b;
  float I2 = I * cs - Q * sn;
  float Q2 = I * sn + Q * cs;
  return vec3(Y + 0.956171 * I2 + 0.621433 * Q2, Y - 0.272689 * I2 - 0.646813 * Q2, Y - 1.103744 * I2 + 1.700623 * Q2);
}
uint olkHash(ivec2 p, uint s) {
  uint h = (uint(p.x) * 1597334677u) ^ (uint(p.y) * 1274126177u) ^ (s * 2654435761u);
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return h ^ (h >> 16u);
}
float olkRand(ivec2 p, uint s) { return float(olkHash(p, s)) * (1.0 / 4294967296.0); }
float olkNoise(vec2 p, uint s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 ii = ivec2(i);
  float a = olkRand(ii, s);
  float b = olkRand(ii + ivec2(1, 0), s);
  float c = olkRand(ii + ivec2(0, 1), s);
  float d = olkRand(ii + ivec2(1, 1), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float olkGrain(vec2 p, float size, uint s) {
  float big = olkNoise(p / size, s);
  float fine = olkNoise(p / (size * 0.5) + 17.25, s + 1u);
  return (0.62 * big + 0.38 * fine - 0.5) * 2.0;
}
`

/**
 * The grain step of the clarity pass (glRenderer.ts LOOK_CLARITY_FS), the GLSL
 * twin of `addGrain` followed by a clamp. Runs LAST, on `vec3 o`: the encoded
 * colour after the detail went on. Reads the uniforms uGrain (already scaled by
 * the Amount), uGrainSize, uSeed and uFrame, and needs LOOK_COMMON_GLSL. The pass
 * draws into a sequence sized buffer, so the sequence pixel is gl_FragCoord with
 * y turned down: the very position, and so the very noise, the colour pass's
 * vSeqPos would have given the same pixel.
 */
export const CLARITY_GRAIN_GLSL = `
    vec2 olkP = vec2(gl_FragCoord.x, uFrame.y - gl_FragCoord.y);
    float olkSize = max(uGrainSize, 0.5) * (max(min(uFrame.x, uFrame.y), 1.0) / 1080.0);
    float olkG = olkGrain(olkP, olkSize, uint(max(floor(uSeed), 0.0)));
    float olkLg = clamp(olkLuma(o), 0.0, 1.0);
    o = clamp(o + vec3(olkG * uGrain * 0.3 * mix(0.4, 1.0, 4.0 * olkLg * (1.0 - olkLg))), 0.0, 1.0);`

/** The look's own tone curve as a GLSL function, named for the look so two looks can share a shader. */
export function curveFunctionGlsl(name: string, segs: readonly CurveSegment[]): string {
  const branches = segs
    .map((s, i) => {
      const last = i === segs.length - 1
      const body = `{
    float h = ${glf(s.x1 - s.x0)};
    float t = (x - ${glf(s.x0)}) / h;
    float t2 = t * t;
    float t3 = t2 * t;
    return (2.0 * t3 - 3.0 * t2 + 1.0) * ${glf(s.y0)} + (t3 - 2.0 * t2 + t) * h * ${glf(s.m0)} + (-2.0 * t3 + 3.0 * t2) * ${glf(s.y1)} + (t3 - t2) * h * ${glf(s.m1)};
  }`
      return last ? `  ${body}` : `  if (x < ${glf(s.x1)}) ${body}`
    })
    .join('\n')
  return `float ${name}(float x) {
  x = clamp(x, 0.0, 1.0);
${branches}
}
`
}

/** The name of a look's curve function in the shader. */
export const curveFnName = (spec: LookSpec): string => `olkCurve_${spec.id}`

/** Global scope GLSL one look needs: the shared helpers, then its own curve. */
export function lookHelpers(spec: LookSpec): string[] {
  return [LOOK_COMMON_GLSL, curveFunctionGlsl(curveFnName(spec), buildCurve(spec.curve))]
}

/**
 * The colour pass as a shader body: mutates `vec3 c`, reads `vSeqPos`, `uFrame`
 * and `uSeed` (all provided by the layer shader). `amount` is the GLSL expression
 * for the Amount uniform.
 */
export function lookGlsl(spec: LookSpec, amount: string): string {
  const curveFn = curveFnName(spec)
  const st = lookStages(spec)
  const out: string[] = []
  out.push('vec3 olkC0 = clamp(c, 0.0, 1.0);')
  out.push('vec3 olkV = olkC0;')

  out.push(`olkV *= ${glvec3(gainFactors(spec))};`)

  out.push(`{
    float olkL0 = olkLuma(olkV);
    vec3 olkLumaOnly = olkV + vec3(${curveFn}(olkL0) - olkL0);
    vec3 olkPer = vec3(${curveFn}(olkV.r), ${curveFn}(olkV.g), ${curveFn}(olkV.b));
    olkV = clamp(mix(olkLumaOnly, olkPer, ${glf(spec.curveMix)}), 0.0, 1.0);
  }`)

  out.push(st.skin ? `float olkHold = ${glf(spec.skinProtect)} * olkSkin(olkV);` : 'float olkHold = 0.0;')

  if (st.needsHue) out.push('float olkHueV = olkHue(olkV);')
  out.push(`{
    float olkL1 = olkLuma(olkV);
    ${st.hueSat ? `float olkSm = olkBand(olkHueV, ${glarr7(spec.hueSat)});` : 'float olkSm = 1.0;'}
    float olkLw = mix(mix(${glf(spec.satShadows)}, 1.0, smoothstep(0.0, 0.3, olkL1)) * mix(1.0, ${glf(spec.satHighlights)}, smoothstep(0.65, 1.0, olkL1)), 1.0, olkHold);
    olkV = vec3(olkL1) + (olkV - vec3(olkL1)) * (${glf(spec.saturation)} * olkSm * olkLw);
  }`)

  if (st.hueLum) {
    out.push(`{
    float olkK = olkBand(olkHueV, ${glarr7(spec.hueLum)});
    float olkCh = max(olkV.r, max(olkV.g, olkV.b)) - min(olkV.r, min(olkV.g, olkV.b));
    olkV *= 1.0 + (olkK - 1.0) * smoothstep(0.04, 0.2, olkCh);
  }`)
  }

  if (st.hueShift) out.push(`olkV = olkRotate(olkV, olkBand(olkHueV, ${glarr7(spec.hueShift)}));`)

  if (spec.mono > 0) {
    out.push(`olkV = mix(olkV, vec3(dot(olkV, ${glvec3(spec.monoWeights)})), ${glf(spec.mono)});`)
  }

  if (st.tints) {
    const ds = tintDir(spec.shadowTint.hue)
    const dh = tintDir(spec.highlightTint.hue)
    out.push(`{
    float olkL2 = olkLuma(olkV);
    float olkWS = (1.0 - smoothstep(0.0, 0.6, olkL2)) * (1.0 - olkHold);
    float olkWH = smoothstep(0.4, 1.0, olkL2) * (1.0 - olkHold);
    olkV += ${glvec3(ds)} * (${glf(spec.shadowTint.strength)} * olkWS) + ${glvec3(dh)} * (${glf(spec.highlightTint.strength)} * olkWH);
  }`)
  }

  if (spec.vignette.amount > 0) {
    out.push(`{
    vec2 olkP = vSeqPos / uFrame - 0.5;
    float olkM = smoothstep(${glf(spec.vignette.size)}, ${glf(spec.vignette.size + Math.max(r6(spec.vignette.feather), 0.001))}, length(olkP));
    olkV *= 1.0 - ${glf(spec.vignette.amount)} * olkM;
  }`)
  }

  // A look with clarity lays its grain down in the clarity pass instead, after the
  // detail, so the clarity cannot sharpen it (grainAfterClarity, and the header).
  if (spec.grain.amount > 0 && !grainAfterClarity(spec)) {
    out.push(`{
    float olkSize = ${glf(Math.max(r6(spec.grain.size), 0.5))} * (max(min(uFrame.x, uFrame.y), 1.0) / 1080.0);
    float olkG = olkGrain(vSeqPos, olkSize, uint(max(floor(uSeed), 0.0)));
    float olkLg = clamp(olkLuma(olkV), 0.0, 1.0);
    olkV += vec3(olkG * ${glf(spec.grain.amount)} * 0.3 * mix(0.4, 1.0, 4.0 * olkLg * (1.0 - olkLg)));
  }`)
  }

  // Mixed with `c` as it ARRIVED, not the clamped copy the look worked on, and not
  // clamped after: at Amount 0 a value an earlier effect pushed past 1 goes on to
  // the next effect untouched, so a look keyframed in from 0 changes nothing at 0.
  // The Amount is held to 0..1, so an ease that overshoots never extrapolates.
  out.push(`c = mix(c, clamp(olkV, 0.0, 1.0), clamp(${amount}, 0.0, 1.0));`)
  return out.join('\n')
}
