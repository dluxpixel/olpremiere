import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { useStore } from '../state/store'
import { followScrollLeft } from './timelineZoom'

/**
 * Keep the playhead visible while playing (page-scroll like Premiere), but
 * never fight a manual scroll: suspend auto-follow for a moment after the
 * user scrolls the lanes themselves (`manualScrollUntil`, a timestamp).
 *
 * Auto-follow rides an IMPERATIVE playhead subscription (not a React effect
 * keyed on playheadS - that re-ran per transport tick). pxPerS via ref so
 * zoom changes mid-play take effect without resubscribing.
 */
export function usePlayheadFollow(
  lanesRef: RefObject<HTMLDivElement | null>,
  pxPerS: number,
  playing: boolean,
  manualScrollUntil: MutableRefObject<number>,
  programmaticScroll: MutableRefObject<boolean>,
): void {
  const pxPerSRef = useRef(pxPerS)
  pxPerSRef.current = pxPerS
  useEffect(() => {
    return useStore.subscribe(
      (s) => s.ui.playheadS,
      (t) => {
        const el = lanesRef.current
        if (!el) return
        if (performance.now() < manualScrollUntil.current) return
        // Page forward while playing, bring an off-screen jump into view while
        // paused (see followScrollLeft).
        const next = followScrollLeft(t * pxPerSRef.current, el.scrollLeft, el.clientWidth, playing)
        if (next !== null) {
          programmaticScroll.current = true
          el.scrollLeft = next
        }
      },
    )
  }, [lanesRef, manualScrollUntil, programmaticScroll, playing])
}
