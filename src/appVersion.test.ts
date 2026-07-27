import { describe, expect, it } from 'vitest'
import { checkForUpdate } from './appVersion'

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
