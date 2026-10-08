// @vitest-environment jsdom
//
// A toast waits while the pointer is on it. An Undo toast used to vanish as he reached for its
// button, because its clock ran on whatever the pointer did.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from '../state/toasts'
import { Toaster } from './Toaster'

beforeEach(() => {
  vi.useFakeTimers()
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the Toaster', () => {
  it('holds a toast under the pointer and lets it go after the pointer leaves', () => {
    render(<Toaster />)
    act(() => useToasts.getState().show('Clip deleted', 'info', { label: 'Undo', onClick: () => {} }))
    const toast = screen.getByTestId('toast')
    act(() => vi.advanceTimersByTime(6000))
    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(20_000))
    expect(screen.getByTestId('toast')).toBeTruthy()
    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(999))
    expect(screen.queryByTestId('toast')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  // 2026-10-08: in full screen the bar is the bottom of the screen. A toast in the usual corner sat
  // on Exit full screen, and with its clock held under the pointer the click he meant for that
  // button dismissed the toast and left full screen on.
  it('stands above the bar under the picture in full screen, and in its usual corner in a window', () => {
    const monitor = document.createElement('section')
    const bar = document.createElement('div')
    bar.dataset.testid = 'transport-bar'
    // The one row bar, 44px, along the bottom of the screen.
    bar.getBoundingClientRect = () => new DOMRect(0, window.innerHeight - 44, window.innerWidth, 44)
    monitor.append(bar)
    document.body.append(monitor)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => monitor })
    try {
      act(() => useToasts.getState().show('Saved into your media', 'success'))
      const { unmount } = render(<Toaster />)
      expect(screen.getByTestId('toast-stack').style.bottom).toBe(`${44 + 8}px`)
      unmount()
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
      monitor.remove()
    }
    render(<Toaster />)
    expect(screen.getByTestId('toast-stack').style.bottom).toBe('')
    expect(screen.getByTestId('toast-stack').className).toMatch(/\bbottom-4\b/)
  })

  it('keeps a long message to a readable width', () => {
    render(<Toaster />)
    act(() => useToasts.getState().show('Could not write: ' + 'clip.mp4, '.repeat(40), 'danger'))
    expect(screen.getByTestId('toast').className).toMatch(/\bmax-w-\[420px\]/)
  })
})
