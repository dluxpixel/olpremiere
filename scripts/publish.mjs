// Robust GitHub-release publisher for a build that already exists in OUT.
// Generates latest.yml ourselves (so it always matches the real asset + hash),
// creates the tag + a PUBLISHED release, and uploads the installer + latest.yml
// + blockmap via curl (reliable for the ~242MB binary). Idempotent: re-running a
// version replaces its release cleanly. Used by scripts/release.mjs after the build.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash as hash } from 'node:crypto'
import { loadToken, fetchRetry } from './lib.mjs'

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

// --- GitHub API helpers ---
const api = async (path, opts = {}) => {
  const res = await fetchRetry('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : {}
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${body.message || text}`)
  return body
}
// curl handles the large binary reliably; -f fails on non-2xx, --retry rides out
// the transient network blips (ENOTFOUND / connection reset) seen in this env.
const upload = (name, file, type) =>
  execSync(
    `curl -sf --retry 5 --retry-all-errors --retry-connrefused -X POST -H "Authorization: token ${token}" ` +
      `-H "Content-Type: ${type}" --data-binary @"${file}" ` +
      `"https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}"`,
    { stdio: 'pipe' },
  )

// --- clean any prior release + tag for this version ---
const existing = (await api(`/repos/${OWNER}/${REPO}/releases`)).find((r) => r.tag_name === tag)
if (existing) {
  console.log(`• Replacing existing ${tag} (id ${existing.id})`)
  await api(`/repos/${OWNER}/${REPO}/releases/${existing.id}`, { method: 'DELETE' })
}
await api(`/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`, { method: 'DELETE' }).catch(() => {})

// --- create the tag on main, then a PUBLISHED release ---
const main = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/main`)
await api(`/repos/${OWNER}/${REPO}/git/refs`, {
  method: 'POST',
  body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: main.object.sha }),
})
const rel = await api(`/repos/${OWNER}/${REPO}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, name: `OL Premiere ${tag}`, draft: false, prerelease: false, make_latest: 'true' }),
})
const releaseId = rel.id

// --- upload the three assets ---
console.log('• Uploading installer (this is the big one)…')
upload(exeName, exePath, 'application/octet-stream')
upload('latest.yml', feedPath, 'text/yaml')
upload(blockName, blockPath, 'application/octet-stream')

// --- verify ---
const check = await api(`/repos/${OWNER}/${REPO}/releases/${releaseId}`)
const names = check.assets.map((a) => a.name)
const ok = names.includes(exeName) && names.includes('latest.yml') && names.includes(blockName)
console.log('• Assets:', names.join(', '))
if (!ok) throw new Error('missing assets after upload')
console.log(`\n✅ Published ${tag} (draft=${check.draft}). Installed apps will auto-update.`)
console.log(`   https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
