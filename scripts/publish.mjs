// Robust GitHub-release publisher for a build that already exists in OUT.
// Generates latest.yml ourselves (so it always matches the real asset + hash),
// creates the tag + a DRAFT release, uploads the installer + blockmap + latest.yml
// via curl (reliable for the ~242MB binary), checks every file is on the draft at
// its real size, and only THEN publishes it. Idempotent: re-running a version
// replaces its release cleanly. Used by scripts/release.mjs after the build.
// The ordering and its reason live in scripts/githubRelease.mjs, where a test
// runs it against a fake GitHub.

import { execSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash as hash } from 'node:crypto'
import { loadToken } from './lib.mjs'
import { githubApi, publishRelease } from './githubRelease.mjs'

// Must match electron-builder.yml's publish.owner/repo. The updater reads the
// feed from THERE, so a mismatch here uploads a release to a repo nothing ever
// checks. It reports success and no one can see it. Change both or neither.
const OWNER = 'dluxpixel'
const REPO = 'olpremiere'
const OUT = process.env.OLP_OUT || 'C:/Users/skyle/AppData/Local/olp-build/release'
const token = loadToken()
if (!token) {
  console.error('❌ No GitHub token. Put GH_TOKEN=... in a gitignored .env.release, or set $GH_TOKEN.')
  process.exit(1)
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = 'v' + version
const exeName = `OL-Premiere-${version}-setup.exe`
const exePath = `${OUT}/${exeName}`
const blockName = `${exeName}.blockmap`
const blockPath = `${OUT}/${blockName}`
const feedPath = `${OUT}/latest.yml`

// --- sha512 (base64) of the installer ---
const sha512 = hash('sha512').update(readFileSync(exePath)).digest('base64')
const size = statSync(exePath).size

// --- generate latest.yml matching THIS build exactly ---
const latestYml = `version: ${version}
files:
  - url: ${exeName}
    sha512: ${sha512}
    size: ${size}
path: ${exeName}
sha512: ${sha512}
releaseDate: '${process.env.OLP_RELEASE_DATE || new Date().toISOString()}'
`
writeFileSync(feedPath, latestYml)
console.log(`• latest.yml -> ${exeName} (${(size / 1e6).toFixed(0)} MB)`)

// The raw upload. No -f: a 422 is information, not a crash. No --retry either,
// because a blind retry is what produced the duplicate that then wedged the
// repair. uploadAsset asks GitHub what landed, so this only has to try.
const postAsset = ({ releaseId, name, file, type }) => {
  execSync(
    `curl -sS -X POST -H "Authorization: token ${token}" ` +
      `-H "Content-Type: ${type}" --data-binary @"${file}" ` +
      `"https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}"`,
    { stdio: 'pipe' },
  )
}

// ⛔ latest.yml goes LAST, and the installer first. See publishRelease.
const assets = [
  { name: exeName, file: exePath, type: 'application/octet-stream', bytes: size },
  { name: blockName, file: blockPath, type: 'application/octet-stream', bytes: statSync(blockPath).size },
  { name: 'latest.yml', file: feedPath, type: 'text/yaml', bytes: statSync(feedPath).size },
]

await publishRelease({
  api: githubApi({ token }),
  repoPath: `/repos/${OWNER}/${REPO}`,
  tag,
  assets,
  postAsset,
  tagLocal: (t) => execFileSync('git', ['tag', '-f', t], { stdio: 'ignore' }),
})
console.log(`   https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
