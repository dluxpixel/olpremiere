// What an update check that failed MEANS, and the one sentence he is told about it.
// Pure, so it can be tested without an Electron window and read by the renderer too.
//
// ⛔ A MISSING latest.yml IS A RELEASE STILL BEING PUBLISHED, NOT A FAILURE, 2026-10-04.
// While v3.22.0 went out his app threw this at him: "Update check failed. You may not
// be on the newest version. Cannot find latest.yml in the latest release artifacts
// (https://github.com/.../latest.yml): HttpError: 404", then the raw response headers
// and a stack trace. GitHub already showed the release while the installer was still
// uploading, and latest.yml is the last file up. Nothing was wrong with his app or his
// network, and nothing he could do would help: a minute later the same check answers.
// (scripts/githubRelease.mjs now keeps a release a draft until every file is on it, so
// this window should not open again. This is the half that stays quiet if it does, for
// a release published by any other route.)
//
// The rule has two halves and they pull against each other. The 2026-08 scar was a dead
// feed (an unreachable repo, a 404 on latest.yml) that hid for WEEKS because the
// failure was swallowed, so a quiet 404 must not be able to stay quiet forever. It is
// quiet for as long as a release upload plausibly takes and then it is an ordinary,
// visible failure.
//
// ⛔ A 404 IS NOT ALWAYS "STILL PUBLISHING", 2026-10-06. Under the draft first flow a
// release is invisible until every file is on it, so only two 404s can still mean an
// upload in progress: latest.yml missing from a release that is already listed
// (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND), and a file under /releases/download/. A 404 on
// the releases feed itself (releases.atom) or on /releases/latest is a repo that is
// private, renamed or deleted, or has no release at all: a dead feed, the August scar.
// Those were being called "publishing" too, so every launch said "An update is on its
// way" and the truth came out about 45 minutes in, or never in a shorter session. They
// are `missing` now and said at once.
//
// And the quiet hour is kept by the wall clock across launches (`quietSince`, stored by
// main), not by a count that started again at zero every time he opened the app.
//
// ⛔ NOTHING RAW REACHES HIM. The message that comes out of here is one of five fixed
// sentences. The text electron-updater built (URLs, headers, a stack) goes to the log.

/** What kind of failure an update check was. */
export type UpdateFailure = 'publishing' | 'missing' | 'offline' | 'denied' | 'other'

/** Every kind, in one place, so the list of sentences cannot miss one. */
export const UPDATE_FAILURES: readonly UpdateFailure[] = ['publishing', 'missing', 'offline', 'denied', 'other']

/** Error codes (node's, and the updater's own) that mean the network was not there. */
const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EPIPE',
])

/** Chromium's network errors, which is what the updater's net stack reports. */
const OFFLINE_TEXT =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|socket hang up/i

/** The HTTP status buried in an error, from wherever the updater put it. */
function statusOf(e: { statusCode?: unknown; code?: unknown }, text: string): number | null {
  if (typeof e.statusCode === 'number') return e.statusCode
  const fromCode = typeof e.code === 'string' ? /^HTTP_ERROR_(\d{3})$/.exec(e.code) : null
  if (fromCode) return Number(fromCode[1])
  // HttpError's own message, and the download path's "Cannot download ..., status 404".
  const fromText = /HttpError:\s*(\d{3})\b/.exec(text) ?? /\bstatus (\d{3})\b/.exec(text)
  return fromText ? Number(fromText[1]) : null
}

/** The whole message of whatever was thrown, which may not be an Error at all. */
export function updateErrorText(raw: unknown): string {
  if (raw instanceof Error) return raw.stack || raw.message
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw) ?? String(raw)
  } catch {
    return String(raw)
  }
}

/**
 * Which kind of failure this was. electron-updater's own error code decides first,
 * because it is exact; the words are only a fallback for a shape it did not code.
 */
export function classifyUpdateError(raw: unknown): UpdateFailure {
  const e = (typeof raw === 'object' && raw !== null ? raw : {}) as { statusCode?: unknown; code?: unknown }
  const text = updateErrorText(raw)
  const code = typeof e.code === 'string' ? e.code : ''
  const status = statusOf(e, text)

  // The release is listed and its feed file is not there (yet), or its installer is not.
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'publishing'
  if (/Cannot find \S+ in the latest release artifacts/.test(text)) return 'publishing'
  // Not when the 404 came from reading the feed: that error carries the whole feed
  // with it, and his release notes may well link a download.
  const feedStage = code === 'ERR_UPDATER_INVALID_RELEASE_FEED' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
  if (status === 404 && !feedStage && /\/releases\/download\//.test(text)) return 'publishing'

  if (status === 401 || status === 403) return 'denied'
  if (OFFLINE_CODES.has(code) || OFFLINE_TEXT.test(text)) return 'offline'
  // Any other 404 is the feed itself: releases.atom or /releases/latest. And a feed
  // with nothing in it is the same dead end. See the note at the top.
  if (status === 404) return 'missing'
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || /No published versions on GitHub/.test(text)) return 'missing'
  return 'other'
}

/**
 * The one plain sentence for each kind. ⛔ These are the ONLY words the toast can
 * carry (see `isKnownUpdateMessage`), so a URL, a header or a stack trace has no way
 * in. No colon, no detail: the detail is in the log.
 */
export function updateFailureMessage(kind: UpdateFailure): string {
  switch (kind) {
    case 'offline':
      return 'Could not check for updates because you seem to be offline.'
    case 'denied':
      return 'Could not check for updates because the update server refused the request.'
    case 'publishing':
      return 'The newest update could not be found, so you may not be on the newest version.'
    case 'missing':
      return 'Could not find the updates, so you may not be on the newest version.'
    case 'other':
      return 'Could not check for updates, so you may not be on the newest version.'
  }
}

const KNOWN_MESSAGES: ReadonlySet<string> = new Set(UPDATE_FAILURES.map(updateFailureMessage))

/**
 * Is this one of the sentences above and nothing else? The renderer asks before it
 * puts anything in a toast, so a future path that sends the updater's raw text
 * cannot put headers on his screen again.
 */
export function isKnownUpdateMessage(message: string): boolean {
  return KNOWN_MESSAGES.has(message)
}

/**
 * Check again this soon after a "release still publishing" answer, one wait per
 * consecutive answer. A 142 MB upload takes a few minutes, so a first look after two
 * is usually the last one needed. After the list runs out the ordinary fifteen
 * minute poll carries on.
 */
export const PUBLISHING_RETRY_MS: readonly number[] = [2 * 60_000, 4 * 60_000, 8 * 60_000]

/**
 * How long "release still publishing" answers stay quiet, by the clock, from the first
 * one. An hour is far longer than any upload. A 404 that outlasts it is a dead feed,
 * and a dead feed is what hid for weeks, so from then on it is said out loud, on the
 * very first answer of a new launch too.
 */
export const PUBLISHING_QUIET_MS = 60 * 60_000

/**
 * ⛔ A QUIET RUN THAT HAS HEARD NOTHING FOR THIS LONG IS OVER, 2026-10-08. Its start is
 * kept across launches and cleared only by a later answer, so an app closed inside the
 * two minute recheck left it on disk. Days later the first "still publishing" answer
 * of a launch, a real release minutes into its upload, was said out loud at once,
 * because the run looked days old. A run nobody heard for a day ended unseen, and the
 * next answer starts a new one. A day and not an hour, so a release that stays half
 * published is still said on the first answer of the next day's launch.
 */
export const PUBLISHING_RUN_GAP_MS = 24 * 60 * 60_000

/** Where the run of quiet answers stands, carried from one failed check to the next. */
export interface QuietRun {
  /** "Still publishing" answers in a row in this session, which picks the next wait. */
  streak: number
  /** When the run of quiet answers began (ms since 1970), kept across launches, or null. */
  quietSince: number | null
  /**
   * When the last quiet answer of that run came, kept with it. Missing or null for a
   * run kept by an older version, whose start then stands in.
   */
  quietLast?: number | null
  /** The time now, in ms since 1970. */
  now: number
}

export interface UpdateErrorPlan {
  kind: UpdateFailure
  /** The one sentence to tell him, or null when the right thing is to say nothing. */
  message: string | null
  /** The streak of "still publishing" answers to hand back in next time. */
  streak: number
  /** When the quiet run began, to keep for next time; null ends it. */
  quietSince: number | null
  /** Look again this many ms from now, or null to leave it to the ordinary poll. */
  retryInMs: number | null
}

/**
 * What to do about a failed check, given the run of "still publishing" answers just
 * before it. Anything that is not a release mid upload ends the run and gets its
 * sentence.
 */
export function planUpdateError(raw: unknown, run: QuietRun): UpdateErrorPlan {
  const kind = classifyUpdateError(raw)
  if (kind !== 'publishing') return { kind, message: updateFailureMessage(kind), streak: 0, quietSince: null, retryInMs: null }
  // A start in the future is a clock that moved back, and a run that heard nothing for
  // a day ended unseen (PUBLISHING_RUN_GAP_MS): either way the hour begins again from now.
  const last = run.quietLast ?? run.quietSince
  const goesOn = run.quietSince !== null && run.quietSince <= run.now && last !== null && run.now - last < PUBLISHING_RUN_GAP_MS
  const since = goesOn && run.quietSince !== null ? run.quietSince : run.now
  const next = run.streak + 1
  if (run.now - since >= PUBLISHING_QUIET_MS) {
    return { kind, message: updateFailureMessage(kind), streak: next, quietSince: since, retryInMs: null }
  }
  return { kind, message: null, streak: next, quietSince: since, retryInMs: PUBLISHING_RETRY_MS[run.streak] ?? null }
}

/** Longest the log keeps of one failure. A stack is enough, a whole page is not. */
const LOG_ENTRY_CHARS = 4000

/**
 * One entry for the update log: when, what it was judged to be, and everything the
 * updater said, URLs and headers included. This is where the detail goes now that the
 * toast no longer carries it.
 */
export function updateLogEntry(at: Date, plan: Pick<UpdateErrorPlan, 'kind' | 'message' | 'retryInMs'>, raw: unknown): string {
  const verdict =
    plan.message === null
      ? `quiet, a release still publishing${plan.retryInMs === null ? '' : `, checking again in ${Math.round(plan.retryInMs / 1000)}s`}`
      : 'shown to him'
  return `${at.toISOString()} update check failed (${plan.kind}, ${verdict})\n${updateErrorText(raw).slice(0, LOG_ENTRY_CHARS)}\n\n`
}
