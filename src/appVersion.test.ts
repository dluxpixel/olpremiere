import { describe, expect, it } from 'vitest'
import { checkForUpdate, displayVersion } from './appVersion'

describe('displayVersion', () => {
  it('drops the pre-1.0 zero, which is the whole ask', () => {
    // "it says version 0.1.21, make it just 1.21."
    expect(displayVersion('0.1.21')).toBe('1.21')
    expect(displayVersion('0.2.0')).toBe('2.0')
  })

  it('leaves a real 1.x leading digit alone', () => {
    expect(displayVersion('12.4.1')).toBe('12.4.1')
  })

  describe('his numbering, 2026-08-19', () => {
    // "let's change the format of this to 2.17 and when we do smaller updates,
    // more like patch fixes, let's make it 2.17.1 and so on when we do a bigger
    // update, let's turn it into 2.18."
    it('an ordinary release drops the trailing zero', () => {
      expect(displayVersion('2.17.0')).toBe('2.17')
      expect(displayVersion('2.18.0')).toBe('2.18')
      expect(displayVersion('1.0.0')).toBe('1.0')
    })

    it('a fix on top of one keeps its third number', () => {
      expect(displayVersion('2.17.1')).toBe('2.17.1')
      expect(displayVersion('2.17.10')).toBe('2.17.10')
    })

    it('⛔ never strips a zero that is not the LAST part', () => {
      // 2.0.17 is the old scheme and still has to read as itself.
      expect(displayVersion('2.0.17')).toBe('2.0.17')
      expect(displayVersion('2.10.0')).toBe('2.10')
    })

    it('⛔ never leaves a bare single number', () => {
      // The pre-1.0 strip already took 0.2.0 down to two parts; taking the
      // trailing zero as well would hand him "2".
      expect(displayVersion('0.2.0')).toBe('2.0')
    })
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
