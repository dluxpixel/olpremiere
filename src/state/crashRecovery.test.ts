/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { announceCrashRecovery, CRASH_RECOVERED_TOAST } from './crashRecovery'
import { useToasts } from './toasts'

describe('announceCrashRecovery', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }))

  it('tells him when this page was loaded because the last one crashed', async () => {
    expect(await announceCrashRecovery({ takeCrashRecovered: async () => true })).toBe(true)
    const toasts = useToasts.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe(CRASH_RECOVERED_TOAST)
  })

  it('says nothing on an ordinary start', async () => {
    expect(await announceCrashRecovery({ takeCrashRecovered: async () => false })).toBe(false)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })

  it('says nothing on the web, or with an older shell that cannot answer', async () => {
    expect(await announceCrashRecovery(undefined)).toBe(false)
    expect(await announceCrashRecovery({ takeCrashRecovered: () => Promise.reject(new Error('no handler')) })).toBe(false)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })

  it('is plain words with no dash', () => {
    const codes = [...CRASH_RECOVERED_TOAST].map((c) => c.charCodeAt(0))
    expect(codes).not.toContain(0x2013)
    expect(codes).not.toContain(0x2014)
  })
})
