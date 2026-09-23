// Appearance animations (entrance / exit presets). A preset compiles to plain
// keyframes on the clip's transform + opacity channels, so it rides the SAME
// tested keyframe path the Inspector uses and is therefore preview == export by
// construction. This module never touches GL, DOM, or the store.
//
// Contract that makes entrance + exit composable on a shared channel:
//   - an ENTRANCE preset animates on [0, d] and ENDS at the settled (base) value.
//   - an EXIT preset animates on [D-d, D] and STARTS at the settled (base) value.
// So concatenating the two per channel holds the base value in the middle, and a
// channel touched by only one side clamps to base outside its window (evalChannel
// holds before the first / after the last keyframe).

import { channelBase, channelKeyframes, withChannelKeyframes } from '../effects/channels'
import { MOMENT_EPS } from '../keyframes'
import { clipDurationS } from '../types'
import type { AnimChannel, AppearanceSpec, Clip, Id, Keyframe, Project, Sequence } from '../types'

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

/**
 * Default entrance/exit window length, seconds.
 *
 * Half a second was inherited from motion-graphics defaults and reads slow on a
 * fast-cut edit: the animation is still arriving when the shot has moved on.
 * Every path this app builds FOR ITSELF (captions, the text presets) already
 * hardcodes 0.13 to 0.20 s, so the code knew the default was wrong long before the
 * audit said so. A quarter second lands: quick enough to feel like an accent,
 * long enough to read as motion rather than a pop-in.
 */
export const DEFAULT_APPEARANCE_DUR = 0.25

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
  /** Sequence width / height (px): slide/rise offsets scale to the frame. */
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

/**
 * THE POP, MEASURED OFF THE REFERENCE HE CHOSE, 2026-09-23.
 *
 * His words: "remember how we have the text animation called pop and bounce? I
 * don't think it's good enough. I wanted it to be something like in this
 * video", a word-by-word caption short (youtube.com/shorts/dq0fNTU-Nto).
 *
 * Measured, not eyeballed: the 1080x1920 60 fps copy was read frame by frame,
 * the white caption's width taken only from pixels touching its black outline
 * (so the background glare could not count), and six clean word entrances
 * averaged. Every one has the same shape:
 *
 *   frame @60fps   0      1      2      3      4      5      6
 *   reference      0.907  0.943  0.986  1.023  1.028  1.008  1.001
 *   this curve     0.910  0.948  0.986  1.024  1.030  1.010  1.000
 *
 * The word is there on its very first frame, fully opaque, just a touch small.
 * It grows at an even rate past full size, overshoots by a few percent a little
 * after the middle of the window, and eases back onto its resting size. That
 * fit is within a quarter of a percent on every frame (RMS 0.0025).
 *
 * What it replaced, and why it read as "not good enough": the old pop started
 * at 30% of the size and INVISIBLE, faded in, and overshot by 12%. On a word
 * that is on screen for a third of a second, most of its life was spent
 * growing, and the 12% swell is what made it read as a cartoon bounce rather
 * than a snap. The reference never fades and never shrinks the word below 91%.
 *
 * The easeInOut on the way back is deliberate: it leaves the overshoot from
 * rest and lands on the resting size at rest, the two things the curve tests
 * below hold every preset to, and it is inside the measurement noise.
 */
export const POP_FROM = 0.91
export const POP_PEAK = 1.035
/** Where in the window the overshoot lands, as a fraction of it. */
export const POP_PEAK_AT = 0.55

/**
 * The pop as it was compiled until 2026-09-23. It is not offered anywhere. It
 * exists ONLY so migrateProjectAppearance can recognise a clip it compiled, and
 * so a saved project's untouched pops can be rebuilt as the new one.
 */
const LEGACY_POP_BUILD = ({ d, base }: BuildCtx): ChannelKeyframes => ({
  scale: [kf(0, 0.3 * base.scale, 'easeOut'), kf(d * 0.6, 1.12 * base.scale, 'easeInOut'), kf(d, base.scale)],
  opacity: [kf(0, 0, 'easeOut'), kf(d * 0.45, base.opacity)],
})

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
    // See POP_FROM: fitted to his reference. Scale only. There is no opacity
    // channel on purpose: the word is fully there on its first frame.
    build: ({ d, base }) => ({
      scale: [
        kf(0, POP_FROM * base.scale, 'linear'),
        kf(d * POP_PEAK_AT, POP_PEAK * base.scale, 'easeInOut'),
        kf(d, base.scale),
      ],
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
  // CUT 2026-07-29, his call: "remove any effects that will not be used in the
  // Jettism style, like spin-outs, casual stuff no real editor will ever use."
  // Spin in and Bounce went with Spin out. A clip saved with one of them keeps
  // playing exactly as before, because the appearance is COMPILED to keyframes
  // on the clip and the id is only the label the Inspector shows.
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
      // Anticipation then action: swell to the peak and settle there
      // (easeInOut), then accelerate away from it (easeIn).
      scale: [
        kf(D - d, base.scale, 'easeInOut'),
        kf(D - d * 0.6, 1.12 * base.scale, 'easeIn'),
        kf(D, 0),
      ],
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
  // Spin out CUT 2026-07-29, the one he named. See the note on ENTRANCE_PRESETS.
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
 * The per-side window an appearance actually compiles into on a clip of duration
 * `D`: at least a couple of frames, and never longer than the clip can hold.
 * Shared so that anything reasoning about WHERE the animation lives reads the
 * same number the compiler used.
 *
 * ⛔ HALF THE CLIP ONLY WHEN THERE ARE TWO SIDES (2026-09-23). His words: "if
 * the word clip is too long, then why should the normal animation still be very
 * slow just because the text is long?" A speed is now the same number of
 * seconds on every clip, and the half-clip ceiling was the other thing still
 * tying it to length: it exists so an entrance cannot run into its own exit, yet
 * it also squeezed a clip that HAS no exit. A word caption only pops in, so on
 * any word shorter than twice the pop the pop ran faster than on its neighbours.
 * With one side, the whole clip is the room it has. `halfCeiling` is the old
 * rule, kept only so saved work compiled under it can be recognised
 * (upgradeLegacyAppearance).
 */
export function appearanceWindowS(spec: AppearanceSpec, D: number, halfCeiling = false): number {
  const twoSided = isEntranceId(spec.in) && isExitId(spec.out)
  const ceiling = twoSided || halfCeiling ? D / 2 : D
  return Math.max(1 / 60, Math.min(spec.durS ?? DEFAULT_APPEARANCE_DUR, ceiling))
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
  return compileWith(spec, D, W, H, base)
}

/**
 * A past version of the compiler, for recognising work it did. `entranceBuild`
 * stands in for the current build of `spec.in`; `halfCeiling` restores the
 * half-clip window on a one-sided appearance. Nothing but the legacy checks
 * passes one.
 */
interface PastCompiler {
  entranceBuild?: AppearancePreset['build']
  halfCeiling?: boolean
}

/** The compiler itself, or with `past`, a version of it this module used to be. */
function compileWith(
  spec: AppearanceSpec,
  D: number,
  W: number,
  H: number,
  base: AppearanceBase,
  past: PastCompiler = {},
): ChannelKeyframes {
  const { entranceBuild, halfCeiling } = past
  const d = appearanceWindowS(spec, D, halfCeiling)
  const ctx: BuildCtx = { d, D: Math.max(D, 2 / 60), W, H, base }

  const inK = !isEntranceId(spec.in) ? {} : (entranceBuild ?? ENTRANCE_BY_ID.get(spec.in!)!.build)(ctx)
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
 * settling to the clip's CURRENT static base, so a manually moved/scaled clip
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

// ---------------------------------------------------------------------------
// Keeping a compiled appearance TRUE as the clip's length changes.
//
// An exit preset is baked at absolute local times [D-d, D] from the duration the
// clip had when it was applied. Every edit that changes that duration (trim,
// ripple trim, roll, slide, rate stretch, speed) therefore strands it: extend a
// title's out edge and the fade fires at the OLD end, leaving opacity at 0 for
// the whole tail. The timeline engine calls retimeAppearance on both sides of
// every such edit so the compiled keyframes follow the clip.

/** Same times and values within float noise (keyframes are authored, not measured). */
const KF_MATCH_EPS = 1e-6

function sameKeyframes(a: readonly Keyframe[], b: readonly Keyframe[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].t - b[i].t) > KF_MATCH_EPS) return false
    if (Math.abs(a[i].value - b[i].value) > KF_MATCH_EPS) return false
    if ((a[i].ease ?? 'linear') !== (b[i].ease ?? 'linear')) return false
  }
  return true
}

/**
 * True when a clip's appearance-owned channels still hold EXACTLY what the spec
 * compiles to at duration `D`, i.e. nobody has hand-edited them since. The same
 * "only touch our own work" rule refitClipToFill uses: a recompile is safe only
 * while the keyframes are still ours.
 */
function appearanceIsUntouched(clip: Clip, D: number, seqW: number, seqH: number): boolean {
  return compiledBy(clip, D, seqW, seqH)
}

/** The clip's settled values, the base every compile is relative to. */
function baseOf(clip: Clip): AppearanceBase {
  return {
    opacity: channelBase(clip, 'opacity'),
    scale: channelBase(clip, 'scale'),
    posX: channelBase(clip, 'posX'),
    posY: channelBase(clip, 'posY'),
    rotation: channelBase(clip, 'rotation'),
  }
}

/**
 * True when the clip's appearance channels are exactly what its spec compiles
 * to, with the CURRENT compiler or, given `past`, with that past version.
 */
function compiledBy(clip: Clip, D: number, seqW: number, seqH: number, past?: PastCompiler): boolean {
  const spec = clip.appearance
  if (!spec) return false
  const expected = compileWith(spec, D, seqW, seqH, baseOf(clip), past)
  for (const ch of APPEARANCE_CHANNELS) {
    if (!sameKeyframes(channelKeyframes(clip, ch), expected[ch] ?? [])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Bringing saved work onto a preset that has since changed.
//
// A preset COMPILES to keyframes on the clip, so changing its build changes
// nothing that was already made: every caption in a saved project would keep
// the old pop forever, and he would open his project, see the old bounce, and
// reasonably conclude the fix did not work. Worse, the untouched-check above
// would stop recognising those clips as its own, so a trim would no longer move
// their exit with the clip.
//
// So on load, a clip whose appearance channels are EXACTLY what an old build of
// its entrance produced is rebuilt with the current one. Anything that differs
// at all (a hand-dragged diamond, a curve he shaped) is his, and is left alone,
// the same "only touch our own work" rule every recompile in this file follows.

/** Earlier builds of an entrance, by preset id, newest first. */
const LEGACY_ENTRANCE_BUILDS: Readonly<Record<string, readonly AppearancePreset['build'][]>> = {
  pop: [LEGACY_POP_BUILD],
}

/**
 * Every past compiler a saved clip could have been made by, newest first. Every
 * one of them had the half-clip window (it changed on 2026-09-23, after them
 * all), so each old entrance build is tried under it, and the current builds
 * are tried under it too.
 */
function pastCompilersFor(spec: AppearanceSpec): PastCompiler[] {
  const builds = spec.in ? (LEGACY_ENTRANCE_BUILDS[spec.in] ?? []) : []
  return [{ halfCeiling: true }, ...builds.map((entranceBuild) => ({ entranceBuild, halfCeiling: true }))]
}

/**
 * The clip rebuilt with the current compiler, when its keyframes are exactly
 * the untouched output of a past one (an older pop, or the half-clip window on
 * a clip with only one side). Otherwise the same object.
 */
export function upgradeLegacyAppearance(clip: Clip, seqW: number, seqH: number): Clip {
  const spec = clip.appearance
  if (!spec || isEmptyAppearance(spec)) return clip
  const D = clipDurationS(clip)
  if (!Number.isFinite(D) || D <= 0) return clip
  if (compiledBy(clip, D, seqW, seqH)) return clip
  for (const past of pastCompilersFor(spec)) {
    if (compiledBy(clip, D, seqW, seqH, past)) return applyAppearanceToClip(clip, spec, seqW, seqH)
  }
  return clip
}

/** upgradeLegacyAppearance over every clip. Returns the same object when nothing changed. */
export function migrateProjectAppearance(p: Project): Project {
  let changed = false
  const sequences: Record<Id, Sequence> = {}
  for (const [id, seq] of Object.entries(p.sequences)) {
    let seqChanged = false
    const tracks = seq.tracks.map((track) => {
      let trackChanged = false
      const clips = track.clips.map((clip) => {
        const next = upgradeLegacyAppearance(clip, seq.width, seq.height)
        if (next !== clip) trackChanged = true
        return next
      })
      if (!trackChanged) return track
      seqChanged = true
      return { ...track, clips }
    })
    if (seqChanged) {
      changed = true
      sequences[id] = { ...seq, tracks }
    } else {
      sequences[id] = seq
    }
  }
  return changed ? { ...p, sequences } : p
}

/**
 * Recompile `next`'s appearance for its NEW duration, given the clip as it was
 * (`prev`). Returns `next` untouched when the clip has no appearance, when the
 * duration did not actually change, or when the compiled keyframes no longer
 * match the spec. That last case means the author has since edited them by
 * hand, and a trim must never silently overwrite hand-authored animation.
 */
export function retimeAppearance(prev: Clip, next: Clip, seqW: number, seqH: number): Clip {
  const spec = next.appearance
  if (!spec || isEmptyAppearance(spec)) return next
  const oldD = clipDurationS(prev)
  const newD = clipDurationS(next)
  if (!Number.isFinite(newD) || newD <= 0) return next
  if (Math.abs(oldD - newD) < 1e-9) return next
  if (!appearanceIsUntouched(prev, oldD, seqW, seqH)) return next
  return applyAppearanceToClip(next, spec, seqW, seqH)
}

/**
 * Rebake an appearance for a NEW frame size, given the one it was compiled at.
 *
 * Four presets bake the frame into their keyframe VALUES: slideIn and slideOut
 * travel `W/2`, riseUp and dropDown `H*0.35`. Switching 16:9 → 9:16 therefore
 * left them sliding the OLD frame's distance, and, worse, permanently disarmed
 * every later retime: the untouched-guard rebuilds its expectation from the
 * CURRENT size, so keyframes baked at the old one could never match again and a
 * trim silently stopped following the clip, forever.
 *
 * Only rebakes while the keyframes are still exactly what the spec compiled at
 * the OLD size, the same "only touch our own work" rule as everywhere else.
 */
export function refitAppearanceToFrame(
  clip: Clip,
  seqW: number,
  seqH: number,
  prevW: number,
  prevH: number,
): Clip {
  const spec = clip.appearance
  if (!spec || isEmptyAppearance(spec)) return clip
  if (prevW <= 0 || prevH <= 0) return clip
  if (seqW === prevW && seqH === prevH) return clip
  if (!appearanceIsUntouched(clip, clipDurationS(clip), prevW, prevH)) return clip
  return applyAppearanceToClip(clip, spec, seqW, seqH)
}

/**
 * Hand-retiming a compiled keyframe PROMOTES the clip off its preset.
 *
 * A preset owns its channels and every later transform edit recompiles them from
 * the spec, so a retimed diamond was thrown away by the very next gizmo drag:
 * the clip showed grabbable keyframes it did not actually honour. Dragging one is
 * an unambiguous act of authorship, so the keyframes become the AUTHOR'S: they
 * stay exactly as retimed and nothing recompiles them again. (A trim already
 * refused to, via appearanceIsUntouched; this closes the same hole on the gizmo.)
 *
 * Only a moment that actually moves an appearance-owned channel promotes. A
 * keyframed effect param at some other instant leaves the preset alone.
 */
export function releaseAppearanceOnRetime(prev: Clip, next: Clip, fromT: number): Clip {
  if (!prev.appearance) return next
  const touched = APPEARANCE_CHANNELS.some((ch) =>
    channelKeyframes(prev, ch).some((k) => Math.abs(k.t - fromT) <= MOMENT_EPS),
  )
  return touched ? withoutAppearance(next) : next
}

/** A cut landing this close to a window edge counts as landing ON it. */
const CUT_EPS = 1e-6

/** The clip with its keyframes intact but no longer owned by a preset. */
function withoutAppearance(clip: Clip): Clip {
  if (!clip.appearance) return clip
  const next: Clip = { ...clip }
  delete next.appearance
  return next
}

/**
 * Split an appearance spec across a cut, the same way splitClip splits every
 * other edge-owned decoration: the LEFT half's out edge is now a hard cut so it
 * keeps only the entrance, the RIGHT half only the exit. Returns undefined when
 * a half animates nothing.
 */
export function splitAppearanceSpec(
  spec: AppearanceSpec | undefined,
  side: 'left' | 'right',
): AppearanceSpec | undefined {
  if (!spec) return undefined
  const kept: AppearanceSpec = side === 'left' ? { ...spec, out: undefined } : { ...spec, in: undefined }
  if (isEmptyAppearance(kept)) return undefined
  if (kept.in === undefined) delete kept.in
  if (kept.out === undefined) delete kept.out
  return kept
}

/**
 * Re-derive both halves of a cut from the split spec, so each half's SPEC and
 * its compiled keyframes still agree, which is what lets a later trim retime
 * them. The generic keyframe time-split already produces the right MOTION; this
 * replaces it with the canonical compile of the same thing (identical to
 * evaluate, minus the redundant boundary keyframe the time-split leaves behind).
 *
 * Declines, leaving splitClip's time-split result exactly as it was, when the
 * original clip's appearance channels had been hand-edited, the same "only
 * touch our own work" rule retimeAppearance uses.
 */
export function splitAppearanceAcrossCut(
  original: Clip,
  left: Clip,
  right: Clip,
  seqW: number,
  seqH: number,
): { left: Clip; right: Clip } {
  const spec = original.appearance
  if (!spec || isEmptyAppearance(spec)) return { left, right }
  const D = clipDurationS(original)
  if (!appearanceIsUntouched(original, D, seqW, seqH)) return { left, right }

  // The canonical recompile only reproduces the original MOTION while each
  // window lands entirely on one side of the cut. Cut INSIDE one and the half
  // that does not own that edge has its appearance channels cleared: cut 0.1s
  // into a 0.25s entrance and the right half (still mid-entrance) snaps to the
  // settled value, so the cut CHANGES THE PICTURE, the one thing a split must
  // never do. splitClip's time-split already carries the motion across
  // correctly, boundary keyframe and all, so keep it and let both halves off the
  // spec: their keyframes are no longer anything this compiler can reproduce.
  const d = appearanceWindowS(spec, D)
  const cutAt = clipDurationS(left)
  const insideEntrance = isEntranceId(spec.in) && cutAt < d - CUT_EPS
  const insideExit = isExitId(spec.out) && cutAt > D - d + CUT_EPS
  if (insideEntrance || insideExit) {
    return { left: withoutAppearance(left), right: withoutAppearance(right) }
  }

  return {
    left: applyAppearanceToClip(left, splitAppearanceSpec(spec, 'left') ?? {}, seqW, seqH),
    right: applyAppearanceToClip(right, splitAppearanceSpec(spec, 'right') ?? {}, seqW, seqH),
  }
}
