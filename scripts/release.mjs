// One-command release: build the desktop app, then publish it to GitHub Releases
// (via scripts/publish.mjs, which generates latest.yml + uploads reliably). Every
// installed copy then auto-updates. Usage:
//   1. bump the version:  npm version patch --no-git-tag-version
//   2. ship it:           GH_TOKEN=<token> npm run release
// Or in one go:           GH_TOKEN=<token> npm run release:patch
// (Claude runs this when you say "ship it".)

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { loadToken } from './lib.mjs'

const OUT = process.env.OLP_OUT || 'C:/Users/skyle/AppData/Local/olp-build/release'
const token = loadToken()
if (!token) {
  console.error('❌ No GitHub token. Put GH_TOKEN=... in a gitignored .env.release (copy .env.release.example), or set $GH_TOKEN.')
  process.exit(1)
}
process.env.GH_TOKEN = token // so the build/publish subprocesses inherit it
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
console.log(`\n▶ Releasing OL Premiere v${version}\n`)

// Build the installer + blockmap (no electron-builder publish — publish.mjs owns
// the upload so a transient network blip can't leave a half-published release).
execSync('npm run build:electron', { stdio: 'inherit', env: process.env })
execSync(`npx electron-builder --win --publish never -c.directories.output=${OUT}`, { stdio: 'inherit', env: process.env })

// Generate latest.yml + create the tag + published release + upload all assets.
execSync('node scripts/publish.mjs', { stdio: 'inherit', env: process.env })
