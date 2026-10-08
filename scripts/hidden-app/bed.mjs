// Is a bed (the folder run.mjs --bed opens the app on) really a copy?
//
// ⛔ BY WHERE IT LEADS, NOT BY HOW ITS PATH IS SPELLED. The app writes and deletes in
// the bed's media folder (temps it sweeps, a deleted project's footage), and run.mjs
// links that folder in as the app's own. The first guard compared path strings, so a
// bed whose `media` was itself a link to his real media folder passed it, and a run
// would have worked on his real footage. Both the bed and its media are followed to
// where they really are first.
//
// ⛔ AND HIS MEDIA FOLDER IS FOLLOWED TOO, 2026-10-08. It can itself be a link to
// another drive, and then a bed linked to where it leads is outside his profile by
// path and still his real footage. So the guarded places are each profile and each
// profile's media folder, every one where it really leads.

import { realpathSync } from 'node:fs'
import path from 'node:path'

/** His profiles, the folders a bed must never be or lead into. */
export function realProfiles(appData) {
  return ['OL Premiere', 'reel'].map((name) => path.join(appData, name))
}

/** True when `target` is `dir` or anything inside it, on a case-insensitive Windows path. */
function inside(dir, target) {
  const rel = path.relative(dir.toLowerCase(), target.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Where a path really leads (links and junctions followed), or the path as given when it is not there. */
function leadsTo(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** Why this bed must not be used, or null when it is a copy. */
export function bedProblem(bed, appData) {
  const guarded = realProfiles(appData).flatMap((profile) => [
    { where: 'his real OL Premiere folder', real: leadsTo(profile) },
    { where: 'his real media folder', real: leadsTo(path.join(profile, 'media')) },
  ])
  for (const [what, p] of [['the bed', bed], ['the bed\'s media', path.join(bed, 'media')]]) {
    const real = leadsTo(p)
    const hit = guarded.find((g) => inside(g.real, real))
    if (hit) return `${what} leads into ${hit.where} (${real}): a bed must be a COPY`
  }
  return null
}
