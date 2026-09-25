/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installManualRaf, makeLanesEl } from './timelineDomFixtures'
import { useEdgeScroll } from './useEdgeScroll'

let raf: ReturnType<typeof installManualRaf>
beforeEach(() => {
  raf = installManualRaf()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const mount = () => {
  // Lanes at x 0..1000, y 0..400.
  const el = makeLanesEl()
  const lanesRef = { current: el }
  const programmatic = { current: false }
  const hook = renderHook(() => useEdgeScroll(lanesRef, programmatic))
  return { el, programmatic, hook }
}

describe('useEdgeScroll', () => {
  it('does not start away from the edges', () => {
    const { hook } = mount()
    const onStep = vi.fn()
    hook.result.current.lastDragPointer.current = { clientX: 500, clientY: 200 }
    act(() => hook.result.current.maybeEdgeScroll(onStep))
    expect(raf.pending()).toBe(0)
  })

  it('scrolls right each frame near the right edge, re-running the drag and marking the write', () => {
    const { el, programmatic, hook } = mount()
    const onStep = vi.fn()
    hook.result.current.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => hook.result.current.maybeEdgeScroll(onStep))
    act(() => raf.flush())
    expect(el.scrollLeft).toBe(20)
    expect(programmatic.current).toBe(true)
    expect(onStep).toHaveBeenCalledWith({ clientX: 1000, clientY: 200 })
    act(() => raf.flush())
    expect(el.scrollLeft).toBe(40)
  })

  it('runs one loop however many moves ask, with the first step it was given', () => {
    const { hook } = mount()
    const first = vi.fn()
    const second = vi.fn()
    hook.result.current.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => hook.result.current.maybeEdgeScroll(first))
    act(() => hook.result.current.maybeEdgeScroll(second))
    expect(raf.pending()).toBe(1)
    act(() => raf.flush())
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('scrolls down the lanes near the bottom edge', () => {
    const { el, hook } = mount()
    hook.result.current.lastDragPointer.current = { clientX: 500, clientY: 400 }
    act(() => hook.result.current.maybeEdgeScroll(vi.fn()))
    act(() => raf.flush())
    expect(el.scrollTop).toBe(10)
  })

  it('stops at the rail end instead of spinning', () => {
    const { hook } = mount()
    const onStep = vi.fn()
    // Left edge at scrollLeft 0: nothing can move.
    hook.result.current.lastDragPointer.current = { clientX: 0, clientY: 200 }
    act(() => hook.result.current.maybeEdgeScroll(onStep))
    act(() => raf.flush())
    expect(onStep).not.toHaveBeenCalled()
    expect(raf.pending()).toBe(0)
  })

  it('stops when the pointer leaves the edge, is cleared, or on demand', () => {
    const { hook } = mount()
    const r = hook.result.current
    r.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => r.maybeEdgeScroll(vi.fn()))
    r.lastDragPointer.current = { clientX: 500, clientY: 200 }
    act(() => r.maybeEdgeScroll(vi.fn()))
    expect(raf.pending()).toBe(0)

    r.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => r.maybeEdgeScroll(vi.fn()))
    r.lastDragPointer.current = null
    act(() => raf.flush())
    expect(raf.pending()).toBe(0)

    r.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => r.maybeEdgeScroll(vi.fn()))
    act(() => r.stopEdgeScroll())
    expect(raf.pending()).toBe(0)
  })

  it('never leaves a loop running after unmount', () => {
    const { hook } = mount()
    hook.result.current.lastDragPointer.current = { clientX: 1000, clientY: 200 }
    act(() => hook.result.current.maybeEdgeScroll(vi.fn()))
    hook.unmount()
    expect(raf.pending()).toBe(0)
  })
})
