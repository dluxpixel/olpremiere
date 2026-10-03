import { useCallback, useRef } from 'react'
import { type Id } from '../engine/types'

/**
 * A stable-identity wrapper around a fresh-every-render closure. The returned
 * function never changes, but always calls the latest closure - what memoized
 * children need from handler props without threading useCallback dependency
 * lists through the Timeline's very large drag closures.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}

export type Drag =
  | {
      kind: 'move'
      clipId: Id
      grabOffsetS: number
      trackKind: 'video' | 'audio'
      /** Pointer-down spot: release within CLICK_SLOP_PX = a click, not a drag. */
      downClientX: number
      downClientY: number
      /**
       * Every clip this drag carries, the grabbed one included: ONE rigid
       * block (engine/blockMove.ts). Read off the selection at the press by
       * dragBlockIds, so a linked partner is in it only when he selected it
       * too, and fixed for the whole gesture.
       */
      blockIds: Id[]
      /**
       * Click-without-drag on an already-multi-selected clip collapses the
       * selection to just it (narrowing without deselect-all); a real drag
       * still moves the whole group.
       */
      collapseCandidate: boolean
      /**
       * Ctrl-click without a drag on a clip that was ALREADY selected takes it
       * out of the selection. Deciding on release, not on press, is what lets a
       * Ctrl-held grab of any selected clip drag the whole selection.
       */
      toggleOffCandidate?: boolean
    }
  /** `solo`: this half was singled out before the grab → trim it alone. */
  | { kind: 'trim'; clipId: Id; edge: 'in' | 'out'; ripple: boolean; solo: boolean }
  /** Alt+edge-drag: retime the clip (speed changes, source in/out stay put). */
  | { kind: 'stretch'; clipId: Id; edge: 'in' | 'out' }
  /** `solo`: this half was singled out before the grab → slip it alone. */
  | { kind: 'slip'; clipId: Id; startXPx: number; solo: boolean }
  /** Ctrl+Alt+edge-drag: roll the shared cut - both outer ends stay fixed. */
  | { kind: 'roll'; leftId: Id; rightId: Id }
  /** Ctrl+Alt+body-drag: slide the clip - neighbours absorb, totals preserved. */
  | { kind: 'slide'; clipId: Id; grabOffsetS: number; neighborIds: Id[] }
  | { kind: 'scrub' }
  /**
   * Shift/Ctrl+drag on empty lane space: rubber-band select. Content
   * coordinates. `additive` (Ctrl/Cmd) unions the rectangle's hits onto `base`
   * - the selection that existed when the drag began - so you can build a
   * selection up in passes, exactly like dragging a box on the desktop.
   */
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; base: Id[] }
  | { kind: 'hand'; startX: number; startY: number; scrollLeft: number; scrollTop: number }
