// The Inspector's effects area as a drop target for the Effects browser.
//
// That area has promised this in words since it was written - "No effects
// applied. Drag one from the Effects panel, or double-click it" - and nothing
// was listening. EffectControls.tsx carried no onDrop and no onDragOver at all,
// so the ONE panel the promise points at was the one place in the app that
// refused the drop, and refused it silently. Double-click worked. The drag died.
//
// This is Timeline.tsx's clip drop (fxDragOver / fxDragLeave / fxDrop) reused
// rather than rewritten: same MIME, same dragover-preventDefault-dropEffect
// shape, same containment rule on dragleave, same accent hint. And what lands is
// `applyEffectToClips`, the SAME action the browser row's double-click and its
// right-click menu already call, so the two doors cannot drift apart: one
// canonical insert position, one audio refusal, one undo step. Nothing about the
// effect stack is decided in this file.

import { useState, type DragEvent } from 'react'
import { activeSequence } from '../engine/types'
import { applyEffectToClips } from '../state/bulkEdits'
import { EFFECT_MIME, dragHasType } from '../state/dnd'
import { useStore } from '../state/store'

/**
 * Every target clip sits on a LOCKED track, so nothing can land. Refused the way
 * Timeline refuses this exact drag over a locked track: the area never lights up
 * and the cursor stays "no drop", which is the answer the app already gives
 * everywhere else a lock blocks an edit.
 *
 * An EMPTY target list is a different thing and is deliberately NOT refused
 * here - see the drop handler.
 *
 * Read at gesture time (getState, no subscription): a lock changes rarely, and
 * subscribing would re-render the whole Inspector on every store tick.
 */
function allTargetsLocked(ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  const seq = activeSequence(useStore.getState().project)
  return ids.every((id) => seq.tracks.some((t) => t.locked && t.clips.some((c) => c.id === id)))
}

export interface EffectDrop {
  /** A dragged effect is over the area: the "this will accept" hint. */
  hot: boolean
  /** Spread onto the element that should take the drop. */
  dropProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDragLeave: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
  }
}

/**
 * Make a region of the Inspector accept an effect dragged out of the browser.
 *
 * `ids` are the clips it would land on, and it is EMPTY when nothing is
 * selected. That case is still accepted on purpose: the drop then reaches
 * applyEffectToClips, which says "Select a clip first" out loud. Refusing at the
 * cursor instead would reproduce the exact bug this fixes - a drag that ends in
 * nothing, with no reason given.
 */
export function useEffectDrop(ids: readonly string[]): EffectDrop {
  const [hot, setHot] = useState(false)

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!dragHasType(e.dataTransfer.types, EFFECT_MIME)) return
    if (allTargetsLocked(ids)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setHot(true)
  }

  // dragleave also fires when the cursor crosses between the area's own
  // children, which would flicker the hint. Only clear when it truly leaves.
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && e.currentTarget.contains(to)) return
    setHot(false)
  }

  const onDrop = (e: DragEvent<HTMLElement>) => {
    const type = e.dataTransfer.getData(EFFECT_MIME)
    if (!type) return
    if (allTargetsLocked(ids)) return
    e.preventDefault()
    e.stopPropagation()
    setHot(false)
    applyEffectToClips(ids, type)
  }

  return { hot, dropProps: { onDragOver, onDragLeave, onDrop } }
}
