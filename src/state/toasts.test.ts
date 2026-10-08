// The toast store: the cap, how long a toast stays, the same words said twice, and a toast held
// under the pointer. None of it had a test, and three presses of Ctrl+Z left three identical
// toasts stacked over the timeline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from './toasts'

const messages = () => useToasts.getState().toasts.map((t) => t.message)
const show = (...a: Parameters<ReturnType<typeof useToasts.getState>['show']>) => useToasts.getState().show(...a)

beforeEach(() => {
  vi.useFakeTimers()
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a toast', () => {
  it('is gone after 3.5 seconds, or 7 when it has a button', () => {
    show('Saved')
    show('Clip deleted', 'info', { label: 'Undo', onClick: () => {} })
    vi.advanceTimersByTime(3499)
    expect(messages()).toEqual(['Saved', 'Clip deleted'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual(['Clip deleted'])
    vi.advanceTimersByTime(3500)
    expect(messages()).toEqual([])
  })
})

describe('the same words twice', () => {
  it('are one toast, in its place, with its clock started over', () => {
    show('Undo: Add marker')
    show('Something else')
    vi.advanceTimersByTime(3000)
    show('Undo: Add marker')
    show('Undo: Add marker')
    expect(messages()).toEqual(['Undo: Add marker', 'Something else'])
    // The other one goes on time; the repeated one has 3.5 seconds from its last showing.
    vi.advanceTimersByTime(500)
    expect(messages()).toEqual(['Undo: Add marker'])
    vi.advanceTimersByTime(2999)
    expect(messages()).toEqual(['Undo: Add marker'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual([])
  })

  it('stay two toasts when they are a different kind, or carry a button', () => {
    show('Could not save', 'info')
    show('Could not save', 'danger')
    show('Clip deleted', 'info', { label: 'Undo', onClick: () => {} })
    show('Clip deleted', 'info', { label: 'Undo', onClick: () => {} })
    expect(messages()).toEqual(['Could not save', 'Could not save', 'Clip deleted', 'Clip deleted'])
  })
})

describe('a toast under the pointer', () => {
  it('stays while held, and goes with the time it had left once let go', () => {
    show('Undo: Add marker')
    const id = useToasts.getState().toasts[0].id
    vi.advanceTimersByTime(1000)
    useToasts.getState().hold(id)
    vi.advanceTimersByTime(10_000)
    expect(messages()).toEqual(['Undo: Add marker'])
    useToasts.getState().release(id)
    vi.advanceTimersByTime(2499)
    expect(messages()).toEqual(['Undo: Add marker'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual([])
  })

  it('stays held when the same words are said again, and then has the full time', () => {
    show('Saved')
    const id = useToasts.getState().toasts[0].id
    useToasts.getState().hold(id)
    show('Saved')
    vi.advanceTimersByTime(10_000)
    expect(messages()).toEqual(['Saved'])
    useToasts.getState().release(id)
    vi.advanceTimersByTime(3499)
    expect(messages()).toEqual(['Saved'])
    vi.advanceTimersByTime(1)
    expect(messages()).toEqual([])
  })
})

describe('the stack', () => {
  it('holds five, dropping the oldest without a button first', () => {
    show('Clip deleted', 'info', { label: 'Undo', onClick: () => {} })
    for (const n of [1, 2, 3, 4, 5]) show(`file ${n} could not be read`, 'danger')
    expect(messages()).toEqual(['Clip deleted', 'file 2 could not be read', 'file 3 could not be read', 'file 4 could not be read', 'file 5 could not be read'])
  })
})
