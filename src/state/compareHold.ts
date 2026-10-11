// Hold to compare: while a key or the Before button is held, the preview shows the picture
// without its effects. His ask, 2026-10-08: *"hold to compare"*.
//
// It is a VIEW. Nothing is written to the project, so it adds no undo step and moves no clip
// (engine/render/beforeView.ts). All this file owns is whether it is held right now, so the
// badge, the button and the key agree, and the preview is told on every flip.
//
// ⛔ RELEASE ON EVERY WAY OUT. A hold that never ends leaves the picture wrong with nothing on
// screen to say why. The key lets go on keyup and on the window losing focus (keymap.ts), the
// button on pointer up, cancel or lost capture, and the Monitor lets go when it goes away.

import { useSyncExternalStore } from 'react'
import { beforeScopeFor } from '../engine/render/beforeView'
import { setPreviewBefore } from '../engine/preview'
import { activeSequence } from '../engine/types'
import { useStore } from './store'

let holding = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/**
 * Start showing the Before picture. Safe to call again while held: a held key repeats, and a
 * second call must not take a second look at the selection. The scope is fixed at the start,
 * so clicking another clip in the middle of a hold does not change what is being compared.
 */
export function holdBefore(): void {
  if (holding) return
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  // Nothing on the timeline: there is no picture to compare, so there is nothing to hold.
  if (seq.durationS <= 0) return
  holding = true
  setPreviewBefore(beforeScopeFor(seq, s.ui.selection))
  emit()
}

/** Go back to the real picture. Safe to call when nothing is held. */
export function releaseBefore(): void {
  if (!holding) return
  holding = false
  setPreviewBefore(null)
  emit()
}

export function isHoldingBefore(): boolean {
  return holding
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Whether the Before picture is being held, for the badge and the button. */
export function useHoldingBefore(): boolean {
  return useSyncExternalStore(subscribe, isHoldingBefore, isHoldingBefore)
}
