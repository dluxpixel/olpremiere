// Is a bed (the folder run.mjs --bed opens the app on) really a copy?
//
// ⛔ BY WHERE IT LEADS, NOT BY HOW ITS PATH IS SPELLED. The app writes and deletes in
// the bed's media folder (temps it sweeps, a deleted project's footage), and run.mjs
// links that folder in as the app's own. The first guard compared path strings, so a
// bed whose `media` was itself a link to his real media folder passed it, and a run
// would have worked on his real footage. Both the bed and its media are followed to
// where they really are first.

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
  const profiles = realProfiles(appData).map(leadsTo)
  for (const [what, p] of [['the bed', bed], ['the bed\'s media', path.join(bed, 'media')]]) {
    const real = leadsTo(p)
    if (profiles.some((profile) => inside(profile, real))) {
      return `${what} leads into his real OL Premiere folder (${real}): a bed must be a COPY`
    }
  }
  return null
}
