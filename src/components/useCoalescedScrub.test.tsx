/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installManualRaf } from './timelineDomFixtures'
import { useCoalescedScrub } from './useCoalescedScrub'

let raf: ReturnType<typeof installManualRaf>
beforeEach(() => {
  raf = installManualRaf()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useCoalescedScrub', () => {
  it('scrubs once per frame, to the newest pointer position', () => {
    const scrubTo = vi.fn()
    const { result } = renderHook(() => useCoalescedScrub(scrubTo))
    result.current(10)
    result.current(20)
    result.current(30)
    expect(scrubTo).not.toHaveBeenCalled()
    expect(raf.pending()).toBe(1)
    raf.flush()
    expect(scrubTo).toHaveBeenCalledTimes(1)
    expect(scrubTo).toHaveBeenCalledWith(30)
    result.current(40)
    raf.flush()
    expect(scrubTo).toHaveBeenLastCalledWith(40)
  })

  it('drops a frame still owed when the timeline goes away', () => {
    const scrubTo = vi.fn()
    const { result, unmount } = renderHook(() => useCoalescedScrub(scrubTo))
    result.current(10)
    unmount()
    expect(raf.pending()).toBe(0)
    expect(scrubTo).not.toHaveBeenCalled()
  })
})
