// The close waits for the save. Main's half: what a close of the editor does
// before the window is allowed to go. The page's half is
// src/state/closeSave.test.ts.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLOSE_SAVE_TIMEOUT_MS, createCloseGate } from './closeGate'

function rig(opts: { closeAnyway?: boolean } = {}) {
  const log: string[] = []
  let timer: { fn: () => void; ms: number } | null = null
  const gate = createCloseGate({
    askToSave: () => log.push('ask'),
    closeNow: () => log.push('close'),
    confirmCloseUnsaved: () => {
      log.push('confirm')
      return opts.closeAnyway ?? false
    },
    onStay: () => log.push('stay'),
    setTimer: (fn, ms) => (timer = { fn, ms }),
    clearTimer: () => (timer = null),
  })
  return { gate, log, fireTimer: () => timer?.fn(), timerMs: () => timer?.ms ?? null }
}

describe('closing the editor', () => {
  it('holds the close and asks the page to save, and goes once it says the save is down', () => {
    const { gate, log } = rig()
    gate.arm(true)
    expect(gate.onClose()).toBe(true)
    expect(log).toEqual(['ask'])
    gate.onReply(true)
    expect(log).toEqual(['ask', 'close'])
    // The close it starts itself goes through.
    expect(gate.onClose()).toBe(false)
  })

  it('a second click on the X while the save runs asks only once', () => {
    const { gate, log } = rig()
    gate.arm(true)
    gate.onClose()
    expect(gate.onClose()).toBe(true)
    expect(log).toEqual(['ask'])
  })

  it('asks him when the save failed, and stays when he says stay', () => {
    const { gate, log } = rig({ closeAnyway: false })
    gate.arm(true)
    gate.onClose()
    gate.onReply(false)
    expect(log).toEqual(['ask', 'confirm', 'stay'])
    // His next close saves again rather than slipping through.
    expect(gate.onClose()).toBe(true)
    expect(log.at(-1)).toBe('ask')
  })

  it('closes when the save failed and he says close anyway', () => {
    const { gate, log } = rig({ closeAnyway: true })
    gate.arm(true)
    gate.onClose()
    gate.onReply(false)
    expect(log).toEqual(['ask', 'confirm', 'close'])
  })

  it('goes anyway when the page never answers, the way every close went before', () => {
    const { gate, log, fireTimer, timerMs } = rig()
    gate.arm(true)
    gate.onClose()
    expect(timerMs()).toBe(CLOSE_SAVE_TIMEOUT_MS)
    fireTimer()
    expect(log).toEqual(['ask', 'close'])
    // A late answer changes nothing.
    gate.onReply(false)
    expect(log).toEqual(['ask', 'close'])
  })

  it('does not hold a page that never said it can answer (a crash at boot closes at once)', () => {
    const { gate, log } = rig()
    expect(gate.onClose()).toBe(false)
    expect(log).toEqual([])
  })

  it('a page that goes away mid save lets the close through, and the next page must arm again', () => {
    const { gate, log } = rig()
    gate.arm(true)
    gate.onClose()
    gate.pageGone()
    expect(log).toEqual(['ask', 'close'])
    gate.onCloseRefused()
    expect(gate.onClose()).toBe(false)
  })

  it('saves again on the next close after he chose to keep an export running', () => {
    const { gate, log } = rig()
    gate.arm(true)
    gate.onClose()
    gate.onReply(true)
    // The export question said keep exporting, so the window stayed.
    gate.onCloseRefused()
    expect(gate.onClose()).toBe(true)
    expect(log).toEqual(['ask', 'close', 'ask'])
  })
})

describe('main wires the gate to the editor window', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('holds the window close on the gate', () => {
    expect(main).toMatch(/win\.on\('close', \(e\) => \{\s*if \(gate\.onClose\(\)\) e\.preventDefault\(\)/)
  })

  it('never installs an update before the close has had time to save', () => {
    expect(main).toMatch(/INSTALL_CLOSE_TIMEOUT_MS = CLOSE_SAVE_TIMEOUT_MS \+/)
  })
})
