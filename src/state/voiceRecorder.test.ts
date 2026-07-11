import { describe, expect, it } from 'vitest'

import { audioConstraintFor, recordingFileName } from './voiceRecorder'

describe('recordingFileName', () => {
  it('numbers takes and picks the extension from the mime', () => {
    expect(recordingFileName(1, 'audio/webm;codecs=opus')).toBe('Voice recording 1.webm')
    expect(recordingFileName(2, 'audio/webm')).toBe('Voice recording 2.webm')
    expect(recordingFileName(3, 'audio/ogg;codecs=opus')).toBe('Voice recording 3.ogg')
    expect(recordingFileName(4, 'audio/mp4')).toBe('Voice recording 4.m4a')
  })

  it('defaults to webm when the mime is unknown or empty', () => {
    expect(recordingFileName(5, '')).toBe('Voice recording 5.webm')
    expect(recordingFileName(6, 'audio/weird')).toBe('Voice recording 6.webm')
  })
})

describe('audioConstraintFor', () => {
  it('uses the system default when no device is chosen', () => {
    expect(audioConstraintFor(null)).toBe(true)
  })

  it('pins an explicitly chosen device with an exact constraint', () => {
    expect(audioConstraintFor('mic-abc123')).toEqual({ deviceId: { exact: 'mic-abc123' } })
  })
})
