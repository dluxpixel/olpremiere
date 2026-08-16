// One search over the effects, shared by every surface that offers them.
//
// The Effects browser panel filtered on label and type, and the inspector's Add
// list did not filter at all. Two surfaces, two answers to the same question,
// which is exactly how a third one would have made things worse. This is the one
// function both of them call now.
//
// ⛔ IT SEARCHES THE DESCRIPTION TOO, and that is the point rather than a bonus.
// "grain" is nowhere in the word Noise, "vignette" is nowhere in Darken, and a
// search that only reads labels makes him already know the name of the thing he
// is looking for.

import { BROWSABLE_EFFECTS, type EffectDef } from './registry'

/** Normalised haystack for one effect: what a query is allowed to hit. */
function haystack(def: EffectDef): string {
  return `${def.label} ${def.type} ${def.description}`.toLowerCase()
}

/**
 * The browsable effects matching `query`, in registry order.
 *
 * An empty or blank query is not a filter, so it hands back everything rather
 * than nothing: an empty search box must show the full list.
 */
export function filterEffects(query: string, from: readonly EffectDef[] = BROWSABLE_EFFECTS): EffectDef[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...from]
  // Every whitespace-separated word has to land somewhere, so "warm grade"
  // narrows instead of widening the way an OR would.
  const words = q.split(/\s+/)
  return from.filter((def) => {
    const hay = haystack(def)
    return words.every((w) => hay.includes(w))
  })
}

/** True when `query` would match this one effect. For the transitions list, which is not EffectDefs. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = fields.join(' ').toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}
