// The line he last clicked, which Ctrl+V pastes onto.
//
// His words, 2026-10-04, with a screenshot of a picture that landed on V2: *"I
// click and paste it on that. It pastes it at the right time, but make sure it
// also pastes it on the same line because I clicked the V4."*
//
// Nothing remembered the click. A click on an empty spot of a line only moved the
// playhead and cleared the selection, so a pasted picture always went to its home
// line (V2) and pasted clips always went back to the line they were copied from.
// The line he clicks is now the paste target, and it lives here rather than in the
// store's `ui` because it is one fact with one reader (the paste) and one writer
// (the click), and because the editing tabs share the paste path.
//
// It is a track ID, never an index: tracks are added and deleted around it, and
// an id that this sequence no longer has simply stops meaning anything.

import { create } from 'zustand'
import type { Id, Sequence, Track } from '../engine/types'
import { useStore } from './store'

export const usePasteTarget = create<{ trackId: Id | null }>(() => ({ trackId: null }))

/** Aim the next paste at this line, or at nothing (null). */
export function setPasteTarget(trackId: Id | null): void {
  if (usePasteTarget.getState().trackId !== trackId) usePasteTarget.setState({ trackId })
}

/**
 * The line the next paste is aimed at, when this sequence still has it. A line
 * that was deleted, or that belongs to another edit, is not a target: the paste
 * then does what it always did, and there is nothing to say about a line he is
 * no longer looking at.
 */
export function clickedPasteTrack(seq: Sequence): Track | null {
  const id = usePasteTarget.getState().trackId
  return (id !== null && seq.tracks.find((t) => t.id === id)) || null
}

// ⛔ PICKING A CLIP IS ADDRESSING THAT CLIP, NOT A LINE. He clicks a clip to copy
// it, and the Ctrl+V that follows used to put it back on its own line at the
// playhead. A line he clicked an hour ago must not take that paste: any selection
// of clips lets go of the line.
useStore.subscribe(
  (s) => s.ui.selection,
  (selection) => {
    if (selection.length > 0) setPasteTarget(null)
  },
)

/**
 * Select what a paste just made. Pasting is not picking, so the line he clicked
 * stays the target and the next Ctrl+V lands on it too.
 */
export function selectPasted(ids: Id[]): void {
  const kept = usePasteTarget.getState().trackId
  useStore.getState().setUI({ selection: ids })
  setPasteTarget(kept)
}
