// Appearance animations (entrance / exit presets). A preset compiles to plain
// keyframes on the clip's transform + opacity channels, so it rides the SAME
// tested keyframe path the Inspector uses and is therefore preview == export by
// construction — this module never touches GL, DOM, or the store.
//
// Contract that makes entrance + exit composable on a shared channel:
//   - an ENTRANCE preset animates on [0, d] and ENDS at the settled (base) value.
//   - an EXIT preset animates on [D-d, D] and STARTS at the settled (base) value.
// So concatenating the two per channel holds the base value in the middle, and a
// channel touched by only one side clamps to base outside its window (evalChannel
// holds before the first / after the last keyframe).

import { channelBase, withChannelKeyframes } from '../effects/channels'
import { clipDurationS } from '../timeline'
import type { AnimChannel, AppearanceSpec, Clip, Keyframe } from '../types'

export type { AppearanceSpec }

export type ChannelKeyframes = Partial<Record<AnimChannel, Keyframe[]>>

/** Channels an appearance preset is allowed to drive (it OWNS these). */
export const APPEARANCE_CHANNELS: readonly AnimChannel[] = [
  'opacity',
  'scale',
  'posX',
  'posY',
  'rotation',
]

/** Default entrance/exit window length in seconds. */
export const DEFAULT_APPEARANCE_DUR = 0.5

/** The clip's settled values each channel returns to (its static base). */
export interface AppearanceBase {
  opacity: number
  scale: number
  posX: number
  posY: number
  rotation: number
}

const NEUTRAL_BASE: AppearanceBase = { opacity: 1, scale: 1, posX: 0, posY: 0, rotation: 0 }

interface BuildCtx {
  /** Window length (seconds), already clamped so in + out never overlap. */
  d: number
  /** Full clip duration (seconds). */
  D: number
  /** Sequence width / height (px) — slide/rise offsets scale to the frame. */
  W: number
  H: number
  base: AppearanceBase
}

export interface AppearancePreset {
  id: string
  label: string
  build: (c: BuildCtx) => ChannelKeyframes
}

const kf = (t: number, value: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, value, ease })

// --- Entrance presets: animate on [0, d], settle to base at the window end. ---

export const ENTRANCE_PRESETS: AppearancePreset[] = [
  {
    id: 'fadeIn',
    label: 'Fade in',
    build: ({ d, base }) => ({ opacity: [kf(0, 0, 'easeOut'), kf(d, base.opacity)] }),
  },
  {
    id: 'pop',
    label: 'Pop / Bang',
    build: ({ d, base }) => ({
      // Overshoot past the base then settle back — the "bang".
      scale: [kf(0, 0.3 * base.scale, 'easeOut'), kf(d * 0.6, 1.12 * base.scale, 'easeOut'), kf(d, base.scale)],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.45, base.opacity)],
    }),
  },
  {
    id: 'slideIn',
    label: 'Slide in (left)',
    build: ({ d, W, base }) => ({
      posX: [kf(0, base.posX - W * 0.5, 'easeOut'), kf(d, base.posX)],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.6, base.opacity)],
    }),
  },
  {
    id: 'zoomIn',
    label: 'Zoom in',
    build: ({ d, base }) => ({
      scale: [kf(0, 0, 'easeOut'), kf(d, base.scale)],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.5, base.opacity)],
    }),
  },
  {
    id: 'riseUp',
    label: 'Rise up',
    build: ({ d, H, base }) => ({
      posY: [kf(0, base.posY + H * 0.35, 'easeOut'), kf(d, base.posY)],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.6, base.opacity)],
    }),
  },
  {
    id: 'spinIn',
    label: 'Spin in',
    build: ({ d, base }) => ({
      rotation: [kf(0, base.rotation - 180, 'easeOut'), kf(d, base.rotation)],
      scale: [kf(0, 0.2 * base.scale, 'easeOut'), kf(d, base.scale)],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.5, base.opacity)],
    }),
  },
  {
    id: 'bounce',
    label: 'Bounce (pop bigger)',
    build: ({ d, base }) => ({
      // Pops in, overshoots BIGGER than normal, dips slightly, settles — a bouncy
      // emphasis on the entrance.
      scale: [
        kf(0, 0.5 * base.scale, 'easeOut'),
        kf(d * 0.55, 1.25 * base.scale, 'easeOut'),
        kf(d * 0.8, 0.95 * base.scale, 'easeIn'),
        kf(d, base.scale, 'easeOut'),
      ],
      opacity: [kf(0, 0, 'easeOut'), kf(d * 0.3, base.opacity)],
    }),
  },
]

// --- Exit presets: animate on [D-d, D], start from base at the window start. ---

export const EXIT_PRESETS: AppearancePreset[] = [
  {
    id: 'fadeOut',
    label: 'Fade out',
    build: ({ d, D, base }) => ({ opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)] }),
  },
  {
    id: 'popOut',
    label: 'Pop out',
    build: ({ d, D, base }) => ({
      scale: [kf(D - d, base.scale, 'easeIn'), kf(D - d * 0.6, 1.12 * base.scale, 'easeIn'), kf(D, 0)],
      opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)],
    }),
  },
  {
    id: 'slideOut',
    label: 'Slide out (right)',
    build: ({ d, D, W, base }) => ({
      posX: [kf(D - d, base.posX, 'easeIn'), kf(D, base.posX + W * 0.5)],
      opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)],
    }),
  },
  {
    id: 'zoomOut',
    label: 'Zoom out',
    build: ({ d, D, base }) => ({
      scale: [kf(D - d, base.scale, 'easeIn'), kf(D, 0)],
      opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)],
    }),
  },
  {
    id: 'dropDown',
    label: 'Drop down',
    build: ({ d, D, H, base }) => ({
      posY: [kf(D - d, base.posY, 'easeIn'), kf(D, base.posY + H * 0.35)],
      opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)],
    }),
  },
  {
    id: 'spinOut',
    label: 'Spin out',
    build: ({ d, D, base }) => ({
      rotation: [kf(D - d, base.rotation, 'easeIn'), kf(D, base.rotation + 180)],
      scale: [kf(D - d, base.scale, 'easeIn'), kf(D, 0)],
      opacity: [kf(D - d, base.opacity, 'easeIn'), kf(D, 0)],
    }),
  },
]

const ENTRANCE_BY_ID = new Map(ENTRANCE_PRESETS.map((p) => [p.id, p]))
const EXIT_BY_ID = new Map(EXIT_PRESETS.map((p) => [p.id, p]))

export const isEntranceId = (id: string | undefined): boolean => !!id && ENTRANCE_BY_ID.has(id)
export const isExitId = (id: string | undefined): boolean => !!id && EXIT_BY_ID.has(id)

/** True when the spec animates nothing (used to drop an empty appearance). */
export const isEmptyAppearance = (s: AppearanceSpec | undefined): boolean =>
  !s || (!isEntranceId(s.in) && !isExitId(s.out))

/** Sort by time and drop keyframes that collide (within eps) with the previous. */
function normalize(kfs: Keyframe[]): Keyframe[] {
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const out: Keyframe[] = []
  for (const k of sorted) {
    if (out.length > 0 && Math.abs(out[out.length - 1].t - k.t) < 1e-4) continue
    out.push(k)
  }
  return out
}

/**
 * Compile an appearance spec into concrete keyframes per channel for a clip of
 * duration `D` at sequence size `W`×`H`, settling to `base` (the clip's static
 * values). Entrance and exit are merged per channel; the window `d` is clamped so
 * the two halves never overlap on a short clip.
 */
export function buildAppearanceKeyframes(
  spec: AppearanceSpec,
  D: number,
  W: number,
  H: number,
  base: AppearanceBase = NEUTRAL_BASE,
): ChannelKeyframes {
  const durS = spec.durS ?? DEFAULT_APPEARANCE_DUR
  // At least a couple of frames; never more than half the clip so in ⟂ out.
  const d = Math.max(1 / 60, Math.min(durS, D / 2))
  const ctx: BuildCtx = { d, D: Math.max(D, 2 / 60), W, H, base }

  const inK = isEntranceId(spec.in) ? ENTRANCE_BY_ID.get(spec.in!)!.build(ctx) : {}
  const outK = isExitId(spec.out) ? EXIT_BY_ID.get(spec.out!)!.build(ctx) : {}

  const result: ChannelKeyframes = {}
  for (const ch of APPEARANCE_CHANNELS) {
    const merged = [...(inK[ch] ?? []), ...(outK[ch] ?? [])]
    if (merged.length > 0) result[ch] = normalize(merged)
  }
  return result
}

/**
 * Pure clip operation: rebuild a clip's appearance-owned channels from `spec`,
 * settling to the clip's CURRENT static base — so a manually moved/scaled clip
 * still returns to where the user put it, and re-applying after a transform edit
 * re-derives the animation from the new base. An empty spec clears the animation
 * and drops the field. Reused by the menu actions, new-title creation, and the
 * gizmo drag-commit. Never mutates.
 */
export function applyAppearanceToClip(clip: Clip, spec: AppearanceSpec, seqW: number, seqH: number): Clip {
  const base: AppearanceBase = {
    opacity: channelBase(clip, 'opacity'),
    scale: channelBase(clip, 'scale'),
    posX: channelBase(clip, 'posX'),
    posY: channelBase(clip, 'posY'),
    rotation: channelBase(clip, 'rotation'),
  }
  // Appearance OWNS these channels: clear them, then write the compiled set.
  let next = clip
  for (const ch of APPEARANCE_CHANNELS) next = withChannelKeyframes(next, ch, [])

  if (isEmptyAppearance(spec)) {
    const cleared: Clip = { ...next }
    delete cleared.appearance
    return cleared
  }

  const kfMap = buildAppearanceKeyframes(spec, clipDurationS(clip), seqW, seqH, base)
  for (const ch of APPEARANCE_CHANNELS) {
    const kfs = kfMap[ch]
    if (kfs && kfs.length > 0) next = withChannelKeyframes(next, ch, kfs)
  }
  return { ...next, appearance: spec }
}
