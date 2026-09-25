/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newProject } from '../engine/types'
import { useStore } from '../state/store'
import { makeLanesEl } from './timelineDomFixtures'
import { usePlayheadFollow } from './usePlayheadFollow'

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ playheadS: 0 })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const mount = (playing: boolean, pxPerS = 100) => {
  const el = makeLanesEl({ width: 1000 })
  const lanesRef = { current: el }
  const manual = { current: 0 }
  const programmatic = { current: false }
  const hook = renderHook(
    ({ px, play }: { px: number; play: boolean }) => usePlayheadFollow(lanesRef, px, play, manual, programmatic),
    { initialProps: { px: pxPerS, play: playing } },
  )
  return { el, manual, programmatic, hook }
}

const playheadTo = (t: number) => act(() => useStore.getState().setUI({ playheadS: t }))

describe('usePlayheadFollow', () => {
  it('pages forward while playing and marks its own scroll', () => {
    const { el, programmatic } = mount(true)
    playheadTo(9.75)
    expect(el.scrollLeft).toBe(895)
    expect(programmatic.current).toBe(true)
  })

  it('brings an off-screen jump into view while paused, centred', () => {
    const { el } = mount(false)
    playheadTo(5)
    expect(el.scrollLeft).toBe(0)
    playheadTo(30)
    expect(el.scrollLeft).toBe(2500)
  })

  it('holds off while he is scrolling by hand', () => {
    const { el, manual } = mount(false)
    manual.current = performance.now() + 60_000
    playheadTo(30)
    expect(el.scrollLeft).toBe(0)
  })

  it('uses the zoom of the latest render', () => {
    const { el, hook } = mount(false)
    hook.rerender({ px: 50, play: false })
    playheadTo(30)
    expect(el.scrollLeft).toBe(1000)
  })

  it('unsubscribes on unmount', () => {
    const { el, hook } = mount(false)
    hook.unmount()
    playheadTo(30)
    expect(el.scrollLeft).toBe(0)
  })
})
