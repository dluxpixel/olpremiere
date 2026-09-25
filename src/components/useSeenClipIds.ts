import { useEffect, useRef } from 'react'
import type { Sequence } from '../engine/types'

/**
 * Pop gating: ids seen on the previous commit. A clip id NOT in the set is
 * genuinely new (add / paste / undo-restore) and gets the one-shot pulse; a
 * virtualization remount is already in the set and stays quiet.
 */
export function useSeenClipIds(seq: Sequence): Set<string> {
  const seenClipIdsRef = useRef<Set<string>>(new Set())
  const seenClipIds = seenClipIdsRef.current
  useEffect(() => {
    const ids = new Set<string>()
    for (const t of seq.tracks) for (const c of t.clips) ids.add(c.id)
    seenClipIdsRef.current = ids
  }, [seq])
  return seenClipIds
}
