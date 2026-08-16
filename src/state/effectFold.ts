// Which effect cards are folded shut.
//
// A view state, not a fact about the project: it never reaches the project file
// and never lands on the undo stack, because undoing a fold is not an edit.
//
// Keyed by effect INSTANCE id, so a clip carrying the same effect twice can have
// one copy open and the other shut. Folded ids are what is remembered, so an
// effect he has never touched is open, which is the state he expects a brand new
// card to arrive in.

import { create } from 'zustand'

interface FoldState {
  folded: Record<string, true>
}

export const useEffectFold = create<FoldState>(() => ({ folded: {} }))

export function toggleEffectFold(effectId: string): void {
  useEffectFold.setState((s) => {
    const folded = { ...s.folded }
    if (folded[effectId]) delete folded[effectId]
    else folded[effectId] = true
    return { folded }
  })
}

/** Fold or unfold every id at once, for the header's fold-all. */
export function setEffectsFolded(effectIds: readonly string[], folded: boolean): void {
  useEffectFold.setState((s) => {
    const next = { ...s.folded }
    for (const id of effectIds) {
      if (folded) next[id] = true
      else delete next[id]
    }
    return { folded: next }
  })
}

/** True when every id given is folded. Empty reads as not folded, so the button opens. */
export function allFolded(folded: Record<string, true>, effectIds: readonly string[]): boolean {
  return effectIds.length > 0 && effectIds.every((id) => folded[id] === true)
}
