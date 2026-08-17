// One-command release: build the desktop app, then publish it to GitHub Releases
// (via scripts/publish.mjs, which generates latest.yml + uploads reliably). Every
// installed copy then auto-updates. Usage:
//   1. bump the version:  npm version patch --no-git-tag-version
//   2. ship it:           GH_TOKEN=<token> npm run release
// Or in one go:           GH_TOKEN=<token> npm run release:patch
// (Claude runs this when you say "ship it".)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isBigUpdate, loadToken, openShipLog, runLogged, runLoggedRetry, SHIP_LOG } from './lib.mjs'

/**
 * The last released tag, or '' when git cannot say. Never throws: a missing tag
 * makes `isBigUpdate` answer yes, which runs the stronger check rather than
 * skipping it.
 */
const previousTag = () => {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const OUT = process.env.OLP_OUT || 'C:/Users/skyle/AppData/Local/olp-build/release'
const token = loadToken()
if (!token) {
  console.error('❌ No GitHub token. Put GH_TOKEN=... in a gitignored .env.release (copy .env.release.example), or set $GH_TOKEN.')
  process.exit(1)
}
process.env.GH_TOKEN = token // so the build/publish subprocesses inherit it
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
console.log(`\n▶ Releasing OL Premiere v${version}\n`)

// Every step is shown live AND kept in the ship log, because on 2026-08-12 this
// script exited 1 after a 25 minute gate had gone green and the reason was gone:
// the run had been piped through `tail`, so all that survived was the error
// object. The rebuild worked and the cause is still unknown. See runLogged.
const shipLog = openShipLog(`release: ${new Date().toISOString()}`)

try {
  // Purely local: a failure here is the code, so it fails once and says so.
  await runLogged('npm run build:electron', 'compile the desktop bundle', shipLog)

  // The installer ships NO node_modules, which is 200 MB he no longer uploads, and
  // that is only safe while the desktop bundle reaches for nothing but node
  // builtins and electron. Checked HERE, right after the bundle is built and
  // before anything is packaged, so a new dependency costs a build rather than a
  // release that installs and then fails on his machine.
  await runLogged('node scripts/check-self-contained.mjs', 'the bundle needs no node_modules', shipLog)

  // Build the installer + blockmap (no electron-builder publish, since publish.mjs owns
  // the upload so a transient network blip can't leave a half-published release).
  //
  // ⛔ IT TOUCHES THE NETWORK, which is easy to forget because it reads like a
  // local build. electron-builder downloads its own toolchain, and on 2026-08-12
  // that download died on `socket hang up` AFTER the gate had gone green and the
  // commit was already pushed. Retried, and only on a network signature.
  await runLoggedRetry(`npx electron-builder --win --publish never -c.directories.output=${OUT}`, 'package the installer', shipLog)

  // On a BIG update, open the finished app once, prove it starts, and close it.
  // His ask, 2026-08-17: "you can check the app every time it does a big thing, and
  // then it automatically goes." Nothing had ever checked the packaged app, and no
  // e2e spec can: they all drive the web build through the dev server, which cannot
  // see a file missing from the asar or a path that only breaks inside an installer.
  //
  // ⛔ Gated to a minor or major bump on purpose. He streams, and a window on camera
  // is the thing he asked me to stop doing. A patch ships on the static proof above.
  if (isBigUpdate(previousTag(), version)) {
    await runLogged(
      `node scripts/smoke-packaged.mjs "${OUT}/win-unpacked/OL Premiere.exe"`,
      'the packaged app starts',
      shipLog,
    )
  } else {
    console.log('▶ patch release, so the packaged app check is skipped (no window on his screen)')
  }

  // Generate latest.yml + create the tag + published release + upload all assets.
  await runLoggedRetry('node scripts/publish.mjs', 'upload to GitHub', shipLog)
} catch (e) {
  console.error(`\n❌ v${version} did not publish. ${e.message}`)
  console.error(`   The whole run is in ${SHIP_LOG}`)
  process.exit(1)
}
