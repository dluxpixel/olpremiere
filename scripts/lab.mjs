// Build the LAB copy of OL Premiere: a second app that shares nothing with his.
//
// His ask, 2026-08-19: "Can you work on a separate version of the OL Premiere so
// I can work on edits while you work on making the program better?"
//
// So this produces "OL Premiere Lab", which:
//   - installs to its own folder, so it never overwrites his app
//   - saves to its own projects store, because electron/main.ts gives the lab a
//     different origin and a browser engine keys storage on the origin alone
//   - keeps its own automatic backups, in its own folder beside his
//   - never auto-updates, so it stays whatever was on the bench when it was built
//
// NOT AN INSTALLER, ON PURPOSE. electron-builder's NSIS step is the slow half of
// a release and it RUNS the app when it finishes, which would put a window in
// front of him. `--dir` writes a plain folder with an exe in it, and the shortcut
// below points straight at that. Rebuilding is then just this script again: no
// uninstall, no version numbers, nothing to click.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.USERPROFILE || 'C:/Users/skyle'

// ⛔ BUILD OUTSIDE THE REPO, AND OUTSIDE HIS DESKTOP ENTIRELY.
//
// electron-builder unpacks three hundred megabytes of Electron into a temporary
// folder and then renames it into place. Inside the repo, which lives on his
// Desktop, that rename comes back EPERM every single time and the build dies
// having done all the work. Windows guards the Desktop and Documents trees
// against exactly this kind of move by a process it does not recognise, and this
// one is spawned by an agent shell. The release script has always built to this
// same place, and now the reason is written down.
const OUT = 'C:/Users/skyle/AppData/Local/olp-build/lab'
const APP_DIR = path.join(OUT, 'win-unpacked')
const EXE_NAME = 'OL Premiere Lab.exe'

// Where he can actually reach it. The build path above is redirected for the
// agent's shell, so Explorer cannot follow a shortcut into it; the finished app
// is copied here, beside his other launchers, and the shortcut points at THIS.
const VISIBLE = path.join(HOME, 'Desktop', '.launchers', 'OL Premiere Lab')
const VISIBLE_EXE = path.join(VISIBLE, EXE_NAME)
const SHORTCUT = path.join(HOME, 'Desktop', 'OL Premiere Lab.lnk')

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
    `-c.directories.output=${OUT}`,
  ])

  const built = path.join(APP_DIR, EXE_NAME)
  if (!existsSync(built)) throw new Error(`lab: expected an app at ${built} and there is none`)

  console.log('lab: copying it somewhere he can see')
  if (existsSync(VISIBLE)) rmSync(VISIBLE, { recursive: true, force: true })
  mkdirSync(path.dirname(VISIBLE), { recursive: true })
  cpSync(APP_DIR, VISIBLE, { recursive: true })
  if (!existsSync(VISIBLE_EXE)) throw new Error(`lab: the copy did not land at ${VISIBLE_EXE}`)

  console.log('lab: putting a shortcut on his Desktop')
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(SHORTCUT) + ')',
    '$s.TargetPath = ' + JSON.stringify(VISIBLE_EXE),
    '$s.WorkingDirectory = ' + JSON.stringify(VISIBLE),
    '$s.Description = "OL Premiere Lab: the bench copy. Separate projects, never auto-updates."',
    '$s.Save()',
  ].join('; ')
  await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `"${ps.replace(/"/g, '\\"')}"`])

  console.log(`lab: ready at ${VISIBLE_EXE}`)
  console.log(`lab: shortcut at ${SHORTCUT}`)
}

main().catch((err) => {
  console.error('lab: FAILED', err)
  process.exit(1)
})
