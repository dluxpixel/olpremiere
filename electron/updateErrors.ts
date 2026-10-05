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
// ⛔ NOTHING RAW REACHES HIM. The message that comes out of here is one of four fixed
// sentences. The text electron-updater built (URLs, headers, a stack) goes to the log.

/** What kind of failure an update check was. */
export type UpdateFailure = 'publishing' | 'offline' | 'denied' | 'other'

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

  // The release exists and its feed file is not there (yet), or its installer is not.
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'publishing'
  if (status === 404) return 'publishing'
  if (/Cannot find \S+ in the latest release artifacts/.test(text)) return 'publishing'

  if (status === 401 || status === 403) return 'denied'
  if (OFFLINE_CODES.has(code) || OFFLINE_TEXT.test(text)) return 'offline'
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
    case 'other':
      return 'Could not check for updates, so you may not be on the newest version.'
  }
}

const KNOWN_MESSAGES: ReadonlySet<string> = new Set(
  (['offline', 'denied', 'publishing', 'other'] as const).map(updateFailureMessage),
)

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
 * How many "release still publishing" answers in a row stay quiet. Three quick
 * rechecks (about fourteen minutes) and then three polls, so roughly an hour, which is
 * far longer than any upload. A 404 that outlasts it is a dead feed, and a dead feed
 * is what hid for weeks, so the next answer is said out loud.
 */
export const PUBLISHING_QUIET_LIMIT = 6

export interface UpdateErrorPlan {
  kind: UpdateFailure
  /** The one sentence to tell him, or null when the right thing is to say nothing. */
  message: string | null
  /** The streak of "still publishing" answers to hand back in next time. */
  streak: number
  /** Look again this many ms from now, or null to leave it to the ordinary poll. */
  retryInMs: number | null
}

/**
 * What to do about a failed check, given how many "still publishing" answers came
 * just before it (`streak`, 0 for none). Anything that is not a release mid upload
 * ends the streak and gets its sentence.
 */
export function planUpdateError(raw: unknown, streak: number): UpdateErrorPlan {
  const kind = classifyUpdateError(raw)
  if (kind !== 'publishing') return { kind, message: updateFailureMessage(kind), streak: 0, retryInMs: null }
  const next = streak + 1
  if (next > PUBLISHING_QUIET_LIMIT) return { kind, message: updateFailureMessage(kind), streak: next, retryInMs: null }
  return { kind, message: null, streak: next, retryInMs: PUBLISHING_RETRY_MS[streak] ?? null }
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
