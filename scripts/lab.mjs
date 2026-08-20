// Build the LAB copy of OL Premiere: a second app that shares nothing with his.
//
// His ask, 2026-08-19: "Can you work on a separate version of the OL Premiere so
// I can work on edits while you work on making the program better?"
//
// So this produces "OL Premiere Lab", which:
//   - installs to its own folder, so it never overwrites his app
//   - saves to its own projects store, because electron/main.ts gives the lab a
//     different origin and a browser engine keys storage on the origin alone
//   - keeps its own automatic backups, inside its own folder, so nothing of mine
//     ever appears next to his
//   - never auto-updates, so it stays whatever was on the bench when it was built
//
// NOT AN INSTALLER, ON PURPOSE. electron-builder's NSIS step is the slow half of
// a release and it RUNS the app when it finishes, which would put a window in
// front of him. `--dir` writes a plain folder with an exe in it. Rebuilding is
// the same one command: no uninstall, no version numbers, nothing to click.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.USERPROFILE || 'C:/Users/skyle'

// ⛔ BUILD OUTSIDE THE REPO, AND NOWHERE HE CLICKS.
//
// Two reasons, and both are hard rules.
//
// His words, 2026-08-20: *"make sure i dont ever accidentally click your
// version."* The first cut of this script put a shortcut on his Desktop right
// beside the real app and a copy in `.launchers` next to the tools he actually
// uses, which is exactly the accident he means. The lab now lives in the build
// folder and NOTHING of his points at it. It is launched by path, by me.
//
// And it cannot be built inside the repo anyway. electron-builder unpacks three
// hundred megabytes of Electron into a temporary folder and then renames it into
// place; inside the repo, which lives on his Desktop, that rename comes back
// EPERM every single time with the work already done. Windows guards the Desktop
// and Documents trees against that move by a process it does not recognise, and
// this one is spawned by an agent shell. The release script has always built
// here for the same reason, and now the reason is written down.
const OUT = 'C:/Users/skyle/AppData/Local/olp-build/lab'
const APP_DIR = path.join(OUT, 'win-unpacked')
// ⛔ THE FILE ON DISK IS NOT CALLED OL PREMIERE ANYTHING. Windows Search indexes
// executables, so an exe named after his app is one Start menu search away from
// being clicked by mistake, wherever it is parked. electron-builder takes the
// binary name separately from the product name, so the app still KNOWS it is the
// lab (app.getName drives the origin, the profile and the title bar) while the
// file itself answers to nothing he would ever type.
const EXE_NAME = 'olp-bench.exe'

/** Places an older build of this script left the lab. Cleared on every run. */
const STRAYS = [
  path.join(HOME, 'Desktop', 'OL Premiere Lab.lnk'),
  path.join(HOME, 'Desktop', '.launchers', 'OL Premiere Lab'),
  path.join(HOME, 'Documents', 'OL Premiere Lab Backups'),
]

/**
 * Run a command, inheriting stdio, and reject on a non-zero exit.
 *
 * ⛔ QUOTE ANYTHING WITH A SPACE IN IT. `shell: true` is what finds `npm` and
 * `npx` on Windows, and it hands the whole line to cmd, which splits it again on
 * spaces. So `-c.productName=OL Premiere Lab` arrived as three arguments and
 * electron-builder answered "Unknown arguments: Premiere, Lab". The product name
 * is the one thing this script exists to pass, so it is the one thing that has to
 * survive the trip.
 */
function run(cmd, args, opts = {}) {
  const quoted = args.map((a) => (/\s/.test(a) && !a.startsWith('"') ? `"${a}"` : a))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, quoted, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

async function main() {
  console.log('lab: building the renderer and main process')
  await run('npm', ['run', 'build:electron'])

  console.log('lab: packaging OL Premiere Lab')
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  await run('npx', [
    'electron-builder',
    '--win',
    '--dir',
    // The name decides everything downstream: the install folder, the backups
    // folder, and (through app.getName in electron/main.ts) the origin and the
    // no-auto-update guard.
    '-c.productName=OL Premiere Lab',
    '-c.extraMetadata.productName=OL Premiere Lab',
    '-c.extraMetadata.name=ol-premiere-lab',
    '-c.appId=com.olpremiere.lab',
    '-c.win.executableName=olp-bench',
    `-c.directories.output=${OUT}`,
  ])

  const built = path.join(APP_DIR, EXE_NAME)
  if (!existsSync(built)) throw new Error(`lab: expected an app at ${built} and there is none`)

  // Every run, not just the first: a stale shortcut from an older build must
  // never outlive the rule above.
  for (const stray of STRAYS) {
    if (existsSync(stray)) {
      rmSync(stray, { recursive: true, force: true })
      console.log(`lab: cleared a stray copy at ${stray}`)
    }
  }

  console.log(`lab: ready at ${built}`)
  console.log('lab: nothing of his points at it, launch it by path')
}

main().catch((err) => {
  console.error('lab: FAILED', err)
  process.exit(1)
})
