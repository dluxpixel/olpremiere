// One-way migration of the pre-registry document shape into the effect stack,
// and of effect TYPES the registry has since split.
//
// Before: a clip carried a flat `filters` bag and animated its colour via
// clip.keyframes.brightness, clip.keyframes.lift, and so on.
// After: those live inside clip.effects, as params of the effect that owns them.
//
// Runs on load (persistence.ts) and on project-file import (projectFile.ts),
// after migrateProject. Idempotent: running it twice changes nothing, and a
// clip with nothing to move comes back as the SAME object so
// migrateProjectEffects can detect "unchanged" by identity.
//
// Lives here rather than in engine/types.ts because it needs the registry, and
// types.ts is what the registry ultimately depends on.

import type { AnimChannel, Clip, ClipFilters, EffectInstance, Id, Keyframe, Project, Sequence } from '../types'
import {
  addrDefault,
  effectParamBase,
  withEffectParamKeyframes,
  withEffectParamValue,
  type EffectAddr,
} from './channels'
import { isAnimated } from './registry'

/**
 * Where each channel of the ANCIENT `filters` bag lands.
 *
 * FROZEN, and deliberately NOT sourced from `CHANNEL_EFFECT`. The two agreed
 * until Brightness split in two, and they must never be tied back together.
 *
 * A number stored in `filters.brightness` was written for the pre-registry
 * shader, where brightness ADDED: 0.3 meant "+0.3 on every channel". The live
 * `brightness` channel now addresses the new MULTIPLICATIVE effect, where the
 * same 0.3 means a 1.23x gain. `brightnessContrast` is the only effect that
 * still reads the stored number the way it was written, so that is where these
 * values go. Pointing this map at CHANNEL_EFFECT would silently regrade every
 * project he saved before the effect stack existed, and he would have no way to
 * tell which of his shorts had changed.
 */
const LEGACY_FILTER_ADDR: Readonly<Partial<Record<AnimChannel, EffectAddr>>> = Object.freeze({
  exposure: { type: 'exposure', param: 'exposure' },
  lift: { type: 'colorWheels', param: 'lift' },
  gamma: { type: 'colorWheels', param: 'gamma' },
  gain: { type: 'colorWheels', param: 'gain' },
  temperature: { type: 'whiteBalance', param: 'temperature' },
  tint: { type: 'whiteBalance', param: 'tint' },
  brightness: { type: 'brightnessContrast', param: 'brightness' },
  contrast: { type: 'brightnessContrast', param: 'contrast' },
  saturation: { type: 'saturation', param: 'saturation' },
  blur: { type: 'gaussianBlur', param: 'blur' },
})

const COLOR_CHANNELS = Object.keys(LEGACY_FILTER_ADDR) as AnimChannel[]

/** Did this clip carry any pre-registry colour state at all? */
function hasLegacyColor(clip: Clip): boolean {
  if (clip.filters && Object.values(clip.filters).some((v) => typeof v === 'number' && v !== 0)) return true
  return COLOR_CHANNELS.some((ch) => (clip.keyframes?.[ch]?.length ?? 0) > 0)
}

/** Shed the legacy bag without disturbing anything else. */
function withoutFilters(clip: Clip): Clip {
  const next: Clip = { ...clip }
  delete next.filters
  return next
}

/** The `filters` bag and its colour keyframes, moved into the effect stack. */
function migrateLegacyFilters(clip: Clip): Clip {
  const alreadyMigrated = clip.effects.length > 0
  if (alreadyMigrated || !hasLegacyColor(clip)) {
    // Nothing to move. Return the SAME object when there is no bag to shed, so
    // migrateProjectEffects can detect "unchanged" by identity.
    return clip.filters ? withoutFilters(clip) : clip
  }

  let next: Clip = { ...clip, effects: [] }

  // Static values first, so the keyframe pass below can read the correct base
  // when it de-animates, and so each effect materialises at its canonical position.
  for (const ch of COLOR_CHANNELS) {
    const addr = LEGACY_FILTER_ADDR[ch]
    if (!addr) continue
    const value = clip.filters?.[ch as keyof ClipFilters]
    if (typeof value === 'number' && value !== addrDefault(addr)) next = withEffectParamValue(next, addr, value)
  }

  // Then move each animated colour channel into its effect's param.
  for (const ch of COLOR_CHANNELS) {
    const addr = LEGACY_FILTER_ADDR[ch]
    if (!addr) continue
    const kfs: Keyframe[] | undefined = clip.keyframes?.[ch]
    if (kfs && kfs.length > 0) {
      next = withEffectParamKeyframes(next, addr, effectParamBase(next, addr, addrDefault(addr)), kfs)
    }
  }

  // Shed the migrated channels and the legacy bag. Transform/opacity keyframes
  // stay exactly where they were.
  const keyframes: Partial<Record<AnimChannel, Keyframe[]>> = { ...next.keyframes }
  for (const ch of COLOR_CHANNELS) delete keyframes[ch]

  return { ...withoutFilters(next), keyframes }
}

/**
 * Rewrite `brightnessContrast` instances that carry NO brightness onto the new
 * standalone Contrast effect, and leave every other one exactly as it is.
 *
 * WHY NOTHING ELSE IS CONVERTED. Old brightness ADDS (`c += b`), new brightness
 * MULTIPLIES (`c *= pow(2, b)`), and no single scalar turns one into the other:
 * making `in + b == in * g` hold needs `g = 1 + b / in`, which depends on the
 * pixel. The closest honest thing is to match at ONE tone, mid grey, which gives
 * `g = 1 + 2b`, so the converted slider value would be `log2(1 + 2b)`: 0.3
 * becomes 0.678. That lands the right answer on 50% grey and the wrong one on
 * every other value in the frame, it is undefined at or below b = -0.5
 * (`log2(0)`), it overflows the +1 end above b = 0.5, and above all it DARKENS
 * blacks he has already published, because the old maths was lifting them to
 * grey and the new maths leaves them at zero. So there is no faithful conversion
 * and none is attempted. A stored additive brightness keeps rendering through
 * `brightnessContrast`, whose shader and params are frozen, so those clips come
 * back byte for byte. That effect is merely hidden, so nothing new can reach it.
 *
 * WHY CONTRAST IS THE EXCEPTION. The new Contrast shader is the second line of
 * the old one, character for character (brightness.test.ts pins the two strings
 * against each other), and `c += 0.0` is the identity on every finite float. So
 * when brightness is a STATIC 0 this rewrite provably cannot move a pixel.
 *
 * AND WHY IT IS NOT COSMETIC. `brightnessContrast { brightness: 0, contrast:
 * 0.1 }` is exactly what the punch grade used to deposit, on every clip it has
 * ever touched. `hasJettismGrade` (lookActions.ts) recognises an already-graded
 * clip by matching type + params against what `jettismGradeEffects()` returns
 * today. Now that the grade emits `contrast`, without this rewrite that match
 * fails on every old clip, and a second click stacks the grade twice and blows
 * it out. That regression has been fixed once already; see the comment above
 * applyPunchyGrade.
 *
 * A KEYFRAMED brightness is never split, even where it currently reads 0, for
 * the same reason `isNeutral` refuses to: it leaves 0 later.
 *
 * The instance is replaced IN PLACE, keeping its id and its index in the stack.
 * Pointwise bodies are concatenated in stack order, so moving it would change
 * the math order; keeping the id keeps every Inspector row, undo entry and
 * selection pointing at it alive.
 */
function splitBrightnessContrast(clip: Clip): Clip {
  let changed = false
  const effects: EffectInstance[] = clip.effects.map((inst) => {
    if (inst.type !== 'brightnessContrast') return inst
    const brightness = inst.params.brightness
    // Absent counts as neutral: resolveEffectParams falls back to the default.
    if (brightness !== undefined && (isAnimated(brightness) || brightness !== 0)) return inst
    changed = true
    const contrast = inst.params.contrast
    return { ...inst, type: 'contrast', params: { contrast: contrast === undefined ? 0 : contrast } }
  })
  return changed ? { ...clip, effects } : clip
}

export function migrateClipEffects(clip: Clip): Clip {
  // Order matters: the filters pass can PRODUCE a brightnessContrast instance
  // (an ancient bag carrying only `contrast`), and the split then gives that
  // project a clean modern Contrast card. The reverse order would miss it.
  return splitBrightnessContrast(migrateLegacyFilters(clip))
}

/** Migrate every clip of every sequence. Returns the same object when nothing changed. */
export function migrateProjectEffects(p: Project): Project {
  let changed = false
  const sequences: Record<Id, Sequence> = {}
  for (const [id, seq] of Object.entries(p.sequences)) {
    let seqChanged = false
    const tracks = seq.tracks.map((track) => {
      let trackChanged = false
      const clips = track.clips.map((clip) => {
        const next = migrateClipEffects(clip)
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
