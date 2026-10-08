// The cinematic looks: ten finished grades, each ONE effect with one Amount slider.
//
// His words, 2026-10-06: "let's add multiple cinematic filters for the gym edits.
// Literally do a ton of research on one of the coolest and most sick filters that
// apply to iphone as well, and just make them."
//
// Every look is a row of numbers below, run by the maths in lookMath.ts. Nothing
// here draws: registry.ts turns each spec into an effect, the shared renderer runs
// it, and that one renderer draws both the preview and the export.
//
// WHAT EVERY LOOK HAS TO DO ON HIS FOOTAGE. His clips are iPhone HDR, tone mapped
// to SDR on import, shot in gyms lit by white ceiling panels against white walls,
// so the frames arrive bright and flat with near white ceilings. Every look:
//   - keeps skin a skin colour: the split tones are held back on skin hues
//     (skinProtect), and the orange and red bands keep more saturation than the
//     rest, so a cold or drained look never turns him grey or green;
//   - brings the white walls and ceiling panels down off the clip point (a soft
//     shoulder on the curve) so the panels stop reading as flat white;
//   - adds contrast through the middle of the curve, where skin and muscle sit, and
//     most add CLARITY, the local contrast pass that makes muscle lines read.
//
// Where each one comes from is written above it, so he can be told in a sentence.

import type { EffectDef } from './registry'
import { HUE_ONES, HUE_ZEROS, lookCompanions, lookGlsl, lookHelpers, type LookSpec } from './lookMath'

const NO_TINT = { hue: 0, strength: 0 }
/** Plain Rec.709 luma: a black and white picture with no colour filter. */
const LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const

export const LOOKS: readonly LookSpec[] = [
  // MOODY GYM. The "dark gym" grade the fitness creators run on CapCut and in
  // Resolve: exposure down, blacks crushed, highlights pulled in, colour drained
  // except skin, cool shadows, a heavy vignette and clarity for the muscle lines.
  {
    id: 'moodyGym',
    label: 'Moody Gym',
    description: 'Dark and moody: deep blacks, cool shadows, drained colour, skin kept warm. The classic dark gym edit.',
    exposure: -0.35,
    gain: [0.98, 1, 1.03],
    curve: [
      [0, 0],
      [0.12, 0.025],
      [0.3, 0.19],
      [0.55, 0.5],
      [0.8, 0.79],
      [1, 0.92],
    ],
    curveMix: 0.25,
    saturation: 0.8,
    hueSat: [1.15, 1.15, 0.65, 0.5, 0.75, 0.85, 0.6],
    hueLum: [1, 0.97, 0.9, 0.85, 0.9, 0.85, 1],
    hueShift: HUE_ZEROS,
    satShadows: 0.7,
    satHighlights: 0.6,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 205, strength: 0.08 },
    highlightTint: { hue: 38, strength: 0.015 },
    skinProtect: 0.85,
    vignette: { amount: 0.4, size: 0.42, feather: 0.45 },
    grain: { amount: 0.07, size: 1.6 },
    clarity: 0.35,
  },

  // TEAL AND ORANGE. The Hollywood blockbuster grade (Transformers and every
  // action film after it): skin sits in the orange, so pushing the background and
  // the shadows to its opposite, teal, makes the person pop off the frame.
  {
    id: 'tealOrange',
    label: 'Teal and Orange',
    description: 'Hollywood blockbuster colour: teal shadows and background, warm orange skin. Makes him pop off the frame.',
    exposure: 0,
    gain: [1, 1, 1],
    curve: [
      [0, 0.01],
      [0.22, 0.17],
      [0.5, 0.5],
      [0.78, 0.82],
      [1, 0.97],
    ],
    curveMix: 0.2,
    saturation: 1.05,
    hueSat: [1, 1.12, 0.9, 0.6, 1.2, 1.1, 0.6],
    hueLum: HUE_ONES,
    hueShift: [0, 0, -12, 45, 8, -28, -20],
    satShadows: 0.9,
    satHighlights: 0.85,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 188, strength: 0.16 },
    highlightTint: { hue: 32, strength: 0.07 },
    skinProtect: 0.7,
    vignette: { amount: 0.2, size: 0.45, feather: 0.45 },
    grain: { amount: 0.04, size: 1.6 },
    clarity: 0.2,
  },

  // FILM 800T. CineStill 800T: Kodak motion picture film made for tungsten light,
  // with its anti halation layer taken off. In white or mixed light it goes cool,
  // its blacks sit a little lifted, and every bright light gets the red halo the
  // stock is famous for. Strong grain.
  {
    id: 'film800T',
    label: 'Film 800T',
    description: 'CineStill 800T film: cool tungsten colour, red glow round bright lights, lifted blacks and strong grain.',
    exposure: 0.05,
    gain: [0.93, 1, 1.08],
    curve: [
      [0, 0.045],
      [0.2, 0.17],
      [0.5, 0.5],
      [0.8, 0.82],
      [1, 0.95],
    ],
    curveMix: 0.6,
    saturation: 0.95,
    hueSat: [1.1, 1.05, 0.85, 0.75, 1.1, 1, 0.9],
    hueLum: HUE_ONES,
    hueShift: [0, 0, 0, 20, 0, 0, 0],
    satShadows: 0.85,
    satHighlights: 0.8,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 192, strength: 0.06 },
    highlightTint: { hue: 25, strength: 0.02 },
    skinProtect: 0.75,
    vignette: { amount: 0.15, size: 0.48, feather: 0.45 },
    grain: { amount: 0.14, size: 2 },
    clarity: 0,
    halation: { radius: 0.012, threshold: 0.9, softness: 0.08, tint: [1, 0.2, 0.05], strength: 1.2, lumaTint: 1 },
    bloom: { radius: 0.03, threshold: 0.92, softness: 0.08, tint: [1, 1, 1], strength: 0.12, lumaTint: 0 },
  },

  // KODAK FILM. Kodak Vision3 500T scanned and printed onto Kodak 2383 print film,
  // the chain most feature films went through: rich contrast with a soft roll into
  // the highlights, warm highlights over slightly cyan shadows, olive greens, a
  // little halation and fine grain.
  {
    id: 'kodakFilm',
    label: 'Kodak Film',
    description: 'Kodak movie film: rich contrast, soft highlights, warm skin, olive greens, a little glow and fine grain.',
    exposure: 0,
    gain: [1.02, 1, 0.97],
    curve: [
      [0, 0.015],
      [0.15, 0.1],
      [0.4, 0.37],
      [0.62, 0.64],
      [0.85, 0.86],
      [1, 0.955],
    ],
    curveMix: 0.75,
    saturation: 1,
    hueSat: [1.05, 1.05, 0.85, 0.7, 0.9, 0.85, 0.8],
    hueLum: HUE_ONES,
    hueShift: [0, 0, -8, -15, 0, 0, 0],
    satShadows: 0.9,
    satHighlights: 0.85,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 192, strength: 0.05 },
    highlightTint: { hue: 38, strength: 0.05 },
    skinProtect: 0.5,
    vignette: { amount: 0.12, size: 0.48, feather: 0.45 },
    grain: { amount: 0.07, size: 1.6 },
    clarity: 0.1,
    halation: { radius: 0.009, threshold: 0.9, softness: 0.08, tint: [1, 0.28, 0.08], strength: 0.6, lumaTint: 1 },
  },

  // GRITTY. Bleach bypass: the film lab skips the bleach, the silver stays in, and
  // the picture comes out drained of colour with hard, metallic contrast and rough
  // grain (Saving Private Ryan, Se7en). Skin keeps a little more colour than the
  // rest so he still looks alive. Heavy clarity: every line cuts.
  {
    id: 'gritty',
    label: 'Gritty',
    description: 'Bleach bypass film: colour drained, hard metal contrast, rough grain. Every muscle line cuts.',
    exposure: 0,
    gain: [1, 1, 1.01],
    curve: [
      [0, 0],
      [0.15, 0.05],
      [0.35, 0.27],
      [0.5, 0.5],
      [0.65, 0.72],
      [0.85, 0.92],
      [1, 0.985],
    ],
    curveMix: 0,
    saturation: 0.45,
    hueSat: [1.25, 1.3, 1, 0.85, 0.9, 0.9, 0.9],
    hueLum: HUE_ONES,
    hueShift: HUE_ZEROS,
    satShadows: 0.8,
    satHighlights: 0.5,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 185, strength: 0.03 },
    highlightTint: { hue: 45, strength: 0.02 },
    skinProtect: 0.5,
    vignette: { amount: 0.25, size: 0.45, feather: 0.45 },
    grain: { amount: 0.16, size: 1.8 },
    clarity: 0.5,
  },

  // BLACK AND WHITE. The high contrast black and white of phonk gym edits and
  // physique shoots. Mixed through an orange filter, the way a black and white
  // photographer would: skin comes out bright, blue and cyan go dark, so the body
  // glows against the room. Crushed blacks, grain, a small glow on the lights.
  {
    id: 'blackWhite',
    label: 'Black and White',
    description: 'High contrast black and white: deep blacks, bright skin, grain and clarity. The phonk gym edit look.',
    exposure: 0,
    gain: [1, 1, 1],
    curve: [
      [0, 0],
      [0.1, 0.02],
      [0.3, 0.2],
      [0.5, 0.5],
      [0.7, 0.8],
      [0.9, 0.955],
      [1, 0.99],
    ],
    curveMix: 0,
    saturation: 1,
    hueSat: HUE_ONES,
    hueLum: HUE_ONES,
    hueShift: HUE_ZEROS,
    satShadows: 1,
    satHighlights: 1,
    mono: 1,
    monoWeights: [0.45, 0.47, 0.08],
    shadowTint: NO_TINT,
    highlightTint: NO_TINT,
    skinProtect: 0,
    vignette: { amount: 0.35, size: 0.42, feather: 0.45 },
    grain: { amount: 0.12, size: 1.7 },
    clarity: 0.45,
    bloom: { radius: 0.02, threshold: 0.9, softness: 0.08, tint: [1, 1, 1], strength: 0.15, lumaTint: 1 },
  },

  // GOLDEN HOUR. The warm late sun grade: golden highlights, amber shadows, peachy
  // skin in the Kodak Portra way (warm but never Instagram orange, which is what
  // the skin hold is for), soft lifted blacks and a warm bloom off the bright areas.
  {
    id: 'goldenHour',
    label: 'Golden Hour',
    description: 'Warm late sun: golden highlights, soft warm glow, peachy skin. Summer and sunset edits.',
    exposure: 0.05,
    gain: [1.06, 1, 0.9],
    curve: [
      [0, 0.03],
      [0.25, 0.235],
      [0.5, 0.52],
      [0.75, 0.78],
      [1, 0.97],
    ],
    curveMix: 0.4,
    saturation: 1.05,
    hueSat: [1, 0.95, 1.1, 0.75, 0.7, 0.75, 0.8],
    hueLum: HUE_ONES,
    hueShift: [0, 0, 0, -20, 0, 0, 0],
    satShadows: 0.9,
    satHighlights: 0.9,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 28, strength: 0.03 },
    highlightTint: { hue: 45, strength: 0.06 },
    skinProtect: 0.6,
    vignette: { amount: 0.15, size: 0.48, feather: 0.45 },
    grain: { amount: 0.05, size: 1.6 },
    clarity: 0,
    bloom: { radius: 0.035, threshold: 0.7, softness: 0.25, tint: [1, 0.8, 0.55], strength: 0.35, lumaTint: 0.3 },
  },

  // COLD STEEL. The cold thriller grade (David Fincher's films are the best known):
  // the world goes steel blue and grey, greens and yellows are drained, blacks go
  // deep, and skin is held back from the blue so he stays human against it.
  {
    id: 'coldSteel',
    label: 'Cold Steel',
    description: 'Cold and hard: steel blue shadows, grey drained colours, deep blacks, skin kept human. Thriller look.',
    exposure: -0.1,
    gain: [0.95, 1, 1.06],
    curve: [
      [0, 0],
      [0.15, 0.075],
      [0.5, 0.48],
      [0.85, 0.88],
      [1, 0.97],
    ],
    curveMix: 0.3,
    saturation: 0.75,
    hueSat: [0.95, 1.1, 0.5, 0.45, 1, 1, 0.5],
    hueLum: HUE_ONES,
    hueShift: [0, 0, 0, 30, 0, 0, 0],
    satShadows: 0.85,
    satHighlights: 0.7,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 205, strength: 0.08 },
    highlightTint: { hue: 195, strength: 0.04 },
    skinProtect: 0.85,
    vignette: { amount: 0.3, size: 0.44, feather: 0.45 },
    grain: { amount: 0.06, size: 1.6 },
    clarity: 0.35,
  },

  // BRONZE. The 300 grade (Zack Snyder): almost no colour left except a bronze
  // skin, brutal contrast with crushed blacks, the background drained to sepia.
  // The physique look of all physique looks; skin gets darker and richer, abs and
  // arms come out carved.
  {
    id: 'bronze',
    label: 'Bronze',
    description: 'The 300 movie look: bronze skin, sepia background, brutal contrast. Abs and arms come out carved.',
    exposure: -0.1,
    gain: [1.05, 1, 0.88],
    curve: [
      [0, 0],
      [0.15, 0.04],
      [0.35, 0.25],
      [0.5, 0.5],
      [0.7, 0.77],
      [0.9, 0.95],
      [1, 0.98],
    ],
    curveMix: 0.2,
    saturation: 0.6,
    hueSat: [1.2, 1.35, 1, 0.4, 0.4, 0.4, 0.5],
    hueLum: [0.97, 0.94, 0.95, 1, 1, 1, 1],
    hueShift: [8, 0, -15, 0, 0, 0, 0],
    satShadows: 0.8,
    satHighlights: 0.7,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 30, strength: 0.04 },
    highlightTint: { hue: 42, strength: 0.05 },
    skinProtect: 0.2,
    vignette: { amount: 0.4, size: 0.42, feather: 0.45 },
    grain: { amount: 0.1, size: 1.7 },
    clarity: 0.45,
  },

  // SOFT FILM. Fuji Eterna, the Fuji cinema stock: low contrast, matte lifted
  // blacks, muted colour with teal leaning greens and cyan shadows, very kind to
  // skin. The quiet indie film look, for the slower shots of a gym vlog.
  {
    id: 'softFilm',
    label: 'Soft Film',
    description: 'Fuji Eterna film: soft and matte, muted colour, teal greens, gentle on skin. The quiet indie film look.',
    exposure: 0,
    gain: [0.99, 1, 1],
    curve: [
      [0, 0.06],
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.74],
      [1, 0.93],
    ],
    curveMix: 0.5,
    saturation: 0.78,
    hueSat: [1.1, 1.1, 0.8, 0.85, 0.9, 0.8, 0.8],
    hueLum: HUE_ONES,
    hueShift: [0, 0, 0, 15, 0, 0, 0],
    satShadows: 0.85,
    satHighlights: 0.85,
    mono: 0,
    monoWeights: LUMA_WEIGHTS,
    shadowTint: { hue: 175, strength: 0.05 },
    highlightTint: { hue: 40, strength: 0.02 },
    skinProtect: 0.7,
    vignette: { amount: 0.1, size: 0.5, feather: 0.45 },
    grain: { amount: 0.08, size: 1.6 },
    clarity: 0,
  },
]

/** The effect type a look is stored under in a project. Never rename one: saved projects point at it. */
export const lookType = (spec: LookSpec): string => `look${spec.id[0].toUpperCase()}${spec.id.slice(1)}`

/** Every look's effect type, in shelf order. Also listed by name in registry.ts CANONICAL_ORDER (a test holds the two together). */
export const LOOK_TYPES: readonly string[] = LOOKS.map(lookType)

/**
 * What a look drops at. The look is DESIGNED at 1, so dropping it at 1 shows the
 * look as it was built; the slider takes it down from there.
 */
export const LOOK_START_AMOUNT = 1

/** One look as a registry entry. */
export function lookEffectDef(spec: LookSpec): EffectDef {
  const helpers = lookHelpers(spec)
  return {
    type: lookType(spec),
    label: spec.label,
    // "look" and "filter" in every description, so either word finds the whole shelf.
    description: `${spec.description} Cinematic look filter.`,
    category: 'look',
    pass: 'pointwise',
    initialParams: { amount: LOOK_START_AMOUNT },
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0 }],
    glslHelpers: helpers,
    glsl: (u) => lookGlsl(spec, u('amount')),
    companions: (params) => lookCompanions(spec, params.amount ?? 0),
  }
}

export const LOOK_EFFECT_DEFS: readonly EffectDef[] = LOOKS.map(lookEffectDef)

/** The spec behind a look effect type, for tests and the proof harness. */
export const lookSpecOf = (type: string): LookSpec | undefined => LOOKS.find((s) => lookType(s) === type)
