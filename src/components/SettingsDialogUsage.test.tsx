// @vitest-environment jsdom
//
// The quiet line in Settings about the usage log: that it says plainly what the log is and
// where it lives, that its switch really turns it off (and is remembered), and that the
// button beside it opens the folder on the desktop and saves a copy in the browser.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FOLDER = 'C:\\Users\\skyle\\AppData\\Roaming\\OL Premiere\\Usage log'

async function load(api?: object) {
  vi.resetModules()
  ;(window as { api?: object }).api = api
  const { SettingsDialog } = await import('./SettingsDialog')
  const { useSettings } = await import('../state/settings')
  const web = await import('../state/usageStoreWeb')
  return { SettingsDialog, useSettings, web }
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  delete (window as { api?: object }).api
})

describe('the usage log line in Settings', () => {
  it('is on by default and says, in plain words, what it is and that it stays here', async () => {
    const { SettingsDialog } = await load()
    render(<SettingsDialog onClose={() => {}} />)
    expect(screen.getByTestId('settings-usage-log').textContent).toBe('On')
    expect(screen.getByTestId('settings-usage-log').getAttribute('aria-pressed')).toBe('true')
    const row = screen.getByText(/private list of the buttons and keys/i).textContent ?? ''
    expect(row).toMatch(/never what you type or which files you open/i)
    expect(row).toMatch(/never sent anywhere/i)
    expect(row).toMatch(/kept in this browser/i)
    expect(row).not.toMatch(/[\u2013\u2014]/)
  })

  it('turns it off with the switch, and remembers that', async () => {
    const { SettingsDialog, useSettings } = await load()
    render(<SettingsDialog onClose={() => {}} />)
    await userEvent.click(screen.getByTestId('settings-usage-log'))
    expect(screen.getByTestId('settings-usage-log').textContent).toBe('Off')
    expect(useSettings.getState().usageLog).toBe(false)
    expect(localStorage.getItem('olpremiere:settings:usage-log')).toBe('off')
    await userEvent.click(screen.getByTestId('settings-usage-log'))
    expect(useSettings.getState().usageLog).toBe(true)
    // On is the default, so nothing is stored for it.
    expect(localStorage.getItem('olpremiere:settings:usage-log')).toBeNull()
  })

  it('starts off for good when it was switched off before', async () => {
    localStorage.setItem('olpremiere:settings:usage-log', 'off')
    const { SettingsDialog } = await load()
    render(<SettingsDialog onClose={() => {}} />)
    expect(screen.getByTestId('settings-usage-log').textContent).toBe('Off')
  })

  it('in the browser, offers to save a copy of the log, and has no folder to open', async () => {
    const { SettingsDialog, web } = await load()
    const save = vi.spyOn(web, 'saveWebUsageCopy').mockResolvedValue(undefined)
    render(<SettingsDialog onClose={() => {}} />)
    expect(screen.queryByTestId('settings-usage-folder')).toBeNull()
    await userEvent.click(screen.getByTestId('settings-usage-copy'))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('on the desktop, says where the folder is and opens it from a button', async () => {
    const usageReveal = vi.fn().mockResolvedValue(undefined)
    const { SettingsDialog } = await load({ isElectron: true, usageDir: async () => FOLDER, usageReveal })
    render(<SettingsDialog onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('settings-usage-where').textContent).toContain(FOLDER))
    expect(screen.getByTestId('settings-usage-where').textContent).toMatch(/It lives in/)
    expect(screen.queryByTestId('settings-usage-copy')).toBeNull()
    await userEvent.click(screen.getByTestId('settings-usage-folder'))
    expect(usageReveal).toHaveBeenCalledTimes(1)
  })
})
