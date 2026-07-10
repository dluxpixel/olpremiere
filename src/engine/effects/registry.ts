// The effect registry: the single source of truth for what an effect IS.
//
// Pure — no GL, no DOM, no store. Three consumers read it:
//   - glRenderer.ts turns `glsl` into a compiled program (pointwise effects are
//     concatenated, in stack order, into one per-layer fragment shader);
//   - the Inspector turns `params` into controls;
//   - resolve.ts turns an EffectInstance into a ResolvedEffect by sampling each
//     param's keyframes at a clip-local time.
//
// Adding an effect means adding an entry here. That is the whole point: chroma
// key, luma curve, and masks become registry entries, not new architecture.

import { evalChannel } from '../keyframes'
import type { ResolvedEffect, ResolvedFilters } from '../render/types'
import type { ClipFilters, EffectInstance, Keyframe } from '../types'

export type EffectCategory = 'color' | 'blur' | 'key' | 'stylize'

/**
 * How an effect executes in the renderer.
 *  - 'pointwise': its GLSL body is concatenated, in stack order, into the
 *    per-layer fragment shader. It mutates `vec3 c` in place and sees only the
 *    current pixel. Cheap: the whole chain is one pass.
 *  - 'neighborhood': it must sample neighbouring pixels, so it runs as its own
 *    full-screen pass over the layer's isolated FBO, after the pointwise chain.
 */
export type EffectPass = 'pointwise' | 'neighborhood'

export interface EffectParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
  /** Neutral (identity) value. An effect whose params all sit here is a no-op. */
  default: number
  unit?: string
}

/** Emit the uniform name for one param of this effect at its stack index. */
export type UniformNamer = (paramKey: string) => string

export interface EffectDef {
  type: string
  label: string
  description: string
  category: EffectCategory
  pass: EffectPass
  /**
   * Fixed effects are intrinsic to every clip (Premiere's Motion / Opacity):
   * shown in Effect Controls, never draggable, never removable.
   */
  fixed?: boolean
  params: EffectParamDef[]
  /**
   * Pointwise GLSL. Mutates `vec3 c` (0..1 RGB) in place; `float a` (alpha) is
   * readable. The renderer wraps every body in its own block scope, so local
   * variable names cannot collide when an effect appears in a stack twice.
   * Uniform names come from `u`, so they cannot collide either.
   */
  glsl?: (u: UniformNamer) => string
}

const p = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  unit?: string,
): EffectParamDef => ({ key, label, min, max, step, default: def, ...(unit ? { unit } : {}) })

// ---------------------------------------------------------------------------
// The registry.
//
// ORDER MATTERS. `CANONICAL_ORDER` below reproduces, exactly, the fixed math
// order the monolithic LAYER_FS shader used before effects became a stack:
//   exposure -> lift/gamma/gain -> white balance -> brightness -> contrast
//   -> saturation -> (clamp) -> blur
// Migrating a clip's old `filters` bag through `filtersToEffectStack` therefore
// renders identically. The golden export test is what proves it.

export const EFFECTS: EffectDef[] = [
  {
    type: 'exposure',
    label: 'Exposure',
    description: 'Scale linear light by stops before any other grade.',
    category: 'color',
    pass: 'pointwise',
    params: [p('exposure', 'Exposure', -4, 4, 0.01, 0, 'stops')],
    glsl: (u) => `c *= pow(2.0, ${u('exposure')});`,
  },
  {
    type: 'colorWheels',
    label: 'Lift / Gamma / Gain',
    description: 'ASC-CDL three-way grade: out = (in * slope + offset) ^ power.',
    category: 'color',
    pass: 'pointwise',
    params: [
      p('lift', 'Lift', -1, 1, 0.01, 0),
      p('gamma', 'Gamma', -1, 1, 0.01, 0),
      p('gain', 'Gain', -1, 1, 0.01, 0),
    ],
    glsl: (u) => `
      float slope = 1.0 + ${u('gain')};
      float offset = ${u('lift')} * 0.5;
      float power = pow(2.0, -${u('gamma')});
      c = pow(max(c * slope + offset, vec3(0.0)), vec3(power));
    `,
  },
  {
    type: 'whiteBalance',
    label: 'White Balance',
    description: 'Temperature pushes red and pulls blue; tint pushes green.',
    category: 'color',
    pass: 'pointwise',
    params: [
      p('temperature', 'Temperature', -1, 1, 0.01, 0),
      p('tint', 'Tint', -1, 1, 0.01, 0),
    ],
    glsl: (u) => `
      c.r *= (1.0 + ${u('temperature')} * 0.4);
      c.b *= (1.0 - ${u('temperature')} * 0.4);
      c.g *= (1.0 + ${u('tint')} * 0.4);
    `,
  },
  {
    type: 'brightnessContrast',
    label: 'Brightness & Contrast',
    description: 'Additive brightness, then contrast pivoted on mid grey.',
    category: 'color',
    pass: 'pointwise',
    params: [
      p('brightness', 'Brightness', -1, 1, 0.01, 0),
      p('contrast', 'Contrast', -1, 1, 0.01, 0),
    ],
    glsl: (u) => `
      c += ${u('brightness')};
      c = (c - 0.5) * (1.0 + ${u('contrast')}) + 0.5;
    `,
  },
  {
    type: 'saturation',
    label: 'Saturation',
    description: 'Blend toward Rec.709 luma. -1 is greyscale.',
    category: 'color',
    pass: 'pointwise',
    params: [p('saturation', 'Saturation', -1, 1, 0.01, 0)],
    glsl: (u) => `
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, 1.0 + ${u('saturation')});
    `,
  },
  {
    type: 'gaussianBlur',
    label: 'Gaussian Blur',
    description: 'Separable gaussian over the composited layer.',
    category: 'blur',
    pass: 'neighborhood',
    params: [p('blur', 'Radius', 0, 64, 0.5, 0, 'px')],
  },
]

/**
 * The order a migrated `filters` bag becomes a stack in. This is the frozen
 * math order of the pre-registry LAYER_FS shader; do not reorder it without a
 * golden-test re-baseline.
 */
export const CANONICAL_ORDER = [
  'exposure',
  'colorWheels',
  'whiteBalance',
  'brightnessContrast',
  'saturation',
  'gaussianBlur',
] as const

export const EFFECT_BY_TYPE: Readonly<Record<string, EffectDef>> = Object.freeze(
  Object.fromEntries(EFFECTS.map((e) => [e.type, e])),
)

export const getEffect = (type: string): EffectDef | undefined => EFFECT_BY_TYPE[type]

/** Every param at its neutral value. */
export function defaultParams(def: EffectDef): Record<string, number> {
  const out: Record<string, number> = {}
  for (const param of def.params) out[param.key] = param.default
  return out
}

/** True when this param carries keyframes rather than a static number. */
export const isAnimated = (v: unknown): v is { keyframes: Keyframe[] } =>
  typeof v === 'object' && v !== null && Array.isArray((v as { keyframes?: unknown }).keyframes)

/**
 * Sample every param of `inst` at clip-local time `localT`, yielding the flat
 * numeric params the renderer binds as uniforms. Unknown params on the instance
 * are dropped; params missing from the instance fall back to their neutral.
 */
export function resolveEffectParams(def: EffectDef, inst: EffectInstance, localT: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const param of def.params) {
    const raw = inst.params[param.key]
    if (raw === undefined) out[param.key] = param.default
    else if (typeof raw === 'number') out[param.key] = raw
    else out[param.key] = evalChannel(raw.keyframes, localT, param.default)
  }
  return out
}

/** Resolve a whole instance to its render-time form. Returns null for unknown types. */
export function resolveEffect(inst: EffectInstance, localT: number): ResolvedEffect | null {
  if (!inst.enabled) return null
  const def = getEffect(inst.type)
  if (!def) return null
  return { type: def.type, params: resolveEffectParams(def, inst, localT) }
}

/**
 * An effect is neutral when every param is a static number sitting at its
 * default. A keyframed param is never neutral: it may leave the default later.
 * Neutral effects are skipped by the renderer, which keeps the compiled-program
 * cache small without changing a single pixel (every body is identity at 0).
 */
export function isNeutral(inst: EffectInstance): boolean {
  const def = getEffect(inst.type)
  if (!def) return true
  return def.params.every((param) => {
    const raw = inst.params[param.key]
    if (raw === undefined) return true
    if (typeof raw === 'number') return raw === param.default
    return false
  })
}

// ---------------------------------------------------------------------------
// Migration from the pre-registry `ClipFilters` bag.

/** Which ClipFilters keys feed which effect, in canonical order. */
const FILTER_KEYS: Readonly<Record<string, readonly (keyof ClipFilters)[]>> = {
  exposure: ['exposure'],
  colorWheels: ['lift', 'gamma', 'gain'],
  whiteBalance: ['temperature', 'tint'],
  brightnessContrast: ['brightness', 'contrast'],
  saturation: ['saturation'],
  gaussianBlur: ['blur'],
}

/**
 * Turn a legacy `filters` bag into the canonical effect stack. Ids are
 * DETERMINISTIC (`fx_<type>`) so migrating the same project twice produces the
 * same document, and so tests can assert on them. Neutral effects are omitted.
 */
export function filtersToEffectStack(filters: ClipFilters | undefined): EffectInstance[] {
  if (!filters) return []
  const stack: EffectInstance[] = []
  for (const type of CANONICAL_ORDER) {
    const def = EFFECT_BY_TYPE[type]
    const keys = FILTER_KEYS[type]
    if (!def || !keys) continue
    const params: Record<string, number> = {}
    let anyNonNeutral = false
    for (let i = 0; i < def.params.length; i++) {
      const param = def.params[i]
      const value = filters[keys[i]] ?? param.default
      params[param.key] = value
      if (value !== param.default) anyNonNeutral = true
    }
    if (anyNonNeutral) stack.push({ id: `fx_${type}`, type, params, enabled: true })
  }
  return stack
}

/**
 * Turn ALREADY-SAMPLED filter values (keyframes resolved for this frame) into
 * the canonical ordered stack the renderer draws. This is the bridge that lets
 * the fixed `filters` bag and a real effect stack share one render path.
 *
 * Neutral effects are skipped. Every GLSL body is the identity at its defaults,
 * so dropping them cannot move a pixel; it just keeps the compiled-program
 * cache small (a project with no grade compiles exactly one layer program).
 */
export function resolvedFiltersToStack(f: ResolvedFilters): ResolvedEffect[] {
  const out: ResolvedEffect[] = []
  const push = (type: string, params: Record<string, number>): void => {
    const def = EFFECT_BY_TYPE[type]
    if (!def) return
    if (def.params.every((param) => params[param.key] === param.default)) return
    out.push({ type, params })
  }
  // Frozen LAYER_FS math order. See CANONICAL_ORDER.
  push('exposure', { exposure: f.exposure })
  push('colorWheels', { lift: f.lift, gamma: f.gamma, gain: f.gain })
  push('whiteBalance', { temperature: f.temperature, tint: f.tint })
  push('brightnessContrast', { brightness: f.brightness, contrast: f.contrast })
  push('saturation', { saturation: f.saturation })
  push('gaussianBlur', { blur: f.blur })
  return out
}

/**
 * A stable key for one resolved stack's SHAPE (types and order, not values).
 * The renderer caches a compiled program per signature.
 */
export const stackSignature = (effects: readonly ResolvedEffect[]): string =>
  effects.map((e) => e.type).join('|')
