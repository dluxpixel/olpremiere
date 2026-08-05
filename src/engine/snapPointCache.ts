import { clipGroupIds, collectSnapPoints } from './timeline'
import type { Id, Sequence } from './types'

/**
 * One drag gesture asks for the same snap points hundreds of times.
 *
 * `collectSnapPoints` walks every clip on every track and then sorts, and the
 * caller first expands each dragged id into its link group, which walks the
 * sequence again per seed. All of that sat inside the pointermove handler, so a
 * single drag across a cut-heavy timeline redid O(clips) work on every mouse
 * movement, tens of times a second.
 *
 * None of it can change mid-gesture. Drag math reads the COMMITTED sequence,
 * never the preview, so clip edges, markers and link groups are all frozen for
 * the length of the drag, and the only edges that do move belong to the dragged
 * group, which is excluded from the list anyway. So the answer is computed once
 * and reused until something it actually depends on changes.
 *
 * The cache key is the sequence identity, the seed ids and the playhead. The
 * playhead is in there because it is a snap point too and it keeps moving if he
 * drags while playback runs; that case recomputes exactly as often as before,
 * so this can never be slower than what it replaces.
 *
 * It returns the SAME array `collectSnapPoints` would have returned, sorted and
 * all. The sort looks redundant next to `snapTime`'s linear scan and is not:
 * `snapTime` keeps the earliest point on an exact tie with a strict `<`, which
 * is only true while the array arrives in time order.
 */
export interface SnapPointCache {
  /** Snap points for this gesture, computed at most once per distinct key. */
  points(seq: Sequence, seedIds: readonly Id[], playheadS: number): number[]
  /** How many times the underlying walk actually ran. Tests assert on this. */
  computations(): number
  /** Drop the memo. Not required for correctness, only for freeing the array. */
  reset(): void
}

export function createSnapPointCache(): SnapPointCache {
  let key: string | null = null
  let keySeq: Sequence | null = null
  let points: number[] = []
  let computations = 0

  return {
    points(seq, seedIds, playheadS) {
      // Seed order is caller-stable (it comes from the drag state, not a set),
      // so joining is enough and sorting the key would only cost more.
      const nextKey = `${seedIds.join(',')}|${playheadS}`
      if (keySeq === seq && key === nextKey) return points

      const excludeClipIds = seedIds.length > 0
        ? seedIds.flatMap((id) => clipGroupIds(seq, id))
        : undefined
      points = collectSnapPoints(seq, {
        ...(excludeClipIds ? { excludeClipIds } : {}),
        playheadS,
      })
      key = nextKey
      keySeq = seq
      computations += 1
      return points
    },
    computations: () => computations,
    reset() {
      key = null
      keySeq = null
      points = []
    },
  }
}
