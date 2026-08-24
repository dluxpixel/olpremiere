// Robust GitHub-release publisher for a build that already exists in OUT.
// Generates latest.yml ourselves (so it always matches the real asset + hash),
// creates the tag + a PUBLISHED release, and uploads the installer + latest.yml
// + blockmap via curl (reliable for the ~242MB binary). Idempotent: re-running a
// version replaces its release cleanly. Used by scripts/release.mjs after the build.

import { execSync, execFileSync } from 'node:child_process'
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
/**
 * Upload one asset, and ⛔ ASK GITHUB WHETHER IT ARRIVED RATHER THAN ASKING CURL.
 *
 * MEASURED 2026-08-13, and this cost two failed ships in a row. On this machine
 * the 243 MB installer reaches GitHub and is stored COMPLETE, and then the client
 * connection is aborted before curl reads the response. curl exits 55 (send
 * error) or 6, the old code took that as failure, and the release was published
 * with ZERO assets while the file was actually sitting on it.
 *
 * ⛔⛔ AND THAT IS WHY THE REPAIR COULD NEVER WORK. The retry re-posted an asset
 * that was already there, GitHub answered 422 `already_exists`, `-f` turned that
 * into another non-zero exit, and `npm run release` failed forever on a release
 * that was one API call from being finished. Running it again could not help. Any
 * fix that only makes the upload more reliable would have left that trap in
 * place, because the trap is believing the wrong witness.
 *
 * So: attempt, then ask the API what is actually on the release. A complete asset
 * of the right size IS success no matter what curl said. A partial or duplicate
 * one is deleted and re-attempted, which is also what makes a re-run of an
 * interrupted ship idempotent.
 */
const assetList = () => api(`/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?per_page=100`)

const upload = async (name, file, type) => {
  const bytes = statSync(file).size
  for (let attempt = 1; attempt <= 3; attempt++) {
    let curlExit = 0
    try {
      // No -f: a 422 is information, not a crash. No --retry either, because a
      // blind retry is what produced the duplicate that then wedged the repair.
      execSync(
        `curl -sS -X POST -H "Authorization: token ${token}" ` +
          `-H "Content-Type: ${type}" --data-binary @"${file}" ` +
          `"https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}"`,
        { stdio: 'pipe' },
      )
    } catch (e) {
      curlExit = e.status ?? 1
    }

    const landed = (await assetList()).find((a) => a.name === name)
    if (landed && landed.state === 'uploaded' && landed.size === bytes) {
      if (curlExit) console.log(`  ${name}: curl exited ${curlExit}, but GitHub has it complete. Believing GitHub.`)
      return
    }
    // Half an asset, or one whose size disagrees, is worse than none: the updater
    // would download it and fail a hash check. Clear it before trying again.
    if (landed) {
      console.log(`  ${name}: on the release but ${landed.state} at ${landed.size}/${bytes} bytes, removing and retrying`)
      await api(`/repos/${OWNER}/${REPO}/releases/assets/${landed.id}`, { method: 'DELETE' }).catch(() => {})
    }
    if (attempt < 3) console.log(`  ${name}: attempt ${attempt} did not land, retrying`)
  }
  throw new Error(`${name} did not upload after 3 attempts`)
}

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
// ⛔ AND WRITE THE TAG LOCALLY TOO, or `git describe` never learns it happened.
//
// The tag above is minted through the API, so nothing ever landed in his clone.
// `previousTag()` in release.mjs reads LOCAL tags only, so it kept answering
// v2.0.18 while package.json said 2.36.0, `isBigUpdate` was therefore true on
// every single release since 2.2.0, and the packaged-app smoke test opened a
// real OL Premiere window over whatever he was doing, every time. The branch
// that prints "no window on his screen" had never once run. The same stale
// answer made `patch.mjs`'s "Nothing to release" exit unreachable, so a stray
// `npm run patch` always went through to a full bump and publish.
//
// Best effort: a clone that will not take the tag must not fail a release that
// has already been published.
try {
  execFileSync('git', ['tag', '-f', tag], { stdio: 'ignore' })
} catch {
  console.warn(`could not write the local tag ${tag}; git describe will lag until it is fetched`)
}

const rel = await api(`/repos/${OWNER}/${REPO}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, name: `OL Premiere ${tag}`, draft: false, prerelease: false, make_latest: 'true' }),
})
const releaseId = rel.id

// --- upload the three assets ---
// ⛔ latest.yml goes LAST on purpose. It is the file the updater reads, so if a
// run dies part way the feed is simply absent and no installed copy is told
// about a version whose installer is not there yet.
console.log('• Uploading installer (this is the big one)…')
await upload(exeName, exePath, 'application/octet-stream')
await upload(blockName, blockPath, 'application/octet-stream')
await upload('latest.yml', feedPath, 'text/yaml')

const final = await assetList()
console.log(`✅ ${tag} published with ${final.length} assets: ${final.map((a) => a.name).join(', ')}`)
if (final.length !== 3) throw new Error(`expected 3 assets on ${tag}, found ${final.length}`)

// --- verify ---
const check = await api(`/repos/${OWNER}/${REPO}/releases/${releaseId}`)
const names = check.assets.map((a) => a.name)
const ok = names.includes(exeName) && names.includes('latest.yml') && names.includes(blockName)
console.log('• Assets:', names.join(', '))
if (!ok) throw new Error('missing assets after upload')
console.log(`\n✅ Published ${tag} (draft=${check.draft}). Installed apps will auto-update.`)
console.log(`   https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
