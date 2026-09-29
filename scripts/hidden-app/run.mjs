// Drive the REAL desktop app with no window on his screen.
//
//   npm run build:electron
//   node scripts/hidden-app/run.mjs scripts/hidden-app/checks/title-export.cjs
//
// Options:
//   --seed-font <file>   put a trimmed Apple emoji font where the app keeps it,
//                        so a check does not wait on the one-time download
//   --timeout <ms>       give up after this long (default 300000)
//   --keep               keep the throwaway folder and print where it is
//
// ⛔ What it never does: open a window on his screen, read or write his real
// profile, projects or media, or touch his clipboard (drive pastes with a
// synthetic paste event, never navigator.clipboard: Electron's clipboard IS his).

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const keep = args.includes('--keep') ? (args.splice(args.indexOf('--keep'), 1), true) : false
const seedFont = flag('--seed-font')
const timeout = Number(flag('--timeout') ?? 300000)
const check = args[0] ? path.resolve(args[0]) : undefined
if (!check || !existsSync(check)) {
  console.error('usage: node scripts/hidden-app/run.mjs <check.cjs> [--seed-font file] [--timeout ms] [--keep]')
  process.exit(2)
}
if (!existsSync(path.join(repo, 'out', 'main', 'main.js'))) {
  console.error('no built app: run `npm run build:electron` first')
  process.exit(2)
}

const root = mkdtempSync(path.join(tmpdir(), 'olp-hidden-'))
if (seedFont) {
  mkdirSync(path.join(root, 'userData', 'fonts'), { recursive: true })
  // The app keeps its copy named after the source it came from (electron/emojiFont.ts).
  const pin = /sha256: '([0-9a-f]{64})'/.exec(readFileSync(path.join(repo, 'electron', 'emojiFont.ts'), 'utf8'))
  if (!pin) throw new Error('no emoji source pin in electron/emojiFont.ts')
  copyFileSync(seedFont, path.join(root, 'userData', 'fonts', `apple-emoji-${pin[1].slice(0, 12)}.ttf`))
}
const electron = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const run = spawnSync(electron, [path.join(here, 'app'), `--user-data-dir=${path.join(root, 'userData')}`], {
  env: { ...process.env, OLP_HIDDEN_DIR: root, OLP_HIDDEN_CHECK: check, OLP_HIDDEN_TIMEOUT_MS: String(timeout) },
  stdio: 'ignore',
  windowsHide: true,
  timeout: timeout + 30000,
})
const resultFile = path.join(root, 'result.json')
const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { ok: false, error: `no result (exit ${run.status})` }
const logFile = path.join(root, 'log.txt')
if (existsSync(logFile)) {
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('loaded '))
  if (lines.length) console.log(lines.join('\n'))
}
console.log(JSON.stringify(result, null, 1))
if (keep) console.log(`kept: ${root}`)
else rmSync(root, { recursive: true, force: true })
process.exit(result.ok ? 0 : 1)
