import { vi } from 'vitest'

// DOM helpers for the timeline hook and component tests (jsdom has no layout,
// no ResizeObserver and a real-time rAF). Not a test file itself.

/** A manual requestAnimationFrame: frames run only when flushed. */
export function installManualRaf(): { flush: () => void; pending: () => number } {
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = next++
    queue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id)
  })
  return {
    /** Run every frame booked so far (frames they book wait for the next flush). */
    flush: () => {
      const due = [...queue.entries()]
      queue.clear()
      for (const [, cb] of due) cb(performance.now())
    },
    pending: () => queue.size,
  }
}

/** A ResizeObserver stand-in that records what it observes. */
export function installResizeObserver(): { observed: Element[]; disconnected: () => number } {
  const observed: Element[] = []
  let disconnects = 0
  class FakeResizeObserver {
    constructor(public cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observed.push(el)
    }
    unobserve() {}
    disconnect() {
      disconnects += 1
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return { observed, disconnected: () => disconnects }
}

/** A div with the box a laid-out lanes container would have. */
export function makeLanesEl(box: { left?: number; top?: number; width?: number; height?: number } = {}): HTMLDivElement {
  const { left = 0, top = 0, width = 1000, height = 400 } = box
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  el.getBoundingClientRect = () =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}
