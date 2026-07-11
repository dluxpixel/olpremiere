import { describe, expect, it } from 'vitest'

import { recordingFileName } from './voiceRecorder'

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
