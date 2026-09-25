/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Sequence } from '../engine/types'
import { makeClip, makeSeq, makeTrack } from './timelineTestFixtures'
import { useSeenClipIds } from './useSeenClipIds'

afterEach(cleanup)

describe('useSeenClipIds', () => {
  it('answers with the ids of the previous commit, so only a new clip pops', () => {
    const a = makeClip()
    const b = makeClip({ startS: 3 })
    const first = makeSeq([makeTrack({ clips: [a] })])
    const { result, rerender } = renderHook(({ seq }: { seq: Sequence }) => useSeenClipIds(seq), {
      initialProps: { seq: first },
    })
    // First paint: nothing was seen before it.
    expect(result.current.size).toBe(0)
    rerender({ seq: first })
    expect([...result.current]).toEqual([a.id])
    const second = makeSeq([makeTrack({ clips: [a, b] })])
    rerender({ seq: second })
    expect(result.current.has(a.id)).toBe(true)
    expect(result.current.has(b.id)).toBe(false)
    rerender({ seq: second })
    expect(result.current.has(b.id)).toBe(true)
  })
})
