// F5 and the melon reload the page, which throws it away like a close does. The
// last edit has to be written first, and a write that fails must not be thrown
// away with the page.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
let saveLands: (ok: boolean) => void = () => undefined
const toasts: { message: string; action?: string }[] = []

vi.mock('./persistence', () => ({
  saveBeforeClose: () =>
    new Promise<boolean>((resolve) => {
      order.push('save started')
      saveLands = (ok) => {
        order.push(ok ? 'saved' : 'save failed')
        resolve(ok)
      }
    }),
}))
vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (message: string, _kind?: string, action?: { label: string }) => toasts.push({ message, action: action?.label }),
    }),
  },
}))

const { RELOAD_SAVE_TIMEOUT_MS, reloadAndCheckForUpdates } = await import('./reloadApp')
const { useUpdateFeed } = await import('./updateStatus')

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  order.length = 0
  toasts.length = 0
  useUpdateFeed.setState({ status: null })
  vi.stubGlobal('window', {
    api: { checkForUpdates: async () => undefined },
    location: { reload: () => order.push('reload') },
  })
})

describe('reloading the app', () => {
  it('reloads only after the last edit is written', async () => {
    const done = reloadAndCheckForUpdates()
    await settle()
    expect(order).toEqual(['save started'])
    saveLands(true)
    await done
    expect(order).toEqual(['save started', 'saved', 'reload'])
  })

  it('stays put when the save failed, and lets him reload anyway', async () => {
    const done = reloadAndCheckForUpdates()
    await settle()
    saveLands(false)
    await done
    expect(order).not.toContain('reload')
    expect(toasts).toEqual([
      { message: 'Could not save, so the app did not reload. Your work is still here', action: 'Reload anyway' },
    ])
  })

  it('a save that never answers does not hold F5 forever, and does not reload over it', async () => {
    vi.useFakeTimers()
    try {
      const done = reloadAndCheckForUpdates()
      await vi.advanceTimersByTimeAsync(RELOAD_SAVE_TIMEOUT_MS)
      await done
      expect(order).toEqual(['save started'])
      expect(toasts.map((t) => t.action)).toEqual(['Reload anyway'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not even save when an update was found, because it does not reload', async () => {
    useUpdateFeed.setState({ status: { kind: 'downloaded', version: '9.9.9' } })
    await reloadAndCheckForUpdates()
    expect(order).toEqual([])
  })
})
