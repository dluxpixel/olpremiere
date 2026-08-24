import { beforeEach, describe, expect, it, vi } from 'vitest'

import { generationOptsFor, getCaptionLanguage, modelFor, setCaptionLanguage } from './transcribeConfig'

describe('caption language routing', () => {
  it('English keeps the .en model; Czech and auto use the multilingual export', () => {
    expect(modelFor('en')).toBe('onnx-community/whisper-small.en_timestamped')
    expect(modelFor('cs')).toBe('onnx-community/whisper-small_timestamped')
    expect(modelFor('auto')).toBe('onnx-community/whisper-small_timestamped')
    // Both MUST stay _timestamped exports, because word timestamps need the
    // cross-attention outputs only those carry (the s14 constraint).
    expect(modelFor('en')).toMatch(/_timestamped$/)
    expect(modelFor('cs')).toMatch(/_timestamped$/)
  })

  it('a .en pipeline gets NO language option; multilingual pins transcribe + language', () => {
    expect(generationOptsFor('en')).toEqual({})
    expect(generationOptsFor('cs')).toEqual({ task: 'transcribe', language: 'cs' })
    // auto omits language so Whisper detects, but never 'translate'.
    expect(generationOptsFor('auto')).toEqual({ task: 'transcribe' })
  })

  it('persistence survives a roundtrip and tolerates a missing localStorage', () => {
    // node env: no localStorage, so both directions must not throw.
    expect(getCaptionLanguage()).toBe('en')
    expect(() => setCaptionLanguage('cs')).not.toThrow()
  })
})

// ⛔ THE KEY WORD HIGHLIGHT IS OFF UNTIL HE ASKS FOR IT.
//
// It shipped ON, and it colours words in videos he publishes. His words on
// finding out, 2026-08-24: *"why the fuck are you only now telling me about this
// feature that you added, and it's been fucking on my edits for quite some
// time?"* A thing that changes what his audience sees is his to switch on.
//
// The module caches the answer for the life of the page, which is the whole
// point of it, so each case reloads the module rather than reaching for a reset
// hatch that would only exist for tests.
describe('the caption highlight defaults to off', () => {
  const fresh = async () => {
    vi.resetModules()
    return await import('./transcribeConfig')
  }

  // This suite runs in the node environment, where there is no localStorage.
  // A tiny stand-in is enough and it keeps the module on its real code path,
  // which is the branch that reads and writes the key.
  const store = new Map()
  beforeEach(() => {
    store.clear()
    globalThis.localStorage = {
      get length() {
        return store.size
      },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
      clear: () => store.clear(),
    }
  })

  it('is off on an install that has never touched the switch', async () => {
    const m = await fresh()
    expect(m.getCaptionEmphasis()).toBe(false)
  })

  it('stays on once he turns it on, across a reload', async () => {
    const m = await fresh()
    m.setCaptionEmphasis(true)
    const again = await fresh()
    expect(again.getCaptionEmphasis()).toBe(true)
  })

  it('writes nothing at all while it sits at the default', async () => {
    const m = await fresh()
    m.setCaptionEmphasis(true)
    m.setCaptionEmphasis(false)
    expect(localStorage.getItem('olpremiere:captions:emphasis')).toBeNull()
    const again = await fresh()
    expect(again.getCaptionEmphasis()).toBe(false)
  })
})
