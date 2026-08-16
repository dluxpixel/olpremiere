// The rows behind the inspector's Add effect menu, worked out without a DOM.
//
// ⛔ THE LAST ATTEMPT AT THIS MENU WAS REVERTED, and the filtering was never the
// fault. The popup did not open reliably: four end to end runs failed in a
// different place each time, and a control that needs four goes to open is not
// one he should be handed. Two things come out of that.
//
//   1. Every decision the menu makes lives HERE, in a file a unit test can drive
//      with no browser at all. What is left in the component is markup.
//   2. The component never closes itself from a document listener. See the note
//      in AddEffectMenu.tsx for why that listener is what broke it.
//
// The filtering itself is `filterEffects`, the same one the Effects browser
// calls, so the two surfaces cannot answer the same question differently.

import { BROWSABLE_EFFECTS, type EffectDef } from './registry'
import { filterEffects } from './search'

export interface AddMenuRow {
  type: string
  label: string
  description: string
  /**
   * Recent rows are repeated further down under All, exactly as the old native
   * list did. Two ways to the same effect is not a bug here: the top of the list
   * is a shortcut, and the bottom is where he looks when the shortcut is empty.
   */
  group: 'recent' | 'all'
}

function toRow(def: EffectDef, group: 'recent' | 'all'): AddMenuRow {
  return { type: def.type, label: def.label, description: def.description, group }
}

/**
 * Every row the menu shows for `query`, recents first, in the order they render.
 *
 * A recent type that is no longer browsable is dropped rather than shown, so a
 * retired effect cannot linger at the top as a row that adds nothing.
 */
export function addMenuRows(query: string, recentTypes: readonly string[]): AddMenuRow[] {
  const recentDefs = recentTypes
    .map((t) => BROWSABLE_EFFECTS.find((ef) => ef.type === t))
    .filter((ef): ef is EffectDef => ef !== undefined)
  // Recents keep RECENCY order, which is why they are filtered as their own list
  // rather than picked out of the registry-ordered result.
  const recent = filterEffects(query, recentDefs).map((ef) => toRow(ef, 'recent'))
  const all = filterEffects(query).map((ef) => toRow(ef, 'all'))
  return [...recent, ...all]
}

/**
 * Where the highlight lands after moving `delta` rows, wrapping at both ends.
 *
 * Wrapping rather than stopping, because the list is short and the alternative
 * is a dead key at the bottom of it. With no rows there is nothing to highlight
 * and the answer is -1, which is the one value `rows[i]` cannot resolve.
 */
export function nextHighlight(rowCount: number, current: number, delta: number): number {
  if (rowCount <= 0) return -1
  // Nothing highlighted is not row -1. Stepping down from it means the first
  // row and stepping up means the last, and letting the sentinel go through the
  // arithmetic lands one short of the end.
  if (current < 0) return delta > 0 ? 0 : rowCount - 1
  return (((current + delta) % rowCount) + rowCount) % rowCount
}

/** The row Enter would apply, or undefined when the query matches nothing. */
export function highlightedRow(rows: readonly AddMenuRow[], highlight: number): AddMenuRow | undefined {
  return highlight >= 0 ? rows[highlight] : undefined
}
