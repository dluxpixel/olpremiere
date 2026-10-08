// What a failed update check is judged to be, and the one sentence he is told. On
// 2026-10-04 a release that was still uploading made his app print the updater's raw
// text: "Cannot find latest.yml in the latest release artifacts (https://...): HttpError:
// 404", the response headers and a stack trace. These tests use the REAL error classes
// electron-updater throws (builder-util-runtime), because the shape they carry is the
// thing being read.

import { createHttpError, HttpError, newError } from 'builder-util-runtime'
import { describe, expect, it } from 'vitest'
import {
  classifyUpdateError,
  isKnownUpdateMessage,
  planUpdateError,
  PUBLISHING_QUIET_MS,
  PUBLISHING_RETRY_MS,
  PUBLISHING_RUN_GAP_MS,
  UPDATE_FAILURES,
  updateErrorText,
  updateFailureMessage,
  updateLogEntry,
  type QuietRun,
  type UpdateFailure,
} from './updateErrors'

const MIN = 60_000

const FEED = 'https://github.com/dluxpixel/olpremiere/releases/download/v3.22.0/latest.yml'
const ATOM = 'https://github.com/dluxpixel/olpremiere/releases.atom'
const LATEST = 'https://github.com/dluxpixel/olpremiere/releases/latest'

/** A 404 the way the updater's http stack really builds one, for a GET on `url`. */
function real404(url: string): HttpError {
  const u = new URL(url)
  return createHttpError(
    { statusCode: 404, statusMessage: 'Not Found', headers: { server: 'github.com' } } as never,
    `method: GET url: https://${u.hostname}${u.pathname}\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n`,
  )
}

/** A first answer of a launch: no streak yet, nothing remembered. */
const FRESH: QuietRun = { streak: 0, quietSince: null, now: 1_800_000_000_000 }

/** The error from his screenshot, built the way electron-updater builds it. */
function missingFeedError(): Error {
  const http = new HttpError(
    404,
    '404 Not Found\n"method: GET url: ' + FEED + '\n\nPlease double check that your authentication token is correct."',
    { 'x-github-request-id': 'ABCD:1234', server: 'github.com' } as unknown as string,
  )
  return newError(`Cannot find latest.yml in the latest release artifacts (${FEED}): ${http.stack}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
}

const KINDS: UpdateFailure[] = ['publishing', 'missing', 'offline', 'denied', 'other']

describe('classifyUpdateError', () => {
  it('⛔ calls the missing latest.yml from his screenshot a release still publishing', () => {
    expect(classifyUpdateError(missingFeedError())).toBe('publishing')
  })

  it('goes by the updater\'s own error code first, whatever the words say', () => {
    expect(classifyUpdateError(newError('something reworded in a later version', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toBe(
      'publishing',
    )
  })

  it('still knows it from the words alone, when the code is gone', () => {
    expect(
      classifyUpdateError(new Error(`Cannot find latest.yml in the latest release artifacts (${FEED}): HttpError: 404`)),
    ).toBe('publishing')
  })

  it('treats a 404 on a file of a listed release as the same thing', () => {
    expect(classifyUpdateError(real404(FEED))).toBe('publishing')
  })

  // ⛔ 2026-10-06. Under the draft first flow these can never mean "still uploading": a
  // draft is in neither the feed nor /releases/latest. A private, renamed or deleted repo
  // answers the feed with 404, and was being called "on its way" for 45 minutes a launch.
  it('⛔ calls a 404 on the releases feed itself a dead feed, not a release mid upload', () => {
    expect(classifyUpdateError(real404(ATOM))).toBe('missing')
    expect(classifyUpdateError(new HttpError(404))).toBe('missing')
    expect(classifyUpdateError(Object.assign(new Error('x'), { statusCode: 404 }))).toBe('missing')
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'HTTP_ERROR_404' }))).toBe('missing')
  })

  it('⛔ calls no published release at all a dead feed', () => {
    const latest = newError(
      `Unable to find latest version on GitHub (${LATEST}), please ensure a production release exists: ${real404(LATEST).stack}`,
      'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    )
    expect(classifyUpdateError(latest)).toBe('missing')
    // The way electron-updater 6.8 really delivers it: wrapped again as a feed it could not
    // read, with the whole feed attached, whose release notes may link a download.
    const wrapped = newError(
      `Cannot parse releases feed: ${latest.stack},\nXML:\n<feed><entry><content>Get it at ${FEED}</content></entry></feed>`,
      'ERR_UPDATER_INVALID_RELEASE_FEED',
    )
    expect(classifyUpdateError(wrapped)).toBe('missing')
    expect(classifyUpdateError(newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe('missing')
    expect(classifyUpdateError(newError('No published versions on GitHub', 'ERR_XML_MISSED_ELEMENT'))).toBe('missing')
  })

  it('treats an installer that is not there yet the same way', () => {
    expect(
      classifyUpdateError(new Error('Cannot download "https://github.com/dluxpixel/olpremiere/releases/download/v3.22.0/OL-Premiere-3.22.0-setup.exe", status 404: Not Found')),
    ).toBe('publishing')
  })

  it('calls a refusal denied', () => {
    expect(classifyUpdateError(new HttpError(401))).toBe('denied')
    expect(classifyUpdateError(new HttpError(403, '403 rate limit exceeded'))).toBe('denied')
  })

  it('calls a missing network offline', () => {
    expect(classifyUpdateError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }))).toBe('offline')
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('offline')
    expect(classifyUpdateError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('offline')
    expect(classifyUpdateError(new Error('socket hang up'))).toBe('offline')
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('offline')
  })

  it('does not mistake offline for a missing release when the updater wraps one in the other', () => {
    const wrapped = newError(
      'Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED',
      'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    )
    expect(classifyUpdateError(wrapped)).toBe('offline')
  })

  it('keeps everything else as other, a server fault included', () => {
    expect(classifyUpdateError(new HttpError(500))).toBe('other')
    expect(classifyUpdateError(new HttpError(502))).toBe('other')
    expect(classifyUpdateError(new Error('Cannot parse releases feed: Unexpected token'))).toBe('other')
    expect(classifyUpdateError(newError('sha512 checksum mismatch', 'ERR_CHECKSUM_MISMATCH'))).toBe('other')
  })

  it('never throws, whatever it is handed', () => {
    for (const odd of [undefined, null, 0, 'a string', { weird: true }, [], Symbol('s'), () => 1]) {
      expect(() => classifyUpdateError(odd)).not.toThrow()
      expect(KINDS).toContain(classifyUpdateError(odd))
    }
    expect(classifyUpdateError('HttpError: 404 Not Found')).toBe('missing')
  })
})

describe('the sentences he is told', () => {
  it.each(KINDS)('%s is one short plain sentence', (kind) => {
    const m = updateFailureMessage(kind)
    expect(m.length).toBeLessThanOrEqual(90)
    expect(m).not.toMatch(/[\n\r]/)
    expect(m.match(/\./g)).toHaveLength(1) // one sentence, ending the message
    expect(m.endsWith('.')).toBe(true)
  })

  it.each(KINDS)('%s carries no URL, status code, header or stack', (kind) => {
    const m = updateFailureMessage(kind)
    expect(m).not.toMatch(/https?:|\/\/|HttpError|ERR_|\b[45]\d\d\b|latest\.yml|headers?\b|\bat \S+ \(|\{|\}/i)
  })

  it.each(KINDS)('%s has no em or en dash', (kind) => {
    const codes = [...updateFailureMessage(kind)].map((c) => c.charCodeAt(0))
    expect(codes).not.toContain(0x2013)
    expect(codes).not.toContain(0x2014)
  })

  it('are five different sentences, so the log and the toast can tell them apart', () => {
    expect(new Set(KINDS.map(updateFailureMessage)).size).toBe(5)
    expect([...UPDATE_FAILURES].sort()).toEqual([...KINDS].sort())
  })

  it('are the only text isKnownUpdateMessage lets through', () => {
    for (const k of KINDS) expect(isKnownUpdateMessage(updateFailureMessage(k))).toBe(true)
    expect(isKnownUpdateMessage(updateErrorText(missingFeedError()))).toBe(false)
    expect(isKnownUpdateMessage('HttpError: 404')).toBe(false)
    expect(isKnownUpdateMessage('')).toBe(false)
  })
})

describe('planUpdateError', () => {
  it('⛔ says NOTHING for a release that is still publishing, and looks again in two minutes', () => {
    const plan = planUpdateError(missingFeedError(), FRESH)
    expect(plan.kind).toBe('publishing')
    expect(plan.message).toBeNull()
    expect(plan.streak).toBe(1)
    expect(plan.quietSince).toBe(FRESH.now)
    expect(plan.retryInMs).toBe(2 * 60_000)
  })

  it('waits longer each time, then leaves it to the ordinary poll', () => {
    const waits: (number | null)[] = []
    let run: QuietRun = FRESH
    for (let i = 0; i < 5; i++) {
      const plan = planUpdateError(missingFeedError(), run)
      expect(plan.message).toBeNull()
      waits.push(plan.retryInMs)
      run = { streak: plan.streak, quietSince: plan.quietSince, now: run.now + 60_000 }
    }
    expect(waits).toEqual([...PUBLISHING_RETRY_MS, null, null])
    expect(PUBLISHING_RETRY_MS).toEqual([120_000, 240_000, 480_000])
  })

  it('⛔ is not quiet forever: a 404 that outlasts any upload, by the clock, is said out loud', () => {
    expect(PUBLISHING_QUIET_MS).toBe(60 * 60_000)
    const run = { streak: 3, quietSince: FRESH.now, now: FRESH.now + PUBLISHING_QUIET_MS }
    const plan = planUpdateError(missingFeedError(), run)
    expect(plan.message).toBe(updateFailureMessage('publishing'))
    expect(plan.retryInMs).toBeNull()
    expect(plan.quietSince).toBe(FRESH.now)
  })

  it('⛔ says it on the FIRST answer of a new launch when the quiet run began 61 minutes ago', () => {
    // streak 0: a new launch knows nothing but what main kept on disk.
    const plan = planUpdateError(missingFeedError(), { streak: 0, quietSince: FRESH.now - 61 * 60_000, now: FRESH.now })
    expect(plan.message).toBe(updateFailureMessage('publishing'))
  })

  // ⛔ A run is cleared only by a later answer, so an app closed inside the two minute
  // recheck left its start on disk. Days later a real release minutes into its upload
  // was said out loud on the first answer, because the run looked days old.
  it('⛔ a quiet run that heard nothing for days is over: the next answer starts a new quiet hour', () => {
    const daysAgo = FRESH.now - 3 * 24 * 60 * MIN
    const plan = planUpdateError(missingFeedError(), { streak: 0, quietSince: daysAgo, quietLast: daysAgo, now: FRESH.now })
    expect(plan.message).toBeNull()
    expect(plan.quietSince).toBe(FRESH.now)
    expect(plan.retryInMs).toBe(PUBLISHING_RETRY_MS[0])
    // A run kept by the version before this one has no last answer: its start stands in.
    expect(planUpdateError(missingFeedError(), { streak: 0, quietSince: daysAgo, now: FRESH.now }).message).toBeNull()
    expect(PUBLISHING_RUN_GAP_MS).toBe(24 * 60 * MIN)
  })

  it('⛔ but a run still being heard is said on the first answer, however many launches it spans', () => {
    // Begun yesterday afternoon, last heard last night: a release that stays half published.
    const plan = planUpdateError(missingFeedError(), {
      streak: 0,
      quietSince: FRESH.now - 20 * 60 * MIN,
      quietLast: FRESH.now - 14 * 60 * MIN,
      now: FRESH.now,
    })
    expect(plan.message).toBe(updateFailureMessage('publishing'))
    expect(plan.quietSince).toBe(FRESH.now - 20 * 60 * MIN)
  })

  it('stays quiet across a relaunch inside the hour, and a clock that went back starts it again', () => {
    expect(planUpdateError(missingFeedError(), { streak: 0, quietSince: FRESH.now - 20 * 60_000, now: FRESH.now }).message).toBeNull()
    const back = planUpdateError(missingFeedError(), { streak: 0, quietSince: FRESH.now + 3_600_000, now: FRESH.now })
    expect(back.message).toBeNull()
    expect(back.quietSince).toBe(FRESH.now)
  })

  it('⛔ says a dead feed at once, on the first answer of the first launch', () => {
    const plan = planUpdateError(real404(ATOM), FRESH)
    expect(plan.kind).toBe('missing')
    expect(plan.message).toBe(updateFailureMessage('missing'))
    expect(plan.quietSince).toBeNull()
  })

  it('gives a real failure its sentence at once and ends the run', () => {
    const offline = planUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), { streak: 4, quietSince: FRESH.now - 1000, now: FRESH.now })
    expect(offline).toEqual({
      kind: 'offline',
      message: updateFailureMessage('offline'),
      streak: 0,
      quietSince: null,
      retryInMs: null,
    })
    expect(planUpdateError(new HttpError(403), { ...FRESH, streak: 2 }).message).toBe(updateFailureMessage('denied'))
    expect(planUpdateError(new Error('boom'), FRESH).message).toBe(updateFailureMessage('other'))
  })

  it('never lets the updater\'s own text into the message', () => {
    // A real failure whose raw text is full of everything that was on his screen.
    const nasty = Object.assign(new Error(`Cannot download "${FEED}", status 500: Server Error\nheaders: {"server":"github.com"}\n    at ClientRequest.<anonymous> (node_modules/builder-util-runtime/out/httpExecutor.js:155:25)`), {})
    const plan = planUpdateError(nasty, FRESH)
    expect(plan.message).toBe(updateFailureMessage('other'))
    expect(plan.message).not.toContain('github.com')
    expect(plan.message).not.toContain('headers')
  })
})

describe('the log entry', () => {
  const at = new Date('2026-10-05T10:00:00.000Z')

  it('keeps everything the toast no longer shows: the URL, the headers, the stack', () => {
    const err = missingFeedError()
    const entry = updateLogEntry(at, planUpdateError(err, FRESH), err)
    expect(entry).toContain('2026-10-05T10:00:00.000Z')
    expect(entry).toContain('publishing')
    expect(entry).toContain('quiet, a release still publishing, checking again in 120s')
    expect(entry).toContain(FEED)
    expect(entry).toContain('HttpError')
    expect(entry.endsWith('\n\n')).toBe(true)
  })

  it('says when it WAS shown to him', () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED')
    expect(updateLogEntry(at, planUpdateError(err, FRESH), err)).toContain('(offline, shown to him)')
  })

  it('is bounded, so one huge page cannot fill the log', () => {
    const err = new Error('x'.repeat(50_000))
    expect(updateLogEntry(at, planUpdateError(err, FRESH), err).length).toBeLessThan(4300)
  })
})

describe('updateErrorText', () => {
  it('reads an Error, a string and an odd value without throwing', () => {
    expect(updateErrorText(new Error('boom'))).toContain('boom')
    expect(updateErrorText('plain')).toBe('plain')
    expect(updateErrorText({ a: 1 })).toBe('{"a":1}')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => updateErrorText(loop)).not.toThrow()
    expect(updateErrorText(undefined)).toBe('undefined')
  })
})
