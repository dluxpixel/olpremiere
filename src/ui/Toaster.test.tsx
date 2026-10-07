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

  it('keeps a long message to a readable width', () => {
    render(<Toaster />)
    act(() => useToasts.getState().show('Could not write: ' + 'clip.mp4, '.repeat(40), 'danger'))
    expect(screen.getByTestId('toast').className).toMatch(/\bmax-w-\[420px\]/)
  })
})
