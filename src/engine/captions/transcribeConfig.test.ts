import { describe, expect, it } from 'vitest'

import { generationOptsFor, getCaptionLanguage, modelFor, setCaptionLanguage } from './transcribeConfig'

describe('caption language routing', () => {
  it('English keeps the .en model; Czech and auto use the multilingual export', () => {
    expect(modelFor('en')).toBe('onnx-community/whisper-base.en_timestamped')
    expect(modelFor('cs')).toBe('onnx-community/whisper-base_timestamped')
    expect(modelFor('auto')).toBe('onnx-community/whisper-base_timestamped')
    // Both MUST stay _timestamped exports — word timestamps need the
    // cross-attention outputs only those carry (the s14 constraint).
    expect(modelFor('en')).toMatch(/_timestamped$/)
    expect(modelFor('cs')).toMatch(/_timestamped$/)
  })

  it('a .en pipeline gets NO language option; multilingual pins transcribe + language', () => {
    expect(generationOptsFor('en')).toEqual({})
    expect(generationOptsFor('cs')).toEqual({ task: 'transcribe', language: 'cs' })
    // auto omits language so Whisper detects — but never 'translate'.
    expect(generationOptsFor('auto')).toEqual({ task: 'transcribe' })
  })

  it('persistence survives a roundtrip and tolerates a missing localStorage', () => {
    // node env: no localStorage — both directions must not throw.
    expect(getCaptionLanguage()).toBe('en')
    expect(() => setCaptionLanguage('cs')).not.toThrow()
  })
})
