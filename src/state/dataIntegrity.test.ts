// The sentence he reads when the store holds media and no project.

import { describe, expect, it } from 'vitest'
import { integrityMessage } from './dataIntegrity'

describe('integrityMessage', () => {
  it('says nothing is gone and what not to do, never "check your backups"', () => {
    // The backups it pointed at can no longer be opened from the app (the
    // Recover tab went at his word), so it frightened without helping.
    const msg = integrityMessage({ projectCount: 0, blobCount: 12, orphanedMedia: true, empty: false })
    expect(msg).toBe('Your media is still here (12 files), but no project uses it. Nothing was deleted. Do not delete anything yet.')
    expect(msg).not.toMatch(/backup/i)
  })

  it('says nothing when all is well, or on a new install', () => {
    expect(integrityMessage({ projectCount: 3, blobCount: 40, orphanedMedia: false, empty: false })).toBeNull()
    expect(integrityMessage({ projectCount: 0, blobCount: 0, orphanedMedia: false, empty: true })).toBeNull()
    expect(integrityMessage(null)).toBeNull()
  })
})
