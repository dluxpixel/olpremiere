// The frozen render contract. resolve.ts produces a RenderFrame (pure, from a
// Sequence + time); glRenderer.ts consumes it and draws to a WebGL2 canvas.
// Preview (main thread) and export (worker) both go through the SAME resolver
// and the SAME renderer — that is what keeps them pixel-identical.

import type { BlendMode, ClipMask, Id, TitleDef } from '../types'

/** A transform fully resolved to numbers at a specific time (no keyframes left). */
export interface ResolvedTransform {
  /** Position offset in sequence px, from centered. */
  x: number
  y: number
  scale: number
  rotationDeg: number
  /** Anchor as 0..1 of the source frame (0.5 = center). */
  anchorX: number
  anchorY: number
  /** Crop as 0..1 fractions inset from each edge. */
  cropT: number
  cropR: number
  cropB: number
  cropL: number
}

/**
 * One effect, fully resolved to numbers at a specific time (no keyframes left).
 * `type` indexes the effect registry (engine/effects/registry.ts), which owns
 * the GLSL and the param definitions. Order within a layer's stack is the order
 * the effects apply, bottom-up.
 */
export interface ResolvedEffect {
  type: string
  params: Record<string, number>
}

/**
 * One drawable source. The caller resolves `assetId` + `sourceTimeS` to an
 * actual texture (video frame / image / decoded canvas) at draw time; the
 * renderer never touches decoding.
 */
export interface RenderLayer {
  clipId: Id
  assetId: Id
  /** Source-media time to sample for this layer's texture. */
  sourceTimeS: number
  /** Still image (no time sampling) — caller draws the image texture directly. */
  isImage: boolean
  /** Generated title (Phase 5): the caller rasterizes this to a texture. */
  title?: TitleDef
  /**
   * The clip's playback speed (negative = reverse). The live preview matches the
   * pooled <video>'s playbackRate to |speed| so a slowed clip's picture tracks
   * the compositor instead of drifting and re-seeking (audio already does this).
   * The export path ignores it — it decodes exact frames, never plays.
   */
  speed: number
  /**
   * The sequence-time frame index (round(t * fps)), identical in preview and
   * export at the same frame. Bound as `uSeed` so stochastic effects (grain)
   * animate per frame without breaking preview==export parity.
   */
  frameSeed: number
  transform: ResolvedTransform
  opacity: number
  /** How this layer composites over the tracks below it. */
  blendMode: BlendMode
  /** Optional shape mask, applied to layer alpha in source-UV space. */
  mask?: ClipMask
  /**
   * The ordered effect stack the renderer applies, keyframes already sampled
   * and neutral effects already dropped. Pointwise effects concatenate into one
   * fragment shader; neighborhood effects (blur) run as their own pass
   * afterwards, in this order.
   */
  effects: ResolvedEffect[]
}

export type TransitionKind =
  | 'crossDissolve'
  | 'dipToBlack'
  | 'dipToWhite'
  | 'wipeLeft'
  | 'wipeRight'
  | 'slideLeft'
  | 'slideRight'
  | 'zoom'
  | 'spin'
  | 'glitch'
  | 'lumaWipe'
  | 'whiteFlash'

export const TRANSITION_KINDS: TransitionKind[] = [
  'crossDissolve',
  'dipToBlack',
  'dipToWhite',
  'wipeLeft',
  'wipeRight',
  'slideLeft',
  'slideRight',
  'zoom',
  'spin',
  'glitch',
  'lumaWipe',
  'whiteFlash',
]

/** Human labels for the transition kinds — shared by the Effects panel + Inspector. */
export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossDissolve: 'Cross Dissolve',
  dipToBlack: 'Dip to Black',
  dipToWhite: 'Dip to White',
  wipeLeft: 'Wipe Left',
  wipeRight: 'Wipe Right',
  // Both shots travel together, which is a PUSH — calling it a slide (where
  // only the incoming shot moves) described a transition the app does not have.
  slideLeft: 'Push Left',
  slideRight: 'Push Right',
  zoom: 'Cross Zoom',
  spin: 'Spin',
  glitch: 'Glitch',
  lumaWipe: 'Luma Wipe',
  whiteFlash: 'White Flash',
}

/**
 * Per-kind duration envelope for the edit layer (default + clamp on set).
 *
 * Every kind used to default to a flat 1.000 second — inherited from the NLE
 * tradition where a dissolve joins two long takes. On a fast-cut Short a whole
 * second is HALF A SHOT, so the default made every transition read as a mistake:
 * the cut disappears into a mush instead of landing. The defaults below are per
 * VERB instead of per convention:
 *   - a HIT (glitch, flash) is over before you can name it — 150–200 ms;
 *   - a MOVE (zoom, spin, slide, wipe) has to be readable but must not steal
 *     the incoming shot — ~300 ms;
 *   - a BLEND (dissolve, dip, luma wipe) is the only one meant to feel like
 *     time passing, and even then 400–500 ms is plenty at this pacing.
 * The envelopes stay wide (a deliberate 3-second dissolve is still one drag
 * away); only the value you get for free changed. setClipTransition is the one
 * write path, so this table lands on drops, the Inspector, and every menu.
 */
const TRANSITION_DURATIONS: Record<TransitionKind, { def: number; min: number; max: number }> = {
  // Blends — the slowest verbs, and still well under a second.
  crossDissolve: { def: 0.4, min: 0.1, max: 10 },
  dipToBlack: { def: 0.5, min: 0.1, max: 10 },
  dipToWhite: { def: 0.4, min: 0.1, max: 10 },
  lumaWipe: { def: 0.4, min: 0.1, max: 10 },
  // Moves — readable, but they hand the frame over quickly.
  wipeLeft: { def: 0.3, min: 0.1, max: 10 },
  wipeRight: { def: 0.3, min: 0.1, max: 10 },
  slideLeft: { def: 0.3, min: 0.1, max: 10 },
  slideRight: { def: 0.3, min: 0.1, max: 10 },
  zoom: { def: 0.3, min: 0.1, max: 10 },
  spin: { def: 0.28, min: 0.1, max: 10 },
  // Hits — an accent on the cut, not a passage of time.
  glitch: { def: 0.18, min: 0.06, max: 2 },
  whiteFlash: { def: 0.2, min: 0.1, max: 0.5 },
}

export function transitionDurationSpec(kind: TransitionKind): { def: number; min: number; max: number } {
  return TRANSITION_DURATIONS[kind] ?? { def: 0.4, min: 0.1, max: 10 }
}

/**
 * An ordered draw op. `layer` draws one source with its transform+filters.
 * `transition` blends `from`→`to` by `progress` (0..1) using `kind`; dip
 * variants pass through a solid color at the midpoint. Ops render in array
 * order (bottom → top).
 */
export type RenderOp =
  | { type: 'layer'; layer: RenderLayer }
  | {
      type: 'transition'
      kind: TransitionKind
      progress: number
      from: RenderLayer
      to: RenderLayer
    }
  /**
   * An adjustment layer: apply `effects` (optionally through `mask`, scaled by
   * `opacity`) to the COMPOSITE of every op before this one. Forces the
   * renderer onto its accumulation-FBO path for the frame.
   */
  | {
      type: 'adjustment'
      effects: ResolvedEffect[]
      opacity: number
      mask?: ClipMask
      frameSeed: number
    }

export interface RenderFrame {
  width: number
  height: number
  ops: RenderOp[]
}

/** Resolve a texture for a layer; return null while it is still decoding. */
export type TextureSource = (layer: RenderLayer) => TexImageSource | null
