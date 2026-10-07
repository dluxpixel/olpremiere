// An update install waits for the editor window to close, and the close waits
// for his save (./closeGate). Main's half of that order, without a window.
//
// Before 2026-10-07 each install request armed its own fallback timer from the
// moment it was asked, and "Stay" stopped only the last one. Two requests (the
// Restart toast and the update card) plus a failed save and Stay: the first
// request's timer still ran the installer, which kills the window he chose to
// keep, with his last changes unwritten. And the fallback counted while the
// Not saved question was open, so a slow answer skipped the settle after it.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createInstallWait } from './installWait'

const FLUSH_MS = 1500
const FALLBACK_MS = 12_000

function rig() {
  const log: string[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const wait = createInstallWait(
    {
      install: () => log.push('install'),
      setTimer: (fn, ms) => {
        const id = next++
        timers.set(id, { fn, ms })
        return id
      },
      clearTimer: (handle) => void timers.delete(handle as number),
    },
    { flushMs: FLUSH_MS, fallbackMs: FALLBACK_MS },
  )
  return {
    wait,
    log,
    /** What is counting down right now, in ms. */
    counting: () => [...timers.values()].map((t) => t.ms),
    /** Let every timer that is set run, oldest first. */
    runTimers: () => {
      for (const [id, t] of [...timers]) {
        timers.delete(id)
        t.fn()
      }
    },
  }
}

describe('installing an update over the editor window', () => {
  it('waits for the save, then the window, then a beat, then installs once', () => {
    const { wait, log, counting, runTimers } = rig()
    expect(wait.begin()).toBe(true)
    // The close gate holds the window while the page saves: nothing counts yet.
    expect(counting()).toEqual([])
    wait.closeLetThrough()
    expect(counting()).toEqual([FALLBACK_MS])
    wait.windowClosed()
    expect(counting()).toEqual([FLUSH_MS])
    runTimers()
    expect(log).toEqual(['install'])
    runTimers()
    expect(log).toEqual(['install'])
    expect(wait.pending()).toBe(true)
  })

  it('a second request while one is on its way joins it, and Stay stops the whole install', () => {
    const { wait, log, counting, runTimers } = rig()
    wait.begin()
    expect(wait.begin()).toBe(false)
    // The save failed, the Not saved question is open: still nothing counts.
    expect(counting()).toEqual([])
    wait.cancel()
    runTimers()
    expect(log).toEqual([])
    expect(wait.pending()).toBe(false)
  })

  it('after Close anyway the install still waits for the window and the beat', () => {
    const { wait, log, counting, runTimers } = rig()
    wait.begin()
    // However long the question stayed open, the fallback starts only now.
    wait.closeLetThrough()
    wait.windowClosed()
    expect(counting()).toEqual([FLUSH_MS])
    runTimers()
    expect(log).toEqual(['install'])
  })

  it('a window that will not close once the save let it go is installed over after the fallback', () => {
    const { wait, log, runTimers } = rig()
    wait.begin()
    wait.closeLetThrough()
    runTimers()
    expect(log).toEqual(['install'])
  })

  it('after Stay, his own close of the window later installs nothing, and a new Restart starts again', () => {
    const { wait, log, runTimers } = rig()
    wait.begin()
    wait.cancel()
    wait.closeLetThrough()
    wait.windowClosed()
    runTimers()
    expect(log).toEqual([])
    expect(wait.begin()).toBe(true)
    wait.closeLetThrough()
    wait.windowClosed()
    runTimers()
    expect(log).toEqual(['install'])
  })
})

describe('main wires the install to the close', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('takes one install request at a time, and has no timer of its own', () => {
    const handler = main.slice(main.indexOf("ipcMain.on('update:install'"))
    const body = handler.slice(0, handler.indexOf('\n    })\n'))
    expect(body).toMatch(/if \(!installWait\.begin\(\)\) return/)
    expect(body).not.toMatch(/setTimeout/)
  })

  it('starts the fallback only once the gate lets the close through, and Stay stops it', () => {
    expect(main).toMatch(/if \(gate\.onClose\(\)\) e\.preventDefault\(\)\s*(\/\/[^\n]*\s*)*else installWait\.closeLetThrough\(\)/)
    expect(main).toMatch(/onStay: \(\) => installWait\.cancel\(\)/)
    expect(main).toMatch(/win\.on\('closed', \(\) => installWait\.windowClosed\(\)\)/)
  })
})
