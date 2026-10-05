// What a failed update check is judged to be, and the one sentence he is told. On
// 2026-10-04 a release that was still uploading made his app print the updater's raw
// text: "Cannot find latest.yml in the latest release artifacts (https://...): HttpError:
// 404", the response headers and a stack trace. These tests use the REAL error classes
// electron-updater throws (builder-util-runtime), because the shape they carry is the
// thing being read.

import { HttpError, newError } from 'builder-util-runtime'
import { describe, expect, it } from 'vitest'
import {
  classifyUpdateError,
  isKnownUpdateMessage,
  planUpdateError,
  PUBLISHING_QUIET_LIMIT,
  PUBLISHING_RETRY_MS,
  updateErrorText,
  updateFailureMessage,
  updateLogEntry,
  type UpdateFailure,
} from './updateErrors'

const FEED = 'https://github.com/dluxpixel/olpremiere/releases/download/v3.22.0/latest.yml'

/** The error from his screenshot, built the way electron-updater builds it. */
function missingFeedError(): Error {
  const http = new HttpError(
    404,
    '404 Not Found\n"method: GET url: ' + FEED + '\n\nPlease double check that your authentication token is correct."',
    { 'x-github-request-id': 'ABCD:1234', server: 'github.com' } as unknown as string,
  )
  return newError(`Cannot find latest.yml in the latest release artifacts (${FEED}): ${http.stack}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
}

const KINDS: UpdateFailure[] = ['publishing', 'offline', 'denied', 'other']

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

  it('treats any 404 on the release as the same thing', () => {
    expect(classifyUpdateError(new HttpError(404))).toBe('publishing')
    expect(classifyUpdateError(Object.assign(new Error('x'), { statusCode: 404 }))).toBe('publishing')
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'HTTP_ERROR_404' }))).toBe('publishing')
    expect(
      classifyUpdateError(
        newError(`Unable to find latest version on GitHub (${FEED}), please ensure a production release exists: HttpError: 404 Not Found`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'),
      ),
    ).toBe('publishing')
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
    expect(classifyUpdateError('HttpError: 404 Not Found')).toBe('publishing')
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

  it('are four different sentences, so the log and the toast can tell them apart', () => {
    expect(new Set(KINDS.map(updateFailureMessage)).size).toBe(4)
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
    const plan = planUpdateError(missingFeedError(), 0)
    expect(plan.kind).toBe('publishing')
    expect(plan.message).toBeNull()
    expect(plan.streak).toBe(1)
    expect(plan.retryInMs).toBe(2 * 60_000)
  })

  it('waits longer each time, then leaves it to the ordinary poll', () => {
    const waits: (number | null)[] = []
    let streak = 0
    for (let i = 0; i < PUBLISHING_QUIET_LIMIT; i++) {
      const plan = planUpdateError(missingFeedError(), streak)
      expect(plan.message).toBeNull()
      waits.push(plan.retryInMs)
      streak = plan.streak
    }
    expect(waits).toEqual([...PUBLISHING_RETRY_MS, null, null, null])
    expect(PUBLISHING_RETRY_MS).toEqual([120_000, 240_000, 480_000])
  })

  it('⛔ is not quiet forever: a 404 that outlasts any upload is said out loud', () => {
    const plan = planUpdateError(missingFeedError(), PUBLISHING_QUIET_LIMIT)
    expect(plan.message).toBe(updateFailureMessage('publishing'))
    expect(plan.retryInMs).toBeNull()
    expect(plan.streak).toBe(PUBLISHING_QUIET_LIMIT + 1)
  })

  it('gives a real failure its sentence at once and ends the streak', () => {
    const offline = planUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), 4)
    expect(offline).toEqual({
      kind: 'offline',
      message: updateFailureMessage('offline'),
      streak: 0,
      retryInMs: null,
    })
    expect(planUpdateError(new HttpError(403), 2).message).toBe(updateFailureMessage('denied'))
    expect(planUpdateError(new Error('boom'), 0).message).toBe(updateFailureMessage('other'))
  })

  it('never lets the updater\'s own text into the message', () => {
    // A real failure whose raw text is full of everything that was on his screen.
    const nasty = Object.assign(new Error(`Cannot download "${FEED}", status 500: Server Error\nheaders: {"server":"github.com"}\n    at ClientRequest.<anonymous> (node_modules/builder-util-runtime/out/httpExecutor.js:155:25)`), {})
    const plan = planUpdateError(nasty, 0)
    expect(plan.message).toBe(updateFailureMessage('other'))
    expect(plan.message).not.toContain('github.com')
    expect(plan.message).not.toContain('headers')
  })
})

describe('the log entry', () => {
  const at = new Date('2026-10-05T10:00:00.000Z')

  it('keeps everything the toast no longer shows: the URL, the headers, the stack', () => {
    const err = missingFeedError()
    const entry = updateLogEntry(at, planUpdateError(err, 0), err)
    expect(entry).toContain('2026-10-05T10:00:00.000Z')
    expect(entry).toContain('publishing')
    expect(entry).toContain('quiet, a release still publishing, checking again in 120s')
    expect(entry).toContain(FEED)
    expect(entry).toContain('HttpError')
    expect(entry.endsWith('\n\n')).toBe(true)
  })

  it('says when it WAS shown to him', () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED')
    expect(updateLogEntry(at, planUpdateError(err, 0), err)).toContain('(offline, shown to him)')
  })

  it('is bounded, so one huge page cannot fill the log', () => {
    const err = new Error('x'.repeat(50_000))
    expect(updateLogEntry(at, planUpdateError(err, 0), err).length).toBeLessThan(4300)
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
