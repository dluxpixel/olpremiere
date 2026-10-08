// The export on his taskbar button, driven with a stand-in window: the real calls are Electron's own.
import { describe, expect, it } from 'vitest'
import { showExportOnTaskbar, type TaskbarWindow } from './exportTaskbar'

function fakeWindow(focused: boolean) {
  const calls: string[] = []
  let onFocus: (() => void) | null = null
  const win: TaskbarWindow = {
    isDestroyed: () => false,
    isFocused: () => focused,
    setProgressBar: (p, o) => void calls.push(`bar ${p}${o ? ' ' + o.mode : ''}`),
    flashFrame: (f) => void calls.push(`flash ${f}`),
    once: (_e, fn) => {
      onFocus = fn
    },
  }
  return { win, calls, focus: () => onFocus?.() }
}

describe('the export on the taskbar button', () => {
  it('fills with the percent while the video is made, and moves while it gets ready', () => {
    const { win, calls } = fakeWindow(false)
    showExportOnTaskbar(win, { kind: 'busy' })
    showExportOnTaskbar(win, { kind: 'progress', fraction: 0.42 })
    showExportOnTaskbar(win, { kind: 'progress', fraction: 7 })
    showExportOnTaskbar(win, { kind: 'progress', fraction: Number.NaN })
    expect(calls).toEqual(['bar 1 indeterminate', 'bar 0.42 normal', 'bar 1 normal', 'bar 0 normal'])
  })

  it('clears when it is done, and flashes until he comes back when he was away', () => {
    const { win, calls, focus } = fakeWindow(false)
    showExportOnTaskbar(win, { kind: 'done' })
    expect(calls).toEqual(['bar -1', 'flash true'])
    focus()
    expect(calls).toEqual(['bar -1', 'flash true', 'flash false'])
  })

  it('goes red on a failure, and does not flash while he is looking', () => {
    const { win, calls } = fakeWindow(true)
    showExportOnTaskbar(win, { kind: 'failed' })
    expect(calls).toEqual(['bar 1 error'])
    showExportOnTaskbar(win, { kind: 'clear' })
    expect(calls).toEqual(['bar 1 error', 'bar -1'])
  })

  it('does nothing to a window that is already gone', () => {
    const { win, calls } = fakeWindow(false)
    win.isDestroyed = () => true
    showExportOnTaskbar(win, { kind: 'failed' })
    expect(calls).toEqual([])
  })
})
