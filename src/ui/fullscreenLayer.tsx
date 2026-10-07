import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ⛔ IN FULL SCREEN, ONLY WHAT IS INSIDE THE FULL SCREEN SHOWS (2026-10-06). Full screen puts the
// Monitor in the browser's top layer, over everything else on the page whatever its z-index. The
// Frame menu, the toasts and the right click menu all lived outside it, so in full screen the Frame
// button lit up and nothing appeared, and Shift+S said "saved" to nobody. These go inside the full
// screen while there is one, and back where they were when it ends.

/** The element that is full screen now, or null. Re-renders when that changes. */
export function useFullscreenElement(): Element | null {
  const [el, setEl] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.fullscreenElement,
  )
  useEffect(() => {
    const sync = () => setEl(document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  return el
}

/** Shows its children inside the full screen while there is one, and in place otherwise. */
export function InFullscreen({ children }: { children: ReactNode }) {
  const el = useFullscreenElement()
  return el ? createPortal(children, el) : <>{children}</>
}
