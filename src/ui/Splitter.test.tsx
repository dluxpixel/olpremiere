// @vitest-environment jsdom
//
// A panel edge stays under the pointer, also after the pointer has gone past the panel's limit.
// The handle used to send the move since the last event and the panel added each one up, so on
// the way back from past a limit the panel moved at once and the edge drifted off the pointer.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIZE_LIMITS, sizeAfterDrag, useLayoutSizes } from '../useLayoutSizes'
import { Splitter } from './Splitter'

/** The left handle and the left panel's width, wired the way App.tsx wires them. */
function LeftEdge() {
  const { sizes, startDrag, adjust, endDrag } = useLayoutSizes()
  return (
    <>
      <span data-testid="left">{sizes.left}</span>
      <Splitter
        orientation="vertical"
        testId="splitter-left"
        onDragStart={startDrag}
        onDrag={(d) => adjust('left', d)}
        onDragEnd={endDrag}
      />
    </>
  )
}

const width = () => Number(screen.getByTestId('left').textContent)

beforeEach(() => {
  // His window, so the panels are not squeezed by jsdom's 1024.
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true })
  localStorage.clear()
  localStorage.setItem('olpremiere.layout.v2', JSON.stringify({ left: 500, right: 450, bottom: 320 }))
  // jsdom has no pointer capture. The handle only needs to know it holds the pointer.
  let held = false
  HTMLElement.prototype.setPointerCapture = () => {
    held = true
  }
  HTMLElement.prototype.hasPointerCapture = () => held
  HTMLElement.prototype.releasePointerCapture = () => {
    held = false
  }
})
afterEach(cleanup)

describe('a panel edge and the pointer', () => {
  it('stay together after the pointer went past the limit and came back', () => {
    render(<LeftEdge />)
    const handle = screen.getByTestId('splitter-left')
    expect(width()).toBe(500)
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    // 100 to the right: the panel stops at its ceiling, 520, and the pointer goes on.
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 })
    expect(width()).toBe(SIZE_LIMITS.left[1])
    // 60 back is still 40 past the limit, so the edge does not move yet.
    fireEvent.pointerMove(handle, { clientX: 540, pointerId: 1 })
    expect(width()).toBe(520)
    // 40 more and the pointer is back where it pressed, and so is the edge.
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 })
    expect(width()).toBe(500)
    fireEvent.pointerUp(handle, { clientX: 500, pointerId: 1 })
  })

  it('sends how far the pointer has gone since the press', () => {
    const got: number[] = []
    render(<Splitter orientation="horizontal" onDrag={(d) => got.push(d)} />)
    const handle = screen.getByRole('separator')
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 340, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 340, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 280, pointerId: 1 })
    expect(got).toEqual([40, -20])
  })
})

describe('the end of a drag', () => {
  // The layout is written once, when the drag ends. A handle that lost the pointer without a
  // release (another window took it) never ended the drag, so the new width stayed on screen
  // and was forgotten.
  it('comes when the handle loses the pointer without a release, and writes the new width', () => {
    render(<LeftEdge />)
    const handle = screen.getByTestId('splitter-left')
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 })
    expect(width()).toBe(450)
    handle.releasePointerCapture(1)
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(JSON.parse(localStorage.getItem('olpremiere.layout.v2') ?? '{}').left).toBe(450)
  })

  it('comes once for a release, also when the lost pointer event follows it', () => {
    let ends = 0
    render(<Splitter orientation="vertical" onDrag={() => {}} onDragEnd={() => ends++} />)
    const handle = screen.getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 320, pointerId: 1 })
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(ends).toBe(1)
    // A release with no press before it is not a drag.
    fireEvent.pointerUp(handle, { clientX: 320, pointerId: 1 })
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(ends).toBe(1)
  })
})

describe('sizeAfterDrag', () => {
  it('is the size at the press plus the total, inside the limits', () => {
    expect(sizeAfterDrag('left', 500, 100)).toBe(520)
    expect(sizeAfterDrag('left', 500, 40)).toBe(520)
    expect(sizeAfterDrag('left', 500, 0)).toBe(500)
    expect(sizeAfterDrag('left', 300, -400)).toBe(SIZE_LIMITS.left[0])
  })
})
