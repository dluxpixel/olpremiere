import { useEffect, type RefObject } from 'react'

// A window takes the keyboard when it opens (2026-10-06). None of them did: the focus stayed on
// the button that opened it, so his keys went to the edit behind (Delete with Projects open took
// a clip off the timeline). keymap.ts now holds the edit's keys while a window is open; this puts
// the focus in the window he is looking at, so Tab starts there, and gives it back to the button
// he opened it with when it closes.

/**
 * Focus `box` (give it tabIndex={-1}) while `active`. Something inside that already took the
 * focus, like a field that focuses itself, keeps it.
 */
export function useDialogFocus(box: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return
    const el = box.current
    const before = document.activeElement
    const opener =
      before instanceof HTMLElement && before !== document.body && !el?.contains(before) ? before : null
    if (el && !el.contains(before)) el.focus({ preventScroll: true })
    return () => {
      // Only when the focus went away with the window. If he clicked something else on the way
      // out, that is where he is now.
      const now = document.activeElement
      const lost = now === null || now === document.body || (el?.contains(now) ?? false)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [active, box])
}
