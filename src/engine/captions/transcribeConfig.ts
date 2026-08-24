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

// ⛔ SMALL, NOT BASE, SINCE 2026-08-18, AND THAT IS THE HEADLINE ACCURACY FIX.
// His words that day: *"It reads words bad, like really fucking bad."* He was
// right and the cause was not tuning. `whisper-base` is the second SMALLEST
// Whisper there is, four steps below the top, and on real speech `small`
// roughly halves its word error rate. No amount of prompt or threshold work
// closes a gap that size, because the model simply does not know the word.
//
// ⚠️ THE COST IS A ONE-OFF DOWNLOAD, about 480 MB against base's 145 MB,
// quantised the same way and cached in the browser Cache Storage exactly as
// before, so it is paid once and survives reloads. Inference is roughly two to
// three times slower per clip. That is the trade he asked for, in his own
// words, and the boot card already warms the model so the first run does not
// pay for the download mid-edit.
//
// ⛔ THE `_timestamped` SUFFIX IS NOT OPTIONAL on either of these, whatever the
// size. Word-level timestamps need the cross-attention outputs only those
// exports carry. Both ids were confirmed to exist and to ship the same q8/q4
// onnx files the loader asks for before this landed.
const EN_MODEL = 'onnx-community/whisper-small.en_timestamped'
const MULTILINGUAL_MODEL = 'onnx-community/whisper-small_timestamped'

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
 * ⛔ DEFAULT OFF, CHANGED 2026-08-24, AND THE OLD DEFAULT WAS A MISTAKE.
 *
 * It shipped ON, on the argument that a flat caption is the worse of the two.
 * That was a judgement about taste made on his behalf about the colour of words
 * in videos he publishes, and he was never plainly told it was running. His
 * words when he finally noticed: *"it sometimes randomly makes the text yellow"*,
 * and then *"why the fuck are you only now telling me about this feature that
 * you added, and it's been fucking on my edits for quite some time?"*
 *
 * It is not random, it colours the word he leaned on, but from the outside a
 * feature nobody mentioned looks exactly like a fault. A thing that changes what
 * his audience sees is his to switch on.
 *
 * The switch keeps working and the memory is unchanged: only the NON default is
 * stored, so now 'on' is what gets written and an untouched install writes
 * nothing. Anyone who had already turned it off stays off, because their stored
 * value is not 'on' either.
 */
let emphasis: boolean | null = null

export function getCaptionEmphasis(): boolean {
  if (emphasis !== null) return emphasis
  try {
    emphasis = (typeof localStorage !== 'undefined' ? localStorage.getItem(EMPHASIS_KEY) : null) === 'on'
  } catch {
    emphasis = false
  }
  return emphasis
}

export function setCaptionEmphasis(next: boolean): void {
  emphasis = next
  try {
    if (typeof localStorage === 'undefined') return
    // The non-default is what gets stored, and the default is now OFF, so this
    // is the mirror of what it was: 'on' is written, and off clears the key.
    if (next) localStorage.setItem(EMPHASIS_KEY, 'on')
    else localStorage.removeItem(EMPHASIS_KEY)
  } catch {
    // Private mode / quota: the in-memory value above still applies this run.
  }
}
