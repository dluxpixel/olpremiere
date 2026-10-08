// @vitest-environment jsdom
//
// Safe margins stays the way he left it. It lived in the Monitor's own state and
// came back off on every start and every F5; his words, 2026-10-04: "I was
// actually using that a lot."

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  localStorage.clear()
  vi.resetModules()
})

/** A fresh settings module, as the next start would load it. */
const restart = async () => (await import('./settings')).useSettings.getState()

describe('safe margins', () => {
  it('starts off on a fresh profile', async () => {
    expect((await restart()).safeMargins).toBe(false)
  })

  it('is still on after a restart once he turns it on', async () => {
    const { setSafeMargins } = await import('./settings')
    setSafeMargins(true)
    vi.resetModules()
    expect((await restart()).safeMargins).toBe(true)
  })

  it('is off again after a restart once he turns it off', async () => {
    const { setSafeMargins } = await import('./settings')
    setSafeMargins(true)
    setSafeMargins(false)
    vi.resetModules()
    expect((await restart()).safeMargins).toBe(false)
  })

  it('the monitor reads the remembered switch, not a state of its own', () => {
    // From the repo root: under jsdom, import.meta.url is not a file address.
    const monitor = readFileSync(path.join(process.cwd(), 'src', 'components', 'Monitor.tsx'), 'utf8')
    expect(monitor).toMatch(/const safeMargins = useSettings\(\(s\) => s\.safeMargins\)/)
    expect(monitor).not.toMatch(/\[safeMargins, setSafeMargins\] = useState/)
  })

  it('travels with his other settings in their file', async () => {
    const { PREFS_KEYS } = await import('./prefsHome')
    expect(PREFS_KEYS).toContain('olpremiere:settings:safe-margins')
  })
})
