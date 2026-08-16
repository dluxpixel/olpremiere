// The handful of effects he actually reaches for.
//
// The Add effect list is the whole registry in registry order, so the blur he
// puts on nine clips out of ten sits wherever the alphabet left it and costs a
// scroll every time. The last few he used ride at the top instead.
//
// Persisted, because "recent" that forgets overnight is not recent. Kept out of
// the project file on purpose: this is about HIM, not about one edit, and it
// should follow him into the next project.

import { create } from 'zustand'

const KEY = 'olpremiere:recent-effects'
/** Enough to cover a working session's habits without becoming a second list. */
export const RECENT_CAP = 5

interface RecentState {
  types: string[]
}

function load(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string').slice(0, RECENT_CAP)
  } catch {
    // A hand-edited or half-written key is not worth a crash on boot.
    return []
  }
}

function save(types: string[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(types))
  } catch {
    // Private mode / quota: the in-memory list still works for this run.
  }
}

export const useRecentEffects = create<RecentState>(() => ({ types: load() }))

/** Pure: `type` to the front, no duplicates, capped. */
export function withRecent(types: readonly string[], type: string, cap = RECENT_CAP): string[] {
  return [type, ...types.filter((t) => t !== type)].slice(0, cap)
}

/** Remember that he just applied `type`. */
export function noteRecentEffect(type: string): void {
  const next = withRecent(useRecentEffects.getState().types, type)
  useRecentEffects.setState({ types: next })
  save(next)
}
