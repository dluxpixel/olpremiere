// Build the LAB copy of OL Premiere: a second app that shares nothing with his.
//
// His ask, 2026-08-19: "Can you work on a separate version of the OL Premiere so
// I can work on edits while you work on making the program better?"
//
// So this produces "OL Premiere Lab", which:
//   - installs to its own folder, so it never overwrites his app
//   - saves to its own projects store, because electron/main.ts gives the lab a
//     different origin and a browser engine keys storage on the origin alone
//   - never auto-updates, so it stays whatever was on the bench when it was built
//
// ⛔ NOT AN INSTALLER, ON PURPOSE. electron-builder's NSIS step is the slow half
// of a release and it RUNS the app when it finishes, which would put a window in
// front of him. `--dir` writes a plain folder with an exe in it, and the
// shortcut below points straight at that. Rebuilding is then just this script
// again: no uninstall, no version numbers, nothing to click.
//
// The shortcut lands on his Desktop rather than anywhere under AppData, because
// this machine's AppData is redirected for the agent's shell and a shortcut
// written there is invisible in Explorer.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'release-lab')
const APP_DIR = path.join(OUT, 'win-unpacked')
const EXE = path.join(APP_DIR, 'OL Premiere Lab.exe')
const SHORTCUT = path.join(process.env.USERPROFILE ?? 'C:\\Users\\skyle', 'Desktop', 'OL Premiere Lab.lnk')

/** Run a command, inheriting stdio, and reject on a non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts })
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
    // The name decides everything downstream: the install folder, the saved
    // projects folder, and (through app.getName in electron/main.ts) the origin
    // and the no-auto-update guard.
    '-c.productName=OL Premiere Lab',
    '-c.extraMetadata.productName=OL Premiere Lab',
    '-c.extraMetadata.name=ol-premiere-lab',
    '-c.appId=com.olpremiere.lab',
    `-c.directories.output=${OUT.replace(/\\/g, '/')}`,
  ])

  if (!existsSync(EXE)) throw new Error(`lab: expected an app at ${EXE} and there is none`)

  console.log('lab: putting a shortcut on his Desktop')
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(SHORTCUT) + ')',
    '$s.TargetPath = ' + JSON.stringify(EXE),
    '$s.WorkingDirectory = ' + JSON.stringify(APP_DIR),
    '$s.Description = "OL Premiere Lab: the bench copy. Separate projects, never auto-updates."',
    '$s.Save()',
  ].join('; ')
  await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `"${ps.replace(/"/g, '\\"')}"`])

  console.log(`lab: ready at ${EXE}`)
  console.log(`lab: shortcut at ${SHORTCUT}`)
}

main().catch((err) => {
  console.error('lab: FAILED', err)
  process.exit(1)
})
