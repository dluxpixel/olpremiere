import { describe, expect, it } from 'vitest'
import { checkForUpdate, displayVersion } from './appVersion'

describe('displayVersion', () => {
  it('drops the pre-1.0 zero, which is the whole ask', () => {
    // "it says version 0.1.21, make it just 1.21."
    expect(displayVersion('0.1.21')).toBe('1.21')
    expect(displayVersion('0.2.0')).toBe('2.0')
  })

  it('leaves a real 1.x alone', () => {
    // Once the app ships a true 1.0 the string must not be mangled further.
    expect(displayVersion('1.0.0')).toBe('1.0.0')
    expect(displayVersion('12.4.1')).toBe('12.4.1')
  })

  it('only strips a leading zero SEGMENT, never a leading digit', () => {
    expect(displayVersion('0.10.2')).toBe('10.2')
    expect(displayVersion('10.0.2')).toBe('10.0.2')
  })
})

describe('checkForUpdate', () => {
  it('is a silent first-run when nothing was ever stored', () => {
    expect(checkForUpdate(null, '0.1.9')).toEqual({ kind: 'first-run', version: '0.1.9' })
  })

  it('is silent when re-opening the same build', () => {
    expect(checkForUpdate('0.1.9', '0.1.9')).toEqual({ kind: 'unchanged', version: '0.1.9' })
  })

  it('reports an update when the version moved forward', () => {
    expect(checkForUpdate('0.1.9', '0.1.10')).toEqual({ kind: 'updated', from: '0.1.9', to: '0.1.10' })
  })

  it('reports a rollback too, because the notification must never claim a build it is not on', () => {
    expect(checkForUpdate('0.2.0', '0.1.9')).toEqual({ kind: 'updated', from: '0.2.0', to: '0.1.9' })
  })

  it('treats an empty stored string as a first run (never announces "updated to" from nothing)', () => {
    expect(checkForUpdate('', '0.1.9')).toEqual({ kind: 'first-run', version: '0.1.9' })
  })
})
