/** @vitest-environment jsdom */
// The update card's own program (update.ts), run in a page. It is frameless, on top of
// everything and has no close button, so every answer that ends the download has to
// make it leave on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../electron/ipc-types'
import { SPLASH_CARD_EXIT_MS, UPDATE_CARD_HOLD_MS, UPDATE_STALL_MS } from '../../electron/ipc-types'

let render: (s: UpdateStatus) => void
const updateDismiss = vi.fn()
const updateShrink = vi.fn()

async function openCard(): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  updateDismiss.mockReset()
  updateShrink.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    onUpdateStatus: (cb: (s: UpdateStatus) => void) => {
      render = cb
      return () => undefined
    },
    getUpdateStatus: () => new Promise(() => undefined),
    updateShow: () => undefined,
    updateShrink,
    updateDismiss,
    updateApply: () => undefined,
  }
  await import('./update')
}

describe('the update card leaves on its own', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Long before the stall timer, so it is the answer that sends the card away.
  const settle = UPDATE_CARD_HOLD_MS + SPLASH_CARD_EXIT_MS + 50

  it('⛔ when a download answers "still publishing", instead of sitting there for 90 seconds', async () => {
    await openCard()
    render({ kind: 'downloading', version: '3.23.0', percent: 40 })
    render({ kind: 'pending' })
    vi.advanceTimersByTime(settle)
    expect(settle).toBeLessThan(UPDATE_STALL_MS / 10)
    expect(updateDismiss).toHaveBeenCalled()
    expect(updateShrink).not.toHaveBeenCalled()
  })

  it('when it fails', async () => {
    await openCard()
    render({ kind: 'downloading', version: '3.23.0', percent: 40 })
    render({ kind: 'error', message: 'x' })
    vi.advanceTimersByTime(settle)
    expect(updateDismiss).toHaveBeenCalled()
  })

  it('and becomes the melon when the download is done', async () => {
    await openCard()
    render({ kind: 'downloaded', version: '3.23.0' })
    vi.advanceTimersByTime(settle)
    expect(updateShrink).toHaveBeenCalled()
    expect(updateDismiss).not.toHaveBeenCalled()
  })
})
