// Entrance / exit "appearance" animations. A tiny AppearanceSpec on the clip
// COMPILES to keyframes on the transform + opacity channels, so the animation
// runs through the same tested keyframe path as everything else (preview ==
// export). Appearance OWNS those channels: applying rebuilds them from the spec,
// clearing removes them.

import { applyAppearanceToClip, isEmptyAppearance } from '../engine/anim/appearance'
import { clipDurationS } from '../engine/timeline'
import { activeSequence, type AppearanceSpec, type Clip } from '../engine/types'
import { db } from './persistence'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

export { applyAppearanceToClip }

function findClip(clipId: string): Clip | undefined {
  return activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
}

/**
 * Merge an appearance patch into EVERY clip in `ids` and recompile, in ONE undo
 * step. Merging (not replacing) means changing the speed keeps the entrance, and
 * vice-versa. This is what makes the right-click animation menu apply to the
 * whole selection.
 */
export function setClipsAppearance(ids: Iterable<string>, patch: Partial<AppearanceSpec>): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const label = 'in' in patch ? 'Set entrance' : 'out' in patch ? 'Set exit' : 'Set animation'
  updateActiveSequence(label, (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id)) return c
        // Never touch a clip with no animation unless we're ADDING an entrance/exit.
        // applyAppearanceToClip clears the shared transform/opacity channels, so a
        // Speed/None/Clear op would silently wipe a clip's own manual keyframes.
        if (!c.appearance && !patch.in && !patch.out) return c
        changed = true
        return applyAppearanceToClip(c, { ...c.appearance, ...patch }, seq.width, seq.height)
      })
      return { ...t, clips }
    })
    return changed ? { ...seq, tracks } : seq
  })
}

/** Auto window: shorter clips get a shorter animation. Clamped so it always reads. */
export const autoAppearanceDur = (clipDurS: number): number =>
  Math.max(0.08, Math.min(0.6, clipDurS * 0.4))

/**
 * EVERY SPEED IS A SHARE OF THE CLIP, not a fixed number of seconds.
 *
 * His words, 2026-08-06: "some speeds are just not actually very slow, and the
 * very fast is really, really fast. There are just too many options."
 *
 * Both halves of that were one bug. The ladder was absolute seconds (0.1 up to
 * 1.0) while appearanceWindowS clamps the window to HALF the clip, and the
 * clips this is used on are per-word captions about a third of a second long.
 * So on a real caption, Normal, Relaxed, Slow and Very slow all clamped to the
 * SAME 0.15s: four rungs of the ladder that did nothing, which is exactly "some
 * speeds are not actually very slow". Meanwhile Instant stayed a true 0.1s and
 * so was the only one that visibly changed anything, which is "very fast is
 * really, really fast".
 *
 * Sizing each rung to the clip is what 'auto' has always done. Doing it for all
 * of them makes every rung distinct on a short word AND on a long title, and it
 * needs no new field and no migration: what is stored is still plain seconds.
 */
/** The slowest rung the menu offers. The whole ladder is scaled against it. */
export const SLOWEST_APPEARANCE_FRAC = 0.46
/** However long the clip, the slowest animation stops here. */
const MAX_APPEARANCE_S = 0.8

export const appearanceDurFor = (frac: number, clipDurS: number): number => {
  // SCALE the ladder, never clamp the rungs individually. A per-rung clamp
  // reintroduces the exact bug this replaced, just at the other end: on a two
  // and a half second title, Smooth (0.34) and Slow (0.46) both wanted more
  // than the 0.8s ceiling and both got 0.8, so two rungs did the same thing
  // again. Working out what the SLOWEST rung is allowed on this clip and
  // placing the others in proportion keeps every rung distinct at both ends.
  const span = Math.min(clipDurS * SLOWEST_APPEARANCE_FRAC, MAX_APPEARANCE_S)
  return Math.max(1 / 30, span * (frac / SLOWEST_APPEARANCE_FRAC))
}

/**
 * Set the animation SPEED (window length) on every clip. `'auto'` sizes each
 * clip's window to ITS OWN duration (long words animate slower, short words
 * snappier), which is what David asked for.
 */
export function setClipsAppearanceDur(ids: Iterable<string>, durS: number | 'auto' | { frac: number }): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  updateActiveSequence('Animation speed', (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id)) return c
        // Speed only means something for a clip that HAS an entrance/exit; applying
        // it to an un-animated clip would wipe its manual keyframes for nothing.
        if (!c.appearance) return c
        changed = true
        const d =
          durS === 'auto'
            ? autoAppearanceDur(clipDurationS(c))
            : typeof durS === 'number'
              ? durS
              : appearanceDurFor(durS.frac, clipDurationS(c))
        return applyAppearanceToClip(c, { ...c.appearance, durS: d }, seq.width, seq.height)
      })
      return { ...t, clips }
    })
    return changed ? { ...seq, tracks } : seq
  })
}

// ---------------------------------------------------------------------------
// The saved DEFAULT that every new title clip picks up. Persisted in the 'meta'
// store (global, not on the project undo stack) and cached in-memory so the
// synchronous addTitleClip can read it without awaiting IndexedDB.

const DEFAULT_KEY = 'defaultTextAppearance'
let defaultTextAppearance: AppearanceSpec | null = null

/** The current default (in-memory cache). Null until loaded / when unset. */
export function getDefaultTextAppearance(): AppearanceSpec | null {
  return defaultTextAppearance
}

/** Hydrate the default from storage once at boot. Never throws. */
export async function loadDefaultTextAppearance(): Promise<void> {
  try {
    const d = await db()
    const raw = (await d.get('meta', DEFAULT_KEY)) as AppearanceSpec | undefined
    defaultTextAppearance = raw && !isEmptyAppearance(raw) ? raw : null
  } catch (err) {
    console.error('OL Premiere: failed to load default text animation', err)
  }
}

async function persistDefault(spec: AppearanceSpec | null): Promise<void> {
  defaultTextAppearance = spec
  try {
    const d = await db()
    if (spec) await d.put('meta', spec, DEFAULT_KEY)
    else await d.delete('meta', DEFAULT_KEY)
  } catch (err) {
    console.error('OL Premiere: failed to save default text animation', err)
  }
}

/** Set the new-text default directly (used by Looks; silent, fire-and-forget). */
export function setDefaultTextAppearance(spec: AppearanceSpec | null): void {
  void persistDefault(spec && !isEmptyAppearance(spec) ? spec : null)
}

/** Save a clip's current appearance as the default for new text clips. */
export function saveClipAppearanceAsDefault(clipId: string): void {
  const clip = findClip(clipId)
  const spec = clip?.appearance
  const has = !!spec && !isEmptyAppearance(spec)
  void persistDefault(has ? spec! : null)
  useToasts
    .getState()
    .show(has ? 'Saved as the default text animation' : 'Cleared the default text animation', 'success')
}
