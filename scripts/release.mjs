// One-command release: build the desktop app, then publish it to GitHub Releases
// (via scripts/publish.mjs, which generates latest.yml + uploads reliably). Every
// installed copy then auto-updates. Usage:
//   1. bump the version:  npm version patch --no-git-tag-version
//   2. ship it:           GH_TOKEN=<token> npm run release
// Or in one go:           GH_TOKEN=<token> npm run release:patch
// (Claude runs this when you say "ship it".)

import { readFileSync } from 'node:fs'
import { loadToken, openShipLog, runLogged, runLoggedRetry, SHIP_LOG } from './lib.mjs'

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

  // Generate latest.yml + create the tag + published release + upload all assets.
  await runLoggedRetry('node scripts/publish.mjs', 'upload to GitHub', shipLog)
} catch (e) {
  console.error(`\n❌ v${version} did not publish. ${e.message}`)
  console.error(`   The whole run is in ${SHIP_LOG}`)
  process.exit(1)
}
