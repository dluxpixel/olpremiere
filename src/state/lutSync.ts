// Keeps the preview's LUT bank (engine/effects/lutBank.ts) in step with the open
// project. The project carries its colour tables as `Project.luts`; the renderer
// reads decoded copies from the bank, by id. Whenever the project's tables change
// (a LUT loaded, a project opened, an undo) the new ones are decoded here, before
// the preview draws the next frame.
//
// The export worker has its own bank and is handed its tables in its init message
// (engine/export/messages.ts), so nothing here runs there.

import { registerLutAssets } from '../engine/effects/lutBank'
import { useStore } from './store'

let stop: (() => void) | null = null

/** Start following the store. Safe to call twice; returns the function that stops it. */
export function startLutSync(): () => void {
  if (stop) return stop
  let last = useStore.getState().project.luts
  registerLutAssets(last)
  const unsubscribe = useStore.subscribe((state) => {
    const luts = state.project.luts
    if (luts === last) return
    last = luts
    registerLutAssets(luts)
  })
  stop = () => {
    unsubscribe()
    stop = null
  }
  return stop
}
