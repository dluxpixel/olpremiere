// Play the move back, once, the moment it lands.
//
// He is choosing from a shelf of ten pictures, so the thing that teaches him
// what he just picked is SEEING it, immediately, without reaching for the space
// bar and without hunting the playhead back to the head of the clip. One rAF
// loop writes ui.playheadS from the start of the move to the end of the clip and
// then stops. Any pointer, key or wheel takes it back at once, because a preview
// that fights him for the playhead is worse than no preview.
//
// `ui.previewingMove` exists so the monitor's transform gizmo can stand down for
// the length of the sweep exactly as it does during playback. Without it the
// overlay re-renders on every frame of the replay, which is the per-frame React
// cost the rest of the motion desk goes out of its way to avoid.

import { clipEndS } from '../engine/timeline'
import { activeSequence } from '../engine/types'
import { useStore } from './store'

/** Longest replay we will ever run, so a 60 second clip cannot hold the playhead hostage. */
const MAX_PREVIEW_S = 8

let raf = 0
let stopListening: (() => void) | null = null
/** Where his playhead was before the replay borrowed it. */
let parkedAtS: number | null = null

/**
 * Stop a replay in flight and hand the playhead back to where he left it.
 *
 * The replay BORROWS the playhead, it does not move his edit position: picking a
 * move off the shelf is not a request to go and stand somewhere else. Anything
 * he does during the sweep cancels it, and because the listener is on the
 * capture phase the restore lands before his own click is handled, so a scrub
 * that interrupts the replay still wins.
 */
export function stopMovePreview(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  stopListening?.()
  stopListening = null
  const parked = parkedAtS
  parkedAtS = null
  if (useStore.getState().ui.previewingMove) {
    useStore.getState().setUI(parked === null ? { previewingMove: false } : { previewingMove: false, playheadS: parked })
  }
}

/**
 * Run the playhead across `clipId` once, from `fromS` (sequence time) or the
 * clip's head. Real playback always wins: if he is already playing, this does
 * nothing rather than dragging the playhead out from under the transport.
 */
export function playMovePreview(clipId: string, fromS?: number): void {
  const state = useStore.getState()
  if (state.ui.playing) return
  if (typeof requestAnimationFrame !== 'function') return
  const seq = activeSequence(state.project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!clip) return

  stopMovePreview()
  const startS = Math.max(clip.startS, fromS ?? clip.startS)
  const endS = Math.min(clipEndS(clip), startS + MAX_PREVIEW_S)
  if (endS - startS < 1 / 60) return

  const t0 = performance.now()
  const setUI = useStore.getState().setUI
  parkedAtS = state.ui.playheadS
  setUI({ previewingMove: true, playheadS: startS })

  const cancel = (): void => stopMovePreview()
  const events = ['pointerdown', 'keydown', 'wheel'] as const
  for (const type of events) window.addEventListener(type, cancel, { capture: true, once: true })
  stopListening = () => {
    for (const type of events) window.removeEventListener(type, cancel, true)
  }

  const step = (now: number): void => {
    const t = startS + (now - t0) / 1000
    if (t >= endS) {
      setUI({ playheadS: endS })
      stopMovePreview()
      return
    }
    setUI({ playheadS: t })
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}
