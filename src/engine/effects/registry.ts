// The effect registry: the single source of truth for what an effect IS.
//
// Pure: no GL, no DOM, no store. Three consumers read it:
//   - glRenderer.ts turns `glsl` into a compiled program (pointwise effects are
//     concatenated, in stack order, into one per-layer fragment shader);
//   - the Inspector turns `params` into controls;
//   - resolve.ts turns an EffectInstance into a ResolvedEffect by sampling each
//     param's keyframes at a clip-local time.
//
// Adding an effect means adding an entry here. That is the whole point: chroma
// key, luma curve, and masks become registry entries, not new architecture.
//
// WHAT `c` IS, because every colour effect below depends on the answer and the
// comments used to get it wrong. `c` is sRGB-ENCODED, gamma-companded, 0..1. It
// is NOT linear light. Source frames upload as gl.RGBA / gl.UNSIGNED_BYTE
// (glRenderer.ts acquireTexture), never gl.SRGB8_ALPHA8, so sampling performs no
// decode; the per-layer FBOs are RGBA8 too; and there is no srgbToLinear, no
// pow(c, 2.2) and no EXT_sRGB anywhere in src/engine. exportWorker.ts says the
// same thing from the other end ("the pixels going in are full-range sRGB").

import { evalChannel } from '../keyframes'
import type { ResolvedEffect } from '../render/types'
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
  /** Value units per pixel of horizontal drag. Defaults to half a step. */
  sens?: number
}

/** Drag sensitivity for a param, with the sane default applied. */
export const paramSens = (param: EffectParamDef): number => param.sens ?? param.step / 2

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
  /**
   * Kept out of the Effects browser, but still rendered, still migrated, still
   * editable on any clip that already carries it.
   *
   * His call, 2026-07-28: "most of the effects I won't ever use. They are just
   * stupid. There is a lot of bloat." A fifteen-item list where seven of them
   * are pro colour tools he will never open is a list he has to read past every
   * time. HIDDEN rather than deleted, deliberately: `filtersToEffectStack`
   * migrates every old project through exposure, lift/gamma/gain, white balance
   * and blur, so deleting those types would change how his saved projects look,
   * or fail to open them at all. Hiding costs nothing and risks nothing.
   */
  hidden?: boolean
  /**
   * Params to seed when the user APPLIES this effect, overriding the neutral
   * `default`s. For effects that should do something visible the moment they are
   * dropped (Auto Color), so they don't look broken sitting at identity. `reset`
   * and the neutral-skip still use each param's `default`, so Reset returns to
   * identity and a hand-zeroed instance is still skipped.
   */
  initialParams?: Record<string, number>
  params: EffectParamDef[]
  /**
   * Pointwise GLSL. Mutates `vec3 c` (0..1 sRGB-encoded RGB, see the file
   * header); `float a` (alpha) is readable AND writable. Keying effects multiply
   * it down, and the premultiply happens after the whole chain. The renderer
   * wraps every body in its own block scope, so local variable names cannot
   * collide when an effect appears in a stack twice. Uniform names come from
   * `u`, so they cannot collide either.
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
  sens?: number,
): EffectParamDef => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
  ...(unit ? { unit } : {}),
  ...(sens ? { sens } : {}),
})

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
    type: 'autoColor',
    label: 'Auto Color',
    description: 'One-click correction: adds contrast (S-curve) and lifts muted colours. Tune with Amount.',
    category: 'color',
    pass: 'pointwise',
    // Dropped at a visible strength; `default` stays 0 (identity) so Reset and
    // the neutral-skip still work.
    initialParams: { amount: 0.6 },
    params: [p('amount', 'Amount', 0, 1, 0.01, 0)],
    glsl: (u) => `
      float acAmt = ${u('amount')};
      // Auto contrast: an S-curve (smoothstep) deepens shadows and lifts highlights.
      c = mix(c, smoothstep(0.0, 1.0, c), acAmt * 0.6);
      // Auto vibrance: push muted colours more than already-saturated ones.
      float acMax = max(c.r, max(c.g, c.b));
      float acMin = min(c.r, min(c.g, c.b));
      float acSat = acMax - acMin;
      float acLuma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(acLuma), c, 1.0 + acAmt * 0.5 * (1.0 - acSat));
    `,
  },
  {
    type: 'exposure',
    hidden: true,
    label: 'Exposure',
    description: 'Scale the picture by stops before any other grade.',
    category: 'color',
    pass: 'pointwise',
    // The description used to claim "linear light". It was never true: see the
    // file header. This is the same gain Brightness applies, over a wider range
    // (-4..4 rather than -1..1), which makes it a duplicate of Brightness in
    // everything but reach. It is KEPT, hidden and unchanged, because it is not
    // a second DOOR (nothing on the shelf offers it) and three live things
    // depend on its exact behaviour: the `exposure` channel in the Inspector's
    // colour rows, `filtersToEffectStack` migrating `filters.exposure`, and
    // `jettismGradeEffects()` (lookActions.ts), which puts +0.1 on every clip
    // the punch grade has ever touched. Deleting it would quietly flatten all of
    // them; folding it into Brightness would change the punch grade's signature
    // and make `hasJettismGrade` stop recognising clips it already graded, so a
    // second click would stack the grade twice.
    params: [p('exposure', 'Exposure', -4, 4, 0.01, 0, 'stops', 0.02)],
    glsl: (u) => `c *= pow(2.0, ${u('exposure')});`,
  },
  {
    type: 'colorWheels',
    hidden: true,
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
    hidden: true,
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
    hidden: true,
    label: 'Brightness & Contrast (legacy)',
    description: 'Additive brightness, then contrast pivoted on mid grey. Kept only so clips graded before the split render exactly as they were cut.',
    category: 'color',
    pass: 'pointwise',
    // FROZEN. Not one character of `params` or `glsl` may change.
    //
    // HIS REPORT, 2026-08-10: "instead of actually putting the brightness up, it
    // just makes the screen whiter." He was right, and the description said so
    // out loud. `c += b` lifts black to grey, crushes every ratio in the picture,
    // and clips everything above 1 - b to one flat white. It is a fade to white,
    // not a brightness control, and it is replaced by the `brightness` entry
    // below.
    //
    // It is not DELETED, and no stored value is converted, because there is no
    // faithful conversion: matching `in + b == in * g` needs `g = 1 + b/in`,
    // which depends on the pixel. See migrate.ts for the whole argument. His
    // saved projects keep pointing at this type and keep rendering byte for
    // byte, which is the only outcome where he cannot be silently regraded on
    // footage he has already published. Hidden, so nothing new can reach it.
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
    type: 'brightness',
    label: 'Brightness',
    description: 'Scales the picture, so black stays black and nothing washes out. 0 is neutral.',
    category: 'color',
    pass: 'pointwise',
    params: [p('brightness', 'Brightness', -1, 1, 0.01, 0)],
    // MULTIPLY, never add. HIS INSTRUCTION, 2026-08-10: "do brightness and
    // contrast as a separate effect."
    //
    // WHY A PLAIN MULTIPLY IS THE HONEST MATHS HERE. `c` is sRGB-encoded, not
    // linear light (file header). For a power-law transfer function, scaling
    // linear light and scaling the encoded value are the SAME operation with a
    // different constant: ((c^g) * k)^(1/g) == c * (k^(1/g)). So one multiply is
    // real exposure with the exponent folded into the gain. Decoding, scaling
    // and re-encoding would cost two pow() per pixel per instance in a chain
    // that is inlined into one shader, and would buy a difference only in the
    // deepest shadows, where sRGB's linear toe is the one place the identity is
    // inexact, and that difference is under one 255th.
    //
    // WHY pow(2, b) IS THE GAIN. It is exactly reciprocal at the two ends,
    // pow(2, -b) == 1.0 / pow(2, b), so the slider is symmetric by construction:
    // +0.4 then -0.4 lands back on the pixel it started from, and neither end is
    // a wipe (at +1 a dark 0.2 pixel is still only 0.4; at -1 a light 0.8 pixel
    // is still 0.4). The full travel is a factor of two either way on the code
    // value, which is mid grey to white at the top, and it puts the end stop
    // somewhere useful instead of at total white the way `c += 1.0` did.
    //
    // b = 0 compiles to `c *= pow(2.0, 0.0)`, and pow is exp2(y * log2(x)) with
    // log2(2.0) exactly 1.0, so it is bit-exact `c *= 1.0`: a true no-op for a
    // keyframed brightness passing through zero. (A STATIC zero never reaches
    // the shader at all; `isNeutral` drops it before the program is built.)
    glsl: (u) => `c *= pow(2.0, ${u('brightness')});`,
  },
  {
    type: 'contrast',
    label: 'Contrast',
    description: 'Pushes values away from mid grey, or toward it below 0. -1 is flat grey.',
    category: 'color',
    pass: 'pointwise',
    params: [p('contrast', 'Contrast', -1, 1, 0.01, 0)],
    // Byte-identical to the second line of `brightnessContrast`, deliberately.
    // That identity is what lets migrate.ts rewrite an old instance whose
    // brightness sits at a static 0 onto this type without a single pixel
    // moving, and brightness.test.ts pins the two strings against each other so
    // nobody can edit one and not the other.
    //
    // THE PIVOT STAYS AT 0.5, and it is not wrong. In the encoded domain 0.5 is
    // code 128, which is the pivot every consumer contrast control uses
    // (Photoshop's, Premiere's own Brightness & Contrast). Pivoting on a linear
    // 18% grey would land at an encoded 0.46: a difference nobody can see,
    // bought by regrading every project he owns. There is no evidence to change
    // it, so it does not change.
    glsl: (u) => `c = (c - 0.5) * (1.0 + ${u('contrast')}) + 0.5;`,
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
    type: 'vibrance',
    hidden: true,
    label: 'Vibrance',
    description: 'Smart saturation: pushes muted colours harder than already-vivid ones (Premiere-style).',
    category: 'color',
    pass: 'pointwise',
    params: [p('vibrance', 'Vibrance', -1, 1, 0.01, 0)],
    // Unlike plain saturation, the boost scales by (1 - current saturation), so
    // low-saturation pixels get most of it and already-saturated ones are barely
    // touched, giving the "digital vibrance" look that avoids clipping vivid colours.
    glsl: (u) => `
      float vMax = max(c.r, max(c.g, c.b));
      float vMin = min(c.r, min(c.g, c.b));
      float vSat = vMax - vMin;
      float vLuma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(vLuma), c, 1.0 + ${u('vibrance')} * (1.0 - vSat));
    `,
  },
  {
    type: 'vignette',
    label: 'Vignette',
    description: 'Darken toward the edges. Size sets where the falloff starts, Feather how soft it is.',
    category: 'stylize',
    pass: 'pointwise',
    // Dropped at a visible strength (like Auto Color); `default` stays 0 so
    // Reset and the neutral-skip still work.
    initialParams: { amount: 0.5 },
    params: [
      p('amount', 'Amount', 0, 1, 0.01, 0),
      p('size', 'Size', 0, 1.5, 0.01, 0.4),
      p('feather', 'Feather', 0, 1, 0.01, 0.35),
    ],
    // Radial falloff in source UV space, aspect-corrected by the frame so the
    // vignette is round on screen rather than stretched.
    glsl: (u) => `
      vec2 vgP = (vUV - 0.5) * vec2(uFrame.x / max(uFrame.y, 1.0), 1.0);
      float vgD = length(vgP);
      float vgM = smoothstep(${u('size')}, ${u('size')} + max(${u('feather')}, 0.001), vgD);
      c *= 1.0 - ${u('amount')} * vgM;
    `,
  },
  {
    type: 'grain',
    hidden: true,
    label: 'Film Grain',
    description: 'Animated luma noise. Size sets the grain cell in pixels.',
    category: 'stylize',
    pass: 'pointwise',
    initialParams: { amount: 0.3 },
    params: [p('amount', 'Amount', 0, 1, 0.01, 0), p('size', 'Size', 1, 8, 0.5, 2, 'px')],
    // uSeed is the resolver's frame index (same in preview and export at the
    // same frame time), so grain flickers per frame yet stays parity-safe.
    glsl: (u) => `
      float gnSize = max(${u('size')}, 1.0);
      vec2 gnCell = floor(vUV * uFrame / gnSize);
      float gnN = fract(sin(dot(gnCell + fract(uSeed * vec2(0.1031, 0.103)) * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
      c += (gnN - 0.5) * ${u('amount')} * 0.35;
    `,
  },
  {
    type: 'sharpen',
    hidden: true,
    label: 'Sharpen',
    description: 'Unsharp-mask detail boost. Radius sets the detail scale.',
    category: 'stylize',
    pass: 'neighborhood',
    initialParams: { amount: 0.8 },
    params: [p('amount', 'Amount', 0, 3, 0.01, 0), p('radius', 'Radius', 0.5, 4, 0.1, 1, 'px')],
  },
  {
    type: 'gaussianBlur',
    label: 'Gaussian Blur',
    description: 'Separable gaussian over the composited layer.',
    category: 'blur',
    pass: 'neighborhood',
    params: [p('blur', 'Radius', 0, 64, 0.5, 0, 'px', 0.25)],
  },
  {
    type: 'directionalBlur',
    hidden: true,
    label: 'Directional Blur',
    description: 'Motion smear along an angle, the whip-transition workhorse.',
    category: 'blur',
    pass: 'neighborhood',
    params: [p('angleDeg', 'Angle', 0, 360, 1, 0, '°'), p('strength', 'Strength', 0, 1, 0.01, 0)],
  },
  {
    type: 'chromaKey',
    label: 'Green Screen',
    description: 'Removes a green (or blue) screen behind the clip. Drop it on the clip that HAS the screen; raise Similarity if green edges remain, Spill kills green fringe.',
    category: 'key',
    pass: 'pointwise',
    // Dropped keying GREEN at a clean working strength (key-colour default is green,
    // keyR/G/B = 0/1/0); spill FULL (1.0) so no green tint survives on the kept
    // edges: the fix for green surviving on white corners + thin white lines. A
    // pure bright green screen keys cleanly at these defaults with no tuning.
    initialParams: { similarity: 0.4, smoothness: 0.08, spill: 1 },
    params: [
      p('keyR', 'Key R', 0, 1, 0.01, 0),
      p('keyG', 'Key G', 0, 1, 0.01, 1),
      p('keyB', 'Key B', 0, 1, 0.01, 0),
      p('similarity', 'Similarity', 0, 1, 0.01, 0),
      p('smoothness', 'Smoothness', 0, 1, 0.01, 0.1),
      p('spill', 'Spill', 0, 1, 0.01, 0),
    ],
    // Green/blue screens key on the screen channel's EXCESS over the other two
    // (luminance-independent, so white detail survives); arbitrary key colours
    // fall back to CbCr chroma distance. similarity 0 bypasses = identity.
    glsl: (u) => `
      float ckSim = ${u('similarity')};
      if (ckSim > 0.0) {
        vec3 ckKey = vec3(${u('keyR')}, ${u('keyG')}, ${u('keyB')});
        float ckSmooth = max(${u('smoothness')}, 0.001);
        float ckSpill = ${u('spill')};
        bool ckGreen = ckKey.g >= ckKey.r && ckKey.g >= ckKey.b;
        bool ckBlue = ckKey.b >= ckKey.r && ckKey.b > ckKey.g;
        if (ckGreen || ckBlue) {
          // GREEN/BLUE SCREEN: key on how far the screen channel EXCEEDS the other
          // two. White, grey and any neutral have ~zero excess, so thin white lines
          // and the CORNERS of white shapes are kept fully opaque, whereas a chroma-distance
          // key eats them because their anti-aliased edges drift toward the screen
          // colour. Excess ignores brightness, so bright detail never keys out.
          float ckChan = ckGreen ? c.g : c.b;
          float ckOther = ckGreen ? max(c.r, c.b) : max(c.r, c.g);
          float ckExcess = ckChan - ckOther;
          // similarity = the excess at which a pixel is fully screen; below it, keep.
          float ckHi = ckSim;
          float ckLo = max(0.0, ckSim - ckSmooth - 0.15);
          a *= 1.0 - smoothstep(ckLo, ckHi, ckExcess);
          // DESPILL every kept pixel: pull the screen channel down to its neighbours
          // so no green/blue tint survives on the kept edges (the white-corner fix).
          // Only the EXCESS is removed, so white stays white and brightness holds;
          // spill scales completeness (1 = fully neutral edges).
          if (ckSpill > 0.0 && ckExcess > 0.0) {
            float ckClamped = mix(ckChan, ckOther, ckSpill);
            if (ckGreen) c.g = ckClamped; else c.b = ckClamped;
          }
        } else {
          // Arbitrary key colour: CbCr (chroma-only) distance, so shadows/lighting
          // on the screen still key. Despill desaturates the near-key fringe.
          vec2 ckPx = vec2(dot(c, vec3(-0.169, -0.331, 0.5)), dot(c, vec3(0.5, -0.419, -0.081)));
          vec2 ckKy = vec2(dot(ckKey, vec3(-0.169, -0.331, 0.5)), dot(ckKey, vec3(0.5, -0.419, -0.081)));
          float ckD = distance(ckPx, ckKy) * 2.0;
          a *= smoothstep(ckSim, ckSim + ckSmooth, ckD);
          if (ckSpill > 0.0) {
            float ckSpillMask = 1.0 - smoothstep(ckSim, ckSim + ckSmooth * 2.0 + 0.1, ckD);
            float ckLuma = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(c, vec3(ckLuma), ckSpillMask * ckSpill);
          }
        }
      }
    `,
  },
  {
    type: 'lumaKey',
    hidden: true,
    label: 'Luma Key',
    description: 'Keys out darks below the threshold (or brights, with Key Brights). Threshold 0 is off.',
    category: 'key',
    pass: 'pointwise',
    initialParams: { threshold: 0.15, softness: 0.1 },
    params: [
      p('threshold', 'Threshold', 0, 1, 0.01, 0),
      p('softness', 'Softness', 0, 1, 0.01, 0.1),
      p('keyBright', 'Key Brights', 0, 1, 1, 0),
    ],
    glsl: (u) => `
      float lkThr = ${u('threshold')};
      if (lkThr > 0.0) {
        float lkLuma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float lkL = mix(lkLuma, 1.0 - lkLuma, ${u('keyBright')});
        float lkSoft = max(${u('softness')}, 0.001);
        a *= smoothstep(lkThr - lkSoft, lkThr + lkSoft, lkL);
      }
    `,
  },
  {
    type: 'glow',
    label: 'Glow',
    description: 'Bloom: bright areas bleed soft light. Threshold picks what counts as bright.',
    category: 'stylize',
    pass: 'neighborhood',
    initialParams: { intensity: 1 },
    params: [
      p('intensity', 'Intensity', 0, 3, 0.01, 0),
      p('radius', 'Radius', 2, 64, 0.5, 24, 'px'),
      p('threshold', 'Threshold', 0, 1, 0.01, 0.6),
    ],
  },
]

/**
 * The order a migrated `filters` bag becomes a stack in. This is the frozen
 * math order of the pre-registry LAYER_FS shader; do not reorder it without a
 * golden-test re-baseline.
 *
 * `brightnessContrast` keeps the exact slot it always had, so a clip that still
 * carries it grades in the same place in the chain. The two effects it split
 * into follow it, which is also the old shader's own order (brightness, then
 * contrast, then saturation).
 */
export const CANONICAL_ORDER = [
  // Keys run first: they read the ORIGINAL colours, before any grade shifts them.
  'chromaKey',
  'lumaKey',
  'autoColor',
  'exposure',
  'colorWheels',
  'whiteBalance',
  'brightnessContrast',
  'brightness',
  'contrast',
  'saturation',
  'vibrance',
  'vignette',
  'grain',
  'sharpen',
  'gaussianBlur',
  'directionalBlur',
  'glow',
] as const

/**
 * What the Effects browser offers. Everything else still renders, migrates and
 * edits exactly as before; it is just not on the shelf.
 *
 * `EFFECTS` stays the full registry, because the renderer, the migration and the
 * Inspector all have to know about every type that could be on a clip. Only the
 * three PICKERS use this list.
 */
export const BROWSABLE_EFFECTS: EffectDef[] = EFFECTS.filter((e) => !e.hidden)

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
export const isAnimated = (v: unknown): v is { value: number; keyframes: Keyframe[] } =>
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
    // An empty keyframe list falls back to the param's own retained base.
    else out[param.key] = evalChannel(raw.keyframes, localT, raw.value)
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

/**
 * Which ClipFilters keys feed which effect, in canonical order.
 *
 * `brightnessContrast` stays here on purpose. A number in `filters.brightness`
 * was written for the ADDITIVE shader, so the additive effect is the only one
 * that reads it correctly. See migrate.ts for the full argument.
 */
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
 * A stable key for one resolved stack's SHAPE (types and order, not values).
 * The renderer caches a compiled program per signature.
 */
export const stackSignature = (effects: readonly ResolvedEffect[]): string =>
  effects.map((e) => e.type).join('|')
