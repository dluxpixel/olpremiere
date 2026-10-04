// Which local Whisper model makes his captions, and how it is driven. It MUST
// be a `_timestamped` onnx-community export: word-level timestamps need the
// cross-attention outputs only those exports carry, and older Xenova exports trip
// onnxruntime's session validation outright (the s14 lesson, re-verified for the
// multilingual model in _verify/czech-captions-probe.mjs).

export type CaptionLanguage = 'en' | 'cs' | 'auto'

export const CAPTION_LANGUAGES: { value: CaptionLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'cs', label: 'Czech (Čeština)' },
  { value: 'auto', label: 'Auto-detect' },
]

// ⛔ LARGE-V3-TURBO, NOT SMALL, SINCE 2026-10-03, MEASURED ON HIS OWN WORK.
// His words that day: *"every single time I caption something, it just doesn't
// turn out good ... it doesn't know how to spell [special] stuff. Sometimes it
// just goes something completely random."*
//
// Measured, not assumed: his six captioned projects were re-captioned through
// the built app, "Caption every clip" on copies of his projects and audio, and
// scored against the captions he corrected by hand (584 of his words).
//
//   small.en (what shipped)       13.2% of his words wrong, 20 of 39 names right
//   large-v3-turbo (this)          8.6% wrong, 27 of 39 names right
//
// The "completely random" he meant is in there: small.en heard "we have" as
// "VFP" and "VFX" in his GYM video, and "costs" as "ghosts". Turbo gets those
// right. It is large-v3 with a 4 layer decoder, within half a point
// of large-v3 on the public benchmarks, and multilingual, so Czech and
// auto-detect run on it too and there is ONE download for every language.
//
// medium.en was the other candidate. It was not downloaded: it scores below
// large-v3 on the same benchmarks, its 24 layer decoder is slower per word than
// turbo's 4, and his disk had 6.8 GB free that day.
//
// ⚠️ THE COST IS A ONE-OFF DOWNLOAD of about 1.6 GB in half precision (fp16
// encoder 1274 MB, fp16 decoder 344 MB), cached in the browser Cache Storage
// like every model before it and warmed by the boot card. The retired small
// models' files are deleted once this one has loaded (staleModelKeys).
/** A weight format the onnx-community exports ship, per file. */
export type Weights = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16' | 'int8' | 'uint8' | 'bnb4'

/** One speech model, and the weights each device loads it with. */
export interface WhisperModel {
  id: string
  /** A multilingual model must be told the language, English included. */
  multilingual: boolean
  /** Weights on the GPU. Absent means the library's default (fp32). */
  gpuDtype?: Record<string, Weights>
  /** Weights on the wasm fallback. */
  wasmDtype: Record<string, Weights>
}

const TURBO: WhisperModel = {
  id: 'onnx-community/whisper-large-v3-turbo_timestamped',
  multilingual: true,
  // Half precision on the GPU: 1.6 GB against 3.2 GB in full, and a GPU without
  // half precision maths falls back to wasm before loading (transcribeWorker.ts).
  gpuDtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
  // The int8 ("q8") decoder trips onnxruntime's MatMulNBits pass; the q4
  // decoder is built for it and loads cleanly. Same rule as the small models had.
  wasmDtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
}

/** The model each language runs on: the same one for all three. */
const BY_LANGUAGE: Record<CaptionLanguage, WhisperModel> = { en: TURBO, cs: TURBO, auto: TURBO }

/** Every model the app can run. */
const MODELS: readonly WhisperModel[] = [TURBO]

/** The model a language runs on. */
export function whisperModelFor(language: CaptionLanguage): WhisperModel {
  return BY_LANGUAGE[language]
}

/** Its id, which is also what every caption is stamped with (captionOrigin.model). */
export function modelFor(language: CaptionLanguage): string {
  return whisperModelFor(language).id
}

/** The table entry behind an id, for the worker, which is only ever sent the id. */
export function whisperModel(id: string): WhisperModel {
  return MODELS.find((m) => m.id === id) ?? TURBO
}

/** Every model a caption language can run on today. */
export function modelsInUse(): string[] {
  return [...new Set((['en', 'cs', 'auto'] as const).map(modelFor))]
}

/**
 * The cached files of speech models this app no longer runs, by their Cache
 * Storage keys (the Hugging Face URLs transformers.js fetched them from).
 *
 * ⛔ A RETIRED MODEL IS GIGABYTES HE NEVER GETS BACK OTHERWISE. Nothing else
 * ever deletes from that cache, and on 2026-10-03 his disk had 6.8 GB free
 * while the old Whisper files held 1.3 GB of it. Only Whisper files go, only
 * ones no language uses, and only after the current model has loaded, so a
 * failed download can never leave him with no model at all.
 */
export function staleModelKeys(keys: readonly string[], keep: readonly string[]): string[] {
  return keys.filter((k) => /\/onnx-community\/whisper-[^/]+\//.test(k) && !keep.some((id) => k.includes(`/${id}/`)))
}

/**
 * Generation options per language. A `.en` pipeline rejects a `language`
 * option outright; a multilingual model needs `task: 'transcribe'` (never
 * 'translate', because captions must stay in the spoken language) and a fixed
 * `language` when the user chose one, English included, or it guesses. 'auto'
 * omits it → Whisper detects.
 */
export function generationOptsFor(language: CaptionLanguage): Record<string, unknown> {
  if (!whisperModelFor(language).multilingual) return {}
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
