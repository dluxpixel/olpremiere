// The frozen render contract. resolve.ts produces a RenderFrame (pure, from a
// Sequence + time); glRenderer.ts consumes it and draws to a WebGL2 canvas.
// Preview (main thread) and export (worker) both go through the SAME resolver
// and the SAME renderer — that is what keeps them pixel-identical.

import type { Id, TitleDef } from '../types'

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

/** Color/blur, all neutral at 0. */
export interface ResolvedFilters {
  brightness: number
  contrast: number
  saturation: number
  exposure: number
  /** Gaussian radius in output px. */
  blur: number
  // Color correction (Phase 7); all neutral at 0.
  lift: number
  gamma: number
  gain: number
  temperature: number
  tint: number
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
  transform: ResolvedTransform
  opacity: number
  filters: ResolvedFilters
}

export type TransitionKind =
  | 'crossDissolve'
  | 'dipToBlack'
  | 'dipToWhite'
  | 'wipeLeft'
  | 'wipeRight'
  | 'slideLeft'
  | 'slideRight'

export const TRANSITION_KINDS: TransitionKind[] = [
  'crossDissolve',
  'dipToBlack',
  'dipToWhite',
  'wipeLeft',
  'wipeRight',
  'slideLeft',
  'slideRight',
]

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

export interface RenderFrame {
  width: number
  height: number
  ops: RenderOp[]
}

/** Resolve a texture for a layer; return null while it is still decoding. */
export type TextureSource = (layer: RenderLayer) => TexImageSource | null

export const NEUTRAL_FILTERS: ResolvedFilters = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  blur: 0,
  lift: 0,
  gamma: 0,
  gain: 0,
  temperature: 0,
  tint: 0,
}
