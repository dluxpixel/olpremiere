// Where what he taught the captions actually lives between sessions.
//
// His ask, 2026-08-19: *"Whenever I archive a project and I use captions in it,
// make sure it learns from my speech patterns... I want you to really save
// everything and then compare that to what the base model would do and adjust
// based off of that."*
//
// `styleLearning.ts` reads one project into a sample. `styleProfile.ts` merges
// samples into a profile. Neither of them touches a disk, which is the whole
// reason both can be tested exhaustively. This file is the small dirty half:
// it holds the samples, one per project, and hands the merge whatever it has.
//
// ⛔ KEYED BY PROJECT ID, AND THAT IS A CORRECTNESS RULE RATHER THAN TIDINESS.
// He can archive a project, pull it back out, change three captions and archive
// it again. Appending to a list would count that project twice and let one
// afternoon's habit outvote a year of his real style. Replacing by id means the
// newest reading of a project always wins and the arithmetic stays honest.

import type { StyleSample } from './styleLearning'
import { buildProfile, type StyleProfile } from './styleProfile'

const KEY = 'olpremiere:captions:style-samples'

/**
 * How many archived projects are kept.
 *
 * Enough that a habit has to survive months of his work to stay settled, small
 * enough that the whole thing is a few hundred kilobytes in a store that gets
 * about five megabytes. Oldest is dropped first.
 */
export const MAX_PROJECTS = 40

interface Stored {
  v: 1
  /** Project id → its sample, plus when it was read. */
  byProject: Record<string, { at: number; sample: StyleSample }>
}

const EMPTY: Stored = { v: 1, byProject: {} }

/**
 * The live copy. localStorage only PERSISTS this, exactly like the caption
 * language beside it: a blocked or full store costs him the learning across a
 * restart and never inside the session he is in.
 */
let cache: Stored | null = null

function read(): Stored {
  if (cache) return cache
  cache = EMPTY
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as Stored
      // A shape from a future version is ignored rather than guessed at. Losing
      // the learning is recoverable by archiving again; feeding half-understood
      // numbers into his captions is not.
      if (parsed && parsed.v === 1 && parsed.byProject) cache = parsed
    }
  } catch {
    cache = EMPTY
  }
  return cache
}

function write(next: Stored): void {
  cache = next
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Quota or private mode. The in-memory copy above still serves this session.
  }
}

/**
 * Remember what one project taught, replacing anything already held for it.
 *
 * `at` is injected so a test can order projects without waiting, and so the
 * caller can use the project's own archive time rather than the clock.
 */
export function rememberProjectStyle(projectId: string, sample: StyleSample, at: number): void {
  const cur = read()
  const byProject = { ...cur.byProject, [projectId]: { at, sample } }

  // Trim the oldest first, and only when over. Sorting newest-first and slicing
  // keeps the newest MAX_PROJECTS whatever order they arrived in.
  const ids = Object.keys(byProject).sort((a, b) => byProject[b].at - byProject[a].at)
  const kept: Stored['byProject'] = {}
  for (const id of ids.slice(0, MAX_PROJECTS)) kept[id] = byProject[id]

  write({ v: 1, byProject: kept })
}

/** Every sample held, newest first. */
export function storedSamples(): StyleSample[] {
  const cur = read()
  return Object.values(cur.byProject)
    .sort((a, b) => b.at - a.at)
    .map((e) => e.sample)
}

/**
 * His profile for one speech model, or null when he has not archived enough
 * captions made by it.
 *
 * ⛔ THE MODEL IS REQUIRED AND IS NEVER DEFAULTED. A profile built from
 * whisper-base corrections describes what base got wrong, and applying it on
 * top of small would put base's mistakes back into his video. `buildProfile`
 * drops the samples that do not match; this signature is what stops a caller
 * from forgetting to say which model it is asking about.
 */
export function learnedProfile(model: string): StyleProfile | null {
  return buildProfile(storedSamples(), model)
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetStyleStoreCache(): void {
  cache = null
}

/** Test seam and a real escape hatch: throw the learning away. */
export function clearLearnedStyle(): void {
  cache = EMPTY
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch {
    // Nothing to do: the in-memory copy is already empty.
  }
}
