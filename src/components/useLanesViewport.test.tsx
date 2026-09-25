/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installManualRaf, installResizeObserver, makeLanesEl } from './timelineDomFixtures'
import { useLanesViewport } from './useLanesViewport'

let raf: ReturnType<typeof installManualRaf>
let ro: ReturnType<typeof installResizeObserver>

beforeEach(() => {
  raf = installManualRaf()
  ro = installResizeObserver()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useLanesViewport', () => {
  it('measures on mount and watches the lanes for resizes', () => {
    const el = makeLanesEl({ width: 800 })
    const ref = { current: el }
    el.scrollLeft = 120
    const { result } = renderHook(() => useLanesViewport(ref))
    expect(result.current.viewport).toEqual({ left: 120, width: 800 })
    expect(ro.observed).toEqual([el])
  })

  it('is null with no lanes yet, so everything renders', () => {
    // The ref must be stable across renders, exactly as a useRef is.
    const nullRef = { current: null }
    const { result } = renderHook(() => useLanesViewport(nullRef))
    expect(result.current.viewport).toBeNull()
  })

  it('throttles scroll measures to one per frame', () => {
    const el = makeLanesEl()
    const ref = { current: el }
    const { result } = renderHook(() => useLanesViewport(ref))
    el.scrollLeft = 300
    act(() => {
      result.current.scheduleViewportMeasure()
      result.current.scheduleViewportMeasure()
    })
    expect(raf.pending()).toBe(1)
    expect(result.current.viewport?.left).toBe(0)
    act(() => raf.flush())
    expect(result.current.viewport?.left).toBe(300)
  })

  it('measures right now on demand and drops the throttled measure still owed', () => {
    const el = makeLanesEl()
    const ref = { current: el }
    const { result } = renderHook(() => useLanesViewport(ref))
    act(() => result.current.scheduleViewportMeasure())
    el.scrollLeft = 450
    act(() => result.current.measureViewportNow())
    expect(result.current.viewport?.left).toBe(450)
    expect(raf.pending()).toBe(0)
  })

  it('disconnects and cancels on unmount', () => {
    const el = makeLanesEl()
    const ref = { current: el }
    const { result, unmount } = renderHook(() => useLanesViewport(ref))
    act(() => result.current.scheduleViewportMeasure())
    unmount()
    expect(ro.disconnected()).toBe(1)
    expect(raf.pending()).toBe(0)
  })
})
