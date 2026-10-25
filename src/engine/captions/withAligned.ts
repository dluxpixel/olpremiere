// The one rule for the aligned flag of a word made out of several. It lives in a
// file of its own because both transcribe.ts (which merges numbers and stretched
// loops) and vocabulary.ts (which merges his rewrites) need it, and transcribe.ts
// pulls in the audio code at run time, which vocabulary.ts and its tests have no
// use for. The only thing taken from transcribe.ts here is a type, which is erased.

import type { TranscribedWord } from './transcribe'

/**
 * A word made of several is the aligner's only if EVERY part was. A number cut in
 * two ("30" and ",000") or a stretched loop mixes times from two sources, and
 * calling the mix aligned would hide the recogniser's half from the lag correction.
 * The key is left off rather than set false, so words the aligner never touched
 * compare equal to what they were before it existed.
 */
export function withAligned<T extends TranscribedWord>(word: T, parts: readonly TranscribedWord[]): T {
  const out: TranscribedWord = { ...word }
  if (parts.every((p) => p.aligned === true)) out.aligned = true
  else delete out.aligned
  return out as T
}
