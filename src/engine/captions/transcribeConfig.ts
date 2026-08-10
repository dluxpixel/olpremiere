// Language routing for local Whisper captions. English keeps the smaller,
// better-at-English `.en` model; Czech (and auto-detect) use the multilingual
// export. Both MUST be `_timestamped` onnx-community exports. Word-level
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
 * 'translate', because captions must stay in the spoken language) and a fixed
 * `language` when the user chose one. 'auto' omits it → Whisper detects.
 */
export function generationOptsFor(language: CaptionLanguage): Record<string, unknown> {
  if (language === 'en') return {}
  return { task: 'transcribe', ...(language === 'auto' ? {} : { language }) }
}

const LANG_KEY = 'olpremiere:captions:lang'

/**
 * The live value. localStorage only PERSISTS it; the choice itself lives here,
 * so a blocked store costs the setting across restarts but never inside the
 * session it was set in, which is what the note below always claimed and did
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
    // Private mode / quota: the in-memory value above still applies this run.
  }
}

const EMPHASIS_KEY = 'olpremiere:captions:emphasis'

/**
 * Highlight the one word he leaned on, per caption phrase. Same shape as the
 * language pick above on purpose: live value in memory, localStorage only
 * persists it, and every caption door reads it from here so the dialog and the
 * clip right-click can never disagree.
 *
 * DEFAULT ON. A flat caption is what he has today and it is the worse of the
 * two: the renderer has had the emphasis colour all along and the auto path
 * never once set the flag. Only the non-default is stored, so an untouched
 * install writes nothing.
 */
let emphasis: boolean | null = null

export function getCaptionEmphasis(): boolean {
  if (emphasis !== null) return emphasis
  try {
    emphasis = (typeof localStorage !== 'undefined' ? localStorage.getItem(EMPHASIS_KEY) : null) !== 'off'
  } catch {
    emphasis = true
  }
  return emphasis
}

export function setCaptionEmphasis(next: boolean): void {
  emphasis = next
  try {
    if (typeof localStorage === 'undefined') return
    if (next) localStorage.removeItem(EMPHASIS_KEY)
    else localStorage.setItem(EMPHASIS_KEY, 'off')
  } catch {
    // Private mode / quota: the in-memory value above still applies this run.
  }
}
