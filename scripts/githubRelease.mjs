// The GitHub half of a release, written as functions that are handed their I/O
// instead of reaching for it. scripts/publish.mjs wires in the real network and
// curl; scripts/githubRelease.test.mjs wires in a fake GitHub and runs a whole
// ship against it, because a step that only runs during a real release cannot be
// checked by eye in any useful sense.
//
// ⛔ A RELEASE IS A DRAFT UNTIL EVERY FILE IS ON IT, 2026-10-04. While v3.22.0 was
// going out his app threw a wall of raw headers and a stack trace at him:
// "Cannot find latest.yml in the latest release artifacts ... HttpError: 404".
// The release had been created PUBLISHED, so GitHub was already calling it the
// latest while the 142 MB installer was still uploading, and latest.yml is the
// last file up. Every copy that checked in that window found a newest release
// with no feed on it. Ordering the uploads (latest.yml last) only narrowed the
// window, it could never close it: a published release is visible the moment it
// exists. So it is created as a DRAFT, which nothing outside this repo can see,
// and flipped to published only once every asset is listed at its real size.

import { fetchRetry } from './lib.mjs'

/**
 * An `api(path, opts)` function for GitHub's JSON API. `fetchImpl` is injectable
 * so a test can stand in for the network.
 */
export function githubApi({ token, fetchImpl = fetchRetry }) {
  return async (path, opts = {}) => {
    const res = await fetchImpl('https://api.github.com' + path, {
      ...opts,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    })
    const text = await res.text()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // A proxy error page is not JSON. Keep its words rather than a SyntaxError.
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${body.message || text}`)
    return body
  }
}

/** Is this asset on the release, finished, and exactly as big as the file we sent? */
const isComplete = (a, want) => a.name === want.name && a.state === 'uploaded' && a.size === want.bytes

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
 *
 * `postAsset({ releaseId, name, file, type })` does the raw POST and throws when
 * it fails. Its error's `status` is the curl exit code, which is only logged.
 */
export async function uploadAsset({ api, repoPath, releaseId, asset, postAsset, log = console.log, tries = 3 }) {
  const { name, file, type, bytes } = asset
  for (let attempt = 1; attempt <= tries; attempt++) {
    let curlExit = 0
    try {
      await postAsset({ releaseId, name, file, type })
    } catch (e) {
      curlExit = e?.status ?? 1
    }

    const landed = (await api(`${repoPath}/releases/${releaseId}/assets?per_page=100`)).find((a) => a.name === name)
    if (landed && isComplete(landed, asset)) {
      if (curlExit) log(`  ${name}: curl exited ${curlExit}, but GitHub has it complete. Believing GitHub.`)
      return
    }
    // Half an asset, or one whose size disagrees, is worse than none: the updater
    // would download it and fail a hash check. Clear it before trying again.
    if (landed) {
      log(`  ${name}: on the release but ${landed.state} at ${landed.size}/${bytes} bytes, removing and retrying`)
      await api(`${repoPath}/releases/assets/${landed.id}`, { method: 'DELETE' }).catch(() => {})
    }
    if (attempt < tries) log(`  ${name}: attempt ${attempt} did not land, retrying`)
  }
  throw new Error(`${name} did not upload after ${tries} attempts`)
}

/**
 * Publish `tag` with `assets`, in the one order that is safe.
 *
 *   1. clear any earlier release and tag for this version (a re-run replaces it)
 *   2. tag main through the API, and in the local clone
 *   3. create the release as a DRAFT
 *   4. upload every asset, latest.yml last
 *   5. ask GitHub what is on the draft and check each file at its real size
 *   6. only then flip it to published, and check it really is
 *
 * ⛔ ANYTHING THAT GOES WRONG BEFORE STEP 6 LEAVES A DRAFT AND THROWS. A draft is
 * invisible to the updater, so a failed ship costs him nothing and the repair is
 * the same command again: step 1 clears the leftover and starts clean. It does
 * not resume the leftover on purpose, because a rebuilt installer of the same
 * size would pass a size check while latest.yml carries the new hash.
 *
 * `assets` is `[{ name, file, type, bytes }]`, in upload order. `tagLocal(tag)`
 * writes the tag into his clone and may throw. Returns the published release.
 */
export async function publishRelease({
  api,
  repoPath,
  tag,
  assets,
  postAsset,
  tagLocal,
  log = console.log,
  warn = console.warn,
  uploadTries = 3,
}) {
  // --- clean any prior release + tag for this version ---
  // Drafts are listed for a token with push access, and a failed ship leaves one,
  // so every release carrying this tag goes, not just the first.
  const earlier = (await api(`${repoPath}/releases?per_page=100`)).filter((r) => r.tag_name === tag)
  for (const r of earlier) {
    log(`• Replacing existing ${tag} (id ${r.id}${r.draft ? ', a draft an earlier run left' : ''})`)
    await api(`${repoPath}/releases/${r.id}`, { method: 'DELETE' })
  }
  await api(`${repoPath}/git/refs/tags/${tag}`, { method: 'DELETE' }).catch(() => {})

  // --- create the tag on main ---
  const main = await api(`${repoPath}/git/ref/heads/main`)
  await api(`${repoPath}/git/refs`, {
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
  // Best effort: a clone that will not take the tag must not fail a release.
  try {
    tagLocal(tag)
  } catch {
    warn(`could not write the local tag ${tag}; git describe will lag until it is fetched`)
  }

  // --- a DRAFT release, and no `make_latest`: a draft cannot be the latest ---
  const rel = await api(`${repoPath}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: `OL Premiere ${tag}`, draft: true, prerelease: false }),
  })
  const releaseId = rel.id
  // If GitHub ever hands back a PUBLISHED release here, the window this whole file
  // exists to close is already open. Stop before a 142 MB upload into it.
  if (rel.draft !== true) {
    throw new Error(`${tag} was created PUBLISHED instead of as a draft (id ${releaseId}). Nothing was uploaded.`)
  }

  const stillADraft = (e) => {
    const err = new Error(
      `${tag} was NOT published and is still a draft, so no installed app can see it. ${e.message}\n` +
        `   Run the same command again: it clears the draft and starts clean.`,
    )
    err.cause = e
    return err
  }

  try {
    // ⛔ latest.yml goes LAST on purpose. It is the file the updater reads. On a
    // draft the order no longer decides what anyone sees, but it still means a
    // run that dies part way never has a feed without its installer.
    log('• Uploading installer (this is the big one)…')
    for (const asset of assets) {
      await uploadAsset({ api, repoPath, releaseId, asset, postAsset, log, tries: uploadTries })
    }

    // Ask GitHub what is on the draft: every file there, finished, at its real
    // size, and nothing else.
    const onDraft = await api(`${repoPath}/releases/${releaseId}/assets?per_page=100`)
    const bad = assets.filter((want) => !onDraft.some((a) => isComplete(a, want)))
    if (bad.length) throw new Error(`missing or the wrong size on the draft: ${bad.map((a) => a.name).join(', ')}`)
    if (onDraft.length !== assets.length) {
      throw new Error(`expected ${assets.length} assets on ${tag}, found ${onDraft.length}: ${onDraft.map((a) => a.name).join(', ')}`)
    }
    log(`• Draft ${tag} holds all ${onDraft.length} assets at the right size: ${onDraft.map((a) => a.name).join(', ')}`)

    // --- every file is there: NOW it goes live ---
    log(`• Publishing ${tag}…`)
    try {
      await api(`${repoPath}/releases/${releaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }),
      })
    } catch (e) {
      // ⛔ A LOST ANSWER IS NOT A REFUSAL. GitHub can apply the publish and the
      // connection die before its answer arrives. "NOT published, run it again" would
      // then be false, and running it again deletes a release that is live. So ask.
      const now = await api(`${repoPath}/releases/${releaseId}`).catch(() => null)
      if (!now) {
        const err = new Error(
          `${tag} MAY ALREADY BE PUBLISHED: the publish call failed (${e.message}) and GitHub could not be asked afterwards.\n` +
            `   Look at the release on GitHub before running anything again: a new run replaces it.`,
        )
        err.cause = e
        err.publishUnknown = true
        throw err
      }
      if (now.draft !== false) throw e
      warn(`• The publish call failed (${e.message}), but GitHub shows ${tag} published. Checking it.`)
    }
  } catch (e) {
    throw e.publishUnknown ? e : stillADraft(e)
  }

  // --- verify it really is out ---
  const check = await api(`${repoPath}/releases/${releaseId}`)
  const names = (check.assets ?? []).map((a) => a.name)
  log('• Assets:', names.join(', '))
  if (check.draft) throw new Error(`${tag} is still a draft after the publish call, so installed apps cannot see it`)
  const missing = assets.filter((a) => !names.includes(a.name))
  if (missing.length) throw new Error(`${tag} is published but is missing ${missing.map((a) => a.name).join(', ')}`)
  log(`\n✅ Published ${tag} (draft=${check.draft}). Installed apps will auto-update.`)
  return check
}
