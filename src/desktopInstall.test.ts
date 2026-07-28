// Installing an update must never put anything in front of him.
//
// 2026-07-28, looking at a Next/Back/Cancel wizard on top of his work: "every time
// a new install happens, this menu comes up and I have to manually install it. Can
// we get rid of that completely so it's an automatic process?"
//
// Two settings decide that, they live in two different files, and neither one
// fails loudly if it drifts. A wrong value here does not break a build or a test;
// it just quietly hands him a wizard again on the next release, which is exactly
// how this went unnoticed for twenty releases.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

describe('the installer asks him nothing', () => {
  it('builds the one-click installer, not the assisted wizard', () => {
    // `oneClick: false` IS the wizard: a welcome page, a directory page, a Finish
    // button. One-click installs and starts the app with nothing to click.
    expect(builder).toMatch(/^\s*oneClick:\s*true\s*$/m)
  })

  it('never asks where to install', () => {
    // This option only exists on the assisted installer, so setting it drags the
    // whole wizard back in without ever mentioning oneClick.
    expect(builder).not.toMatch(/allowToChangeInstallationDirectory:\s*true/)
  })

  it('starts the new version by itself once it lands', () => {
    expect(builder).toMatch(/^\s*runAfterFinish:\s*true\s*$/m)
  })

  it('runs the update silently and comes back up', () => {
    // Both arguments are non-default: quitAndInstall() alone shows the installer
    // and does not relaunch, which is the wizard he was clicking through.
    expect(main).toContain('quitAndInstall(true, true)')
  })
})

describe('uninstalling never takes his projects with it', () => {
  it('leaves userData alone', () => {
    // That directory is where every saved project and several gigabytes of media
    // live. An installer that clears it on uninstall would erase all of it.
    expect(builder).toMatch(/^\s*deleteAppDataOnUninstall:\s*false\s*$/m)
  })
})
