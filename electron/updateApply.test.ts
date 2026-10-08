// The rule he asked for on 2026-08-17: an update needs no click. The rule he did
// NOT ask for and would hate: an app that restarts while he is talking to a camera.
// And his pick on 2026-09-27: never straight after he opens it. All three live in
// one function, so all three are pinned here.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IDLE_APPLY_S, INSTALL_DECLINED_QUIT_MS, installOrQuit, updateApplyDecision } from './updateApply'

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

  // Set in ./updateFlow since 2026-10-06, on the updater main hands it. The flow's own
  // test runs it ("turns on download and install on quit"); this pins the hand over.
  it('a waiting update still goes on when he closes the app', () => {
    const flow = readFileSync(new URL('./updateFlow.ts', import.meta.url), 'utf8')
    expect(flow).toMatch(/d\.updater\.autoInstallOnAppQuit = true/)
    expect(main).toMatch(/startUpdateFlow\(\{\s*updater: autoUpdater,/)
  })
})

// ⛔ Closed with an update waiting and his click on the icon in the meantime: the app
// installs and opens again through quitAndInstall. But electron-updater's quitAndInstall
// quits only when its install went ahead. With no installer on disk, or one already
// started, it returns and nothing quits: a process with no window kept the single
// instance lock, and every later launch handed over to it and closed at once.
describe('installOrQuit', () => {
  const rig = (goesAhead: boolean) => {
    const calls: string[] = []
    let timer: (() => void) | null = null
    const updater = {
      quitAndInstall: (silent: boolean, runAfter: boolean) => {
        calls.push(`install silent=${silent} runAfter=${runAfter}`)
        if (goesAhead) calls.push('updater quits')
      },
    }
    installOrQuit(updater, () => calls.push('quit'), (fn, ms) => {
      calls.push(`wait ${ms}`)
      timer = fn
    })
    return { calls, fire: () => timer?.() }
  }

  it('⛔ quits all the same when the updater declines the install', () => {
    const r = rig(false)
    r.fire()
    expect(r.calls).toEqual(['install silent=true runAfter=true', `wait ${INSTALL_DECLINED_QUIT_MS}`, 'quit'])
  })

  it('installs silently and opens the new version, and the late quit is a no op behind the updater\'s own', () => {
    const r = rig(true)
    expect(r.calls.slice(0, 2)).toEqual(['install silent=true runAfter=true', 'updater quits'])
    expect(INSTALL_DECLINED_QUIT_MS).toBeGreaterThanOrEqual(1000)
  })

  it('is what a close with an update waiting uses, so a declined install still ends the app', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    const closed = main.slice(main.indexOf("app.on('window-all-closed'"))
    expect(closed).toContain('openAfterInstall ? installOrQuit(autoUpdater, () => app.quit(), setTimeout) : app.quit()')
    expect(closed).not.toMatch(/\? autoUpdater\.quitAndInstall\(/)
  })
})
