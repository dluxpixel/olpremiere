/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'
import { MAX_PX_PER_S, useStore } from '../state/store'
import { makeLanesEl } from './timelineDomFixtures'
import { useTimelineZoom } from './useTimelineZoom'

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ pxPerS: 100, playheadS: 0 })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const mount = (durationS = 30) => {
  const el = makeLanesEl({ left: 50, width: 1000 })
  const measure = vi.fn()
  const hook = renderHook(({ d }: { d: number }) => useTimelineZoom({ current: el }, measure, d), {
    initialProps: { d: durationS },
  })
  return { el, measure, hook }
}

describe('useTimelineZoom', () => {
  it('zooms to an asked scale on the keymap event, anchored on the playhead in view', () => {
    const { el, measure } = mount()
    useStore.getState().setUI({ playheadS: 4 })
    act(() => {
      window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { pxPerS: 200 } }))
    })
    expect(useStore.getState().ui.pxPerS).toBe(200)
    // The playhead stays 400px into the view.
    expect(4 * 200 - el.scrollLeft).toBe(400)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('zooms by a factor on the keymap event', () => {
    mount()
    act(() => {
      window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { factor: 1.5 } }))
    })
    expect(useStore.getState().ui.pxPerS).toBe(150)
  })

  it('does nothing past the limit', () => {
    const { measure } = mount()
    useStore.getState().setUI({ pxPerS: MAX_PX_PER_S })
    act(() => {
      window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { factor: 2 } }))
    })
    expect(useStore.getState().ui.pxPerS).toBe(MAX_PX_PER_S)
    expect(measure).not.toHaveBeenCalled()
  })

  it('zooms around the pointer on ctrl+wheel and leaves a plain wheel alone', () => {
    const { el } = mount()
    el.scrollLeft = 200
    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 350, cancelable: true }))
    })
    expect(useStore.getState().ui.pxPerS).toBe(100)
    const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 350, ctrlKey: true, cancelable: true })
    act(() => {
      el.dispatchEvent(wheel)
    })
    expect(wheel.defaultPrevented).toBe(true)
    expect(useStore.getState().ui.pxPerS).toBeCloseTo(120)
    // 5s was under the pointer (300px into the lanes) and still is.
    expect(5 * useStore.getState().ui.pxPerS - el.scrollLeft).toBeCloseTo(300)
  })

  it('fits the sequence from the button and the keymap event', () => {
    const { el, hook, measure } = mount(24)
    el.scrollLeft = 500
    act(() => hook.result.current.zoomFit())
    expect(useStore.getState().ui.pxPerS).toBe(40)
    expect(el.scrollLeft).toBe(0)
    hook.rerender({ d: 48 })
    act(() => {
      window.dispatchEvent(new Event('olpremiere:zoom-fit'))
    })
    expect(useStore.getState().ui.pxPerS).toBe(20)
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('does not fit an empty sequence', () => {
    const { hook } = mount(0)
    act(() => hook.result.current.zoomFit())
    expect(useStore.getState().ui.pxPerS).toBe(100)
  })

  it('stops listening on unmount', () => {
    const { hook } = mount()
    hook.unmount()
    window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { pxPerS: 300 } }))
    window.dispatchEvent(new Event('olpremiere:zoom-fit'))
    expect(useStore.getState().ui.pxPerS).toBe(100)
  })
})
