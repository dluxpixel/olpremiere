// Work-area (in/out) transport actions. The math lives in engine/workArea.ts and
// is unit-tested there; this module only binds it to the playhead and the store,
// one named undo step per edit.

import { clearWorkArea, setInPoint, setOutPoint, workArea } from '../engine/workArea'
import { activeSequence } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

const playheadS = (): number => useStore.getState().ui.playheadS

export function markIn(): void {
  updateActiveSequence('Mark in', (seq) => setInPoint(seq, playheadS()))
}

export function markOut(): void {
  updateActiveSequence('Mark out', (seq) => setOutPoint(seq, playheadS()))
}

export function clearInOut(): void {
  updateActiveSequence('Clear in/out', (seq) => clearWorkArea(seq))
}

/** Jump the playhead to the work-area start. No-op when there is no work area. */
export function gotoIn(): void {
  const area = workArea(activeSequence(useStore.getState().project))
  if (area.active) useStore.getState().setUI({ playheadS: area.startS })
}

export function gotoOut(): void {
  const area = workArea(activeSequence(useStore.getState().project))
  if (area.active) useStore.getState().setUI({ playheadS: area.endS })
}
