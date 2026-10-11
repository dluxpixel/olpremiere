// Hold to compare: while a key or the Before button is held, the preview shows the picture
// without its effects. His ask, 2026-10-08: *"hold to compare"*.
//
// It is a VIEW. Nothing is written to the project, so it adds no undo step and moves no clip
// (engine/render/beforeView.ts). All this file owns is whether it is held right now, so the
// badge, the button and the key agree, and the preview is told on every flip.
//
// ⛔ RELEASE ON EVERY WAY OUT. A hold that never ends leaves the picture wrong with nothing on
// screen to say why. The key lets go on keyup and on the window losing focus (keymap.ts), the
// button on pointer up, cancel or lost capture, and the Monitor and the button let go when they
// go away. Two more are here, because a button hold has no keymap behind it: the window losing
// focus or the page being hidden (a pointer that went up outside the window never says so), and
// the project changing (a clip deleted or undone mid hold leaves a scope that names a clip that is
// gone, and the badge would sit over the real picture).
//
// ONE FLAG FOR BOTH. The R key and the Before button share one `holding`, so letting go of either
// ends the hold for both. That is deliberate: there is one Before picture and one badge, and two
// flags would let the badge disagree with what is drawn.

import { useSyncExternalStore } from 'react'
import { beforeScopeFor } from '../engine/render/beforeView'
import { setPreviewBefore } from '../engine/preview'
import { activeSequence } from '../engine/types'
import { useStore } from './store'

let holding = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

// The ways a hold ends that have no key or button to say so. Listening only while held, so a
// monitor that is never compared costs nothing.
let detachGuards: (() => void) | null = null

function attachGuards(): void {
  if (detachGuards) return
  const offs: Array<() => void> = []
  if (typeof window !== 'undefined') {
    // The window lost focus: a pointer released outside it never reaches the button.
    window.addEventListener('blur', releaseBefore)
    offs.push(() => window.removeEventListener('blur', releaseBefore))
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') releaseBefore()
      }
      document.addEventListener('visibilitychange', onVisibility)
      offs.push(() => document.removeEventListener('visibilitychange', onVisibility))
    }
  }
  // The project changed under the hold (a delete, an undo): the scope was fixed at the start.
  offs.push(useStore.subscribe((s) => s.project, releaseBefore))
  detachGuards = () => offs.forEach((off) => off())
}

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
  attachGuards()
  emit()
}

/** Go back to the real picture. Safe to call when nothing is held. */
export function releaseBefore(): void {
  if (!holding) return
  holding = false
  detachGuards?.()
  detachGuards = null
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
