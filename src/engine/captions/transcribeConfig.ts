// Language routing for local Whisper captions. English keeps the smaller,
// better-at-English `.en` model; Czech (and auto-detect) use the multilingual
// export. Both MUST be `_timestamped` onnx-community exports — word-level
// timestamps need the cross-attention outputs only those exports carry, and
// older Xenova exports trip onnxruntime's session validation outright (the
// s14 lesson, re-verified for the multilingual model in
// _verify/czech-captions-probe.mjs).

export type CaptionLanguage = 'en' | 'cs' | 'auto'

export const CAPTION_LANGUAGES: { value: CaptionLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'cs', label: 'Czech (Čeština)' },
  { value: 'auto', label: 'Auto-detect' },
]

const EN_MODEL = 'onnx-community/whisper-base.en_timestamped'
const MULTILINGUAL_MODEL = 'onnx-community/whisper-base_timestamped'

export function modelFor(language: CaptionLanguage): string {
  return language === 'en' ? EN_MODEL : MULTILINGUAL_MODEL
}

/**
 * Generation options per language. A `.en` pipeline rejects a `language`
 * option outright; the multilingual model needs `task: 'transcribe'` (never
 * 'translate' — captions must stay in the spoken language) and a fixed
 * `language` when the user chose one. 'auto' omits it → Whisper detects.
 */
export function generationOptsFor(language: CaptionLanguage): Record<string, unknown> {
  if (language === 'en') return {}
  return { task: 'transcribe', ...(language === 'auto' ? {} : { language }) }
}

const LANG_KEY = 'reel:captions:lang'

/**
 * The live value. localStorage only PERSISTS it; the choice itself lives here,
 * so a blocked store costs the setting across restarts but never inside the
 * session it was set in — which is what the note below always claimed and did
 * not actually do (an early return meant the pick was dropped on the floor).
 */
let language: CaptionLanguage | null = null

/** Persisted caption language (default English), tolerant of no localStorage. */
export function getCaptionLanguage(): CaptionLanguage {
  if (language !== null) return language
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : null
    language = v === 'cs' || v === 'auto' ? v : 'en'
  } catch {
    language = 'en'
  }
  return language
}

export function setCaptionLanguage(next: CaptionLanguage): void {
  language = next
  try {
    if (typeof localStorage === 'undefined') return
    if (next === 'en') localStorage.removeItem(LANG_KEY)
    else localStorage.setItem(LANG_KEY, next)
  } catch {
    // Private mode / quota — the in-memory value above still applies this run.
  }
}
