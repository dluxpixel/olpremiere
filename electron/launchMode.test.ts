// An update that applied itself while he was away opens quietly on the taskbar; every
// other start keeps the card and the melon. See ./launchMode.

import { describe, expect, it } from 'vitest'
import { appliedWhileAway, launchMode, parseQuietMarker, QUIET_MARKER_MAX_AGE_MS } from './launchMode'
import { IDLE_APPLY_S } from './updateApply'

const NOW = 1_800_000_000_000
const APP = ['C:\\Program Files\\OL Premiere\\OL Premiere.exe']

describe('launchMode', () => {
  it('a start he made is normal', () => {
    expect(launchMode({ argv: APP, markerAt: null, now: NOW })).toBe('normal')
  })

  it('a start he made is normal even with a marker lying around', () => {
    expect(launchMode({ argv: APP, markerAt: NOW - 1000, now: NOW })).toBe('normal')
  })

  it('an update he clicked through himself is normal: no marker was written', () => {
    expect(launchMode({ argv: [...APP, '--updated'], markerAt: null, now: NOW })).toBe('normal')
  })

  it('an update that applied while he was away is quiet', () => {
    expect(launchMode({ argv: [...APP, '--updated'], markerAt: NOW - 40_000, now: NOW })).toBe('quiet')
  })

  it('an old marker from an update that never finished does not count', () => {
    expect(launchMode({ argv: [...APP, '--updated'], markerAt: NOW - QUIET_MARKER_MAX_AGE_MS - 1, now: NOW })).toBe('normal')
    expect(launchMode({ argv: [...APP, '--updated'], markerAt: NOW + 60_000, now: NOW })).toBe('normal')
  })
})

describe('appliedWhileAway', () => {
  it('is the same five minutes that let the update apply itself', () => {
    expect(appliedWhileAway(0)).toBe(false)
    expect(appliedWhileAway(IDLE_APPLY_S - 1)).toBe(false)
    expect(appliedWhileAway(IDLE_APPLY_S)).toBe(true)
  })
})

describe('parseQuietMarker', () => {
  it('reads the time main wrote', () => {
    expect(parseQuietMarker(JSON.stringify({ at: NOW }))).toBe(NOW)
  })

  it('treats anything odd as no marker', () => {
    for (const odd of [null, '', 'garbage', '{}', '{"at":"soon"}', '[1]', 'null']) expect(parseQuietMarker(odd)).toBeNull()
  })
})
