// The rule he asked for on 2026-08-17: an update needs no click. The rule he did
// NOT ask for and would hate: an app that restarts while he is talking to a camera.
// And his pick on 2026-09-27: never straight after he opens it. All three live in
// one function, so all three are pinned here.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IDLE_APPLY_S, updateApplyDecision } from './updateApply'

describe('updateApplyDecision', () => {
  it('waits rather than restarting under him while he is working', () => {
    expect(updateApplyDecision({ idleSeconds: 0, busy: false })).toBe('when-idle')
    expect(updateApplyDecision({ idleSeconds: IDLE_APPLY_S - 1, busy: false })).toBe('when-idle')
  })

  it('applies itself once he has stepped away, so there is no click', () => {
    expect(updateApplyDecision({ idleSeconds: IDLE_APPLY_S, busy: false })).toBe('now')
    expect(updateApplyDecision({ idleSeconds: 4000, busy: false })).toBe('now')
  })

  it('never applies through an export, however long he has been away', () => {
    expect(updateApplyDecision({ idleSeconds: 9999, busy: true })).toBe('never')
  })

  it('five minutes, so a coffee applies it and a pause for thought does not', () => {
    expect(IDLE_APPLY_S).toBe(300)
  })
})

describe('opening the app never restarts it into an update', () => {
  // He opened the app and it went straight into a patch. The decision above has
  // no launch input any more, and main must not grow one back around it.
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('main keeps no post launch apply window', () => {
    expect(main).not.toMatch(/launchedAt|AUTO_APPLY_WINDOW|freshLaunch/)
  })

  it('a waiting update still goes on when he closes the app', () => {
    expect(main).toMatch(/autoUpdater\.autoInstallOnAppQuit = true/)
  })
})
