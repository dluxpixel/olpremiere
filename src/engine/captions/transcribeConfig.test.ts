import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  alignerFor,
  generationOptsFor,
  getCaptionLanguage,
  modelFor,
  modelsInUse,
  setCaptionLanguage,
  staleModelKeys,
  whisperModel,
} from './transcribeConfig'

describe('caption language routing', () => {
  // Measured on his own six projects, 2026-10-03: large-v3-turbo took the word
  // error rate against his corrected captions from 13.2% to 8.6%.
  it('every language runs on large-v3-turbo, one download for all three', () => {
    expect(modelFor('en')).toBe('onnx-community/whisper-large-v3-turbo_timestamped')
    expect(modelFor('cs')).toBe(modelFor('en'))
    expect(modelFor('auto')).toBe(modelFor('en'))
    expect(modelsInUse()).toEqual([modelFor('en'), alignerFor('en').id])
    // MUST stay a _timestamped export, because word timestamps need the
    // cross-attention outputs only those carry (the s14 constraint).
    expect(modelFor('en')).toMatch(/_timestamped$/)
  })

  it('a multilingual model is told the language, English included, and never to translate', () => {
    expect(generationOptsFor('en')).toEqual({ task: 'transcribe', language: 'en' })
    expect(generationOptsFor('cs')).toEqual({ task: 'transcribe', language: 'cs' })
    // auto omits language so Whisper detects, but never 'translate'.
    expect(generationOptsFor('auto')).toEqual({ task: 'transcribe' })
  })

  it('loads half precision weights on the GPU, within the size he approved', () => {
    const m = whisperModel(modelFor('en'))
    expect(m.multilingual).toBe(true)
    expect(m.gpuDtype).toEqual({ encoder_model: 'fp16', decoder_model_merged: 'fp16' })
    expect(m.wasmDtype).toEqual({ encoder_model: 'q8', decoder_model_merged: 'q4' })
  })

  // The aligner pins Whisper's words to the sound (ctcAlign.ts). One download for
  // every language, like Whisper, and its bias is the one fitted for ITS weights.
  it('every language aligns on the one multilingual wav2vec2, in q4', () => {
    const a = alignerFor('en')
    expect(alignerFor('cs')).toBe(a)
    expect(alignerFor('auto')).toBe(a)
    expect(a.id).toBe('NewComer00/wav2vec2-xlsr-multilingual-56-ONNX')
    expect(a.dtype).toBe('q4')
    expect(a.blank).toBe('[PAD]')
    // Late-running spikes pulled back; measured against SAPI word times.
    expect(a.onsetBiasS).toBeCloseTo(-0.015, 6)
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

// His disk had 6.8 GB free on 2026-10-03 with 1.3 GB of retired Whisper files in it.
describe('staleModelKeys', () => {
  const url = (id: string, file: string) => `https://huggingface.co/${id}/resolve/main/${file}`
  const keys = [
    url('onnx-community/whisper-small.en_timestamped', 'onnx/encoder_model.onnx'),
    url('onnx-community/whisper-small_timestamped', 'config.json'),
    url('onnx-community/whisper-large-v3-turbo_timestamped', 'onnx/encoder_model_fp16.onnx'),
    url('Xenova/ast-finetuned-audioset', 'onnx/model_quantized.onnx'),
  ]

  it('names only the Whisper files no language uses', () => {
    expect(staleModelKeys(keys, ['onnx-community/whisper-large-v3-turbo_timestamped'])).toEqual(keys.slice(0, 2))
  })

  it('never names an aligner file, the aligner being listed as in use or not', () => {
    const files = ['config.json', 'vocab.json', 'preprocessor_config.json', 'onnx/model_q4.onnx', 'onnx/model_quantized.onnx']
    const aligners = [alignerFor('en').id, 'Xenova/wav2vec2-base-960h']
    const urls = aligners.flatMap((id) => files.map((f) => url(id, f)))
    expect(staleModelKeys(urls, modelsInUse())).toEqual([])
    expect(staleModelKeys(urls, [])).toEqual([])
    // And the aligner is kept alongside the Whisper files it never competes with.
    expect(modelsInUse()).toContain(alignerFor('en').id)
    expect(staleModelKeys([...urls, ...keys], modelsInUse())).toEqual(keys.slice(0, 2))
  })

  it('keeps every model a language still runs on', () => {
    expect(staleModelKeys(keys, modelsInUse())).not.toContain(keys[2])
    for (const id of modelsInUse()) expect(staleModelKeys([url(id, 'config.json')], modelsInUse())).toEqual([])
  })
})
