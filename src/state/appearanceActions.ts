// Entrance / exit "appearance" animations. A tiny AppearanceSpec on the clip
// COMPILES to keyframes on the transform + opacity channels, so the animation
// runs through the same tested keyframe path as everything else (preview ==
// export). Appearance OWNS those channels: applying rebuilds them from the spec,
// clearing removes them.

import { applyAppearanceToClip, isEmptyAppearance } from '../engine/anim/appearance'
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

/** One undo step; a locked track rejects the edit (mirrors clipEdits.mapClip). */
function mapClip(clipId: string, label: string, fn: (clip: Clip) => Clip): void {
  updateActiveSequence(label, (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) =>
      !t.locked && t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }
        : t,
    ),
  }))
}

/** Merge a patch into a clip's appearance and recompile its keyframes. */
export function setClipAppearance(clipId: string, patch: Partial<AppearanceSpec>): void {
  const clip = findClip(clipId)
  if (!clip) return
  const seq = activeSequence(useStore.getState().project)
  const spec: AppearanceSpec = { ...clip.appearance, ...patch }
  const label = 'in' in patch ? 'Set entrance' : 'out' in patch ? 'Set exit' : 'Set appearance'
  mapClip(clipId, label, (c) => applyAppearanceToClip(c, spec, seq.width, seq.height))
}

/** Remove a clip's appearance animation entirely. */
export function clearClipAppearance(clipId: string): void {
  const clip = findClip(clipId)
  if (!clip) return
  const seq = activeSequence(useStore.getState().project)
  mapClip(clipId, 'Clear animation', (c) => applyAppearanceToClip(c, {}, seq.width, seq.height))
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
    console.error('OL Studio: failed to load default text animation', err)
  }
}

async function persistDefault(spec: AppearanceSpec | null): Promise<void> {
  defaultTextAppearance = spec
  try {
    const d = await db()
    if (spec) await d.put('meta', spec, DEFAULT_KEY)
    else await d.delete('meta', DEFAULT_KEY)
  } catch (err) {
    console.error('OL Studio: failed to save default text animation', err)
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
