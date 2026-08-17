// The rule he asked for on 2026-08-17: an update needs no click. The rule he did
// NOT ask for and would hate: an app that restarts while he is talking to a camera.
// Both live in one function, so both are pinned here.

import { describe, expect, it } from 'vitest'
import { IDLE_APPLY_S, updateApplyDecision } from './updateApply'

describe('updateApplyDecision', () => {
  it('applies at once in the launch window, which is what it already did', () => {
    expect(updateApplyDecision({ freshLaunch: true, idleSeconds: 0, busy: false })).toBe('now')
  })

  it('waits rather than restarting under him while he is working', () => {
    expect(updateApplyDecision({ freshLaunch: false, idleSeconds: 0, busy: false })).toBe('when-idle')
    expect(updateApplyDecision({ freshLaunch: false, idleSeconds: IDLE_APPLY_S - 1, busy: false })).toBe('when-idle')
  })

  it('applies itself once he has stepped away, so there is no click', () => {
    expect(updateApplyDecision({ freshLaunch: false, idleSeconds: IDLE_APPLY_S, busy: false })).toBe('now')
    expect(updateApplyDecision({ freshLaunch: false, idleSeconds: 4000, busy: false })).toBe('now')
  })

  it('never applies through an export, whichever door is open', () => {
    expect(updateApplyDecision({ freshLaunch: true, idleSeconds: 9999, busy: true })).toBe('never')
    expect(updateApplyDecision({ freshLaunch: false, idleSeconds: 9999, busy: true })).toBe('never')
  })

  it('five minutes, so a coffee applies it and a pause for thought does not', () => {
    expect(IDLE_APPLY_S).toBe(300)
  })
})
