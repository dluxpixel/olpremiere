import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  audioConstraintFor,
  ENHANCE_KEY,
  loadEnhance,
  recordingFileName,
  setEnhance,
} from './voiceRecorder'

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
  it('defaults to clean capture: processing off, 48k mono, no device pinned', () => {
    expect(audioConstraintFor(null)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    })
  })

  it('pins an explicitly chosen device with an exact constraint', () => {
    expect(audioConstraintFor('mic-abc123')).toMatchObject({ deviceId: { exact: 'mic-abc123' } })
  })

  it('noise-reduce toggles ONLY noise suppression (echo + auto-gain stay off)', () => {
    expect(audioConstraintFor(null, true)).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    })
  })
})

describe('loadEnhance / setEnhance', () => {
  // The suite runs on the node environment (no DOM), so stand up the minimum
  // localStorage the recorder actually calls.
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', stub)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('noise reduction defaults ON when nothing is saved', () => {
    expect(loadEnhance()).toBe(true)
  })

  it('only an explicit off ("0") disables it; legacy "1" stays on', () => {
    setEnhance(false)
    expect(store.get(ENHANCE_KEY)).toBe('0')
    expect(loadEnhance()).toBe(false)
    setEnhance(true)
    expect(loadEnhance()).toBe(true)
    store.set(ENHANCE_KEY, '1') // value written before this change
    expect(loadEnhance()).toBe(true)
  })
})
