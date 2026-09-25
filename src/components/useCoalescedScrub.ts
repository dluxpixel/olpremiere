import { useEffect, useRef } from 'react'

/**
 * Dragging the playhead, coalesced to ONE scrub per animation frame.
 *
 * ⛔ A POINTER REPORTS FAR FASTER THAN A SCREEN REDRAWS. An ordinary mouse is
 * 125 Hz and a gaming mouse is 1000, while the display is 60 to 165. This used
 * to call `scrubTo` on every single pointermove, and each call is a store write
 * plus a React render of a timeline holding every clip in the sequence. So most
 * of that work could never be seen: it was only ever competing with the work
 * that could. **Measured 2026-08-13: 61 store writes for 60 pointer moves.**
 * His words, and the reason this was looked at: "scrubbing with the playhead is
 * still laggy."
 *
 * `Monitor.tsx` already caps its own redraw for exactly this reason. The
 * timeline did not, which is why the lag survived that cap.
 *
 * ⚠️ The DOWN press deliberately still calls `scrubTo` directly. A click has to
 * land on the frame it happened on, and coalescing it would put the playhead a
 * frame behind every click for no gain, since one click is not a stream.
 */
export function useCoalescedScrub(scrubTo: (clientX: number) => void): (clientX: number) => void {
  const scrubFrame = useRef<number | null>(null)
  const scrubX = useRef(0)
  const scrubDrag = (clientX: number) => {
    // Always keep the NEWEST position: a coalesced frame must land where the
    // pointer is now, not where it was when the frame was booked.
    scrubX.current = clientX
    if (scrubFrame.current !== null) return
    scrubFrame.current = requestAnimationFrame(() => {
      scrubFrame.current = null
      scrubTo(scrubX.current)
    })
  }
  // A frame booked by the last move can still be owed when the timeline goes
  // away. Firing it into an unmounted component would write to a dead store.
  useEffect(
    () => () => {
      if (scrubFrame.current !== null) cancelAnimationFrame(scrubFrame.current)
    },
    [],
  )
  return scrubDrag
}
