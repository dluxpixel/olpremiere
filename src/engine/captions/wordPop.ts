// Word pop: each word of a caption lights up in colour as it is said.
//
// His ask, 2026-10-08: captions where "each word lights up as said, colour and
// a small pop". The look is stored on the caption as `title.wordPop` (just the
// colour). Which word is lit depends on the TIME, so it is worked out at resolve
// time and handed to the rasterizer as a field a title already understands
// (`wordColors`). The word being said is lit in colour and, with the Word box,
// boxed. A size pop is not drawn yet.
//
// The word box (his ask, 2026-10-19, off a frame of a Short) rides on the same
// clock: `title.wordBox` is stored, and the word it goes round right now is
// `boxWord`, set here and nowhere else. It works with or without the pop.
//
// ⛔ DECIDED IN ONE PLACE. `layerFor` in render/resolve.ts is the only caller of
// wordPopTitle, and the monitor and the export worker both draw layer.title, so
// what he sees in the preview is what the file gets. Nothing else may call
// activeWordAt (a test reads the source to hold that line).

import type { Clip, TitleDef } from '../types'
import { spreadWords } from './captions'

/** The lit colour a new Word pop style starts with: lime, not white and not the yellow punch. */
export const WORD_POP_COLOR = '#A3FF12'
/** A first word this close after the caption's start is said "at the start": the start went onto a frame. */
const FIRST_WORD_SLACK_S = 0.05

/** One word with the time it is said, in the clip's own content time. */
export interface PopWord {
  text: string
  startS: number
  endS: number
}

/**
 * Which word is being said at content time `t`: the last one that has started,
 * or -1 before the first. A word stays lit through a gap until the next one
 * starts, and when a zero length word and a real one start at the same instant
 * the real one wins. Works on words in any order.
 */
export function activeWordAt(words: readonly { startS: number; endS: number }[], t: number): number {
  let best = -1
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!(w.startS <= t)) continue
    if (best < 0) {
      best = i
      continue
    }
    const b = words[best]!
    if (w.startS > b.startS) best = i
    else if (w.startS === b.startS) {
      const wReal = w.endS > w.startS
      const bReal = b.endS > b.startS
      if (wReal || !bReal) best = i
    }
  }
  return best
}

interface WordsMemo {
  text: string
  said: Clip['captionWords']
  inS: number
  outS: number
  words: PopWord[]
}
const wordsMemo = new WeakMap<Clip, WordsMemo>()

/**
 * The words a caption says, in the clip's own content time. The times he said
 * them (captionWords) are trusted only while the caption still reads exactly
 * those words; a retyped caption has its words spread across it by letter count
 * instead, the way the manual split does. Memoised per clip.
 */
export function popWordsFor(clip: Clip): PopWord[] {
  const text = clip.title?.text ?? ''
  const hit = wordsMemo.get(clip)
  if (hit && hit.text === text && hit.said === clip.captionWords && hit.inS === clip.inS && hit.outS === clip.outS) {
    return hit.words
  }
  const tokens = text.split(/\s+/).filter(Boolean)
  const said = clip.captionWords
  let words: PopWord[] = []
  if (tokens.length > 0) {
    if (said && said.length === tokens.length && said.every((w, i) => w.text === tokens[i])) {
      words = said.map((w) => ({ text: w.text, startS: w.startS, endS: w.endS }))
      // The first word may start a hair after the caption: its start went onto a frame.
      const first = words[0]!
      if (first.startS > clip.inS && first.startS - clip.inS <= FIRST_WORD_SLACK_S) {
        words[0] = { ...first, startS: clip.inS }
      }
    } else {
      words = spreadWords(text, clip.inS, clip.outS - clip.inS).map((w) => ({ text: w.text, startS: w.startS, endS: w.endS }))
    }
  }
  wordsMemo.set(clip, { text, said: clip.captionWords, inS: clip.inS, outS: clip.outS, words })
  return words
}

// One derived title per (title, lit word), so two frames in the same state
// hand the rasterizer the SAME object and it never draws the same word twice.
// Bounded: a paused or scrubbed preview asks for arbitrary times.
const derived = new WeakMap<TitleDef, Map<string, TitleDef>>()
const DERIVED_CAP = 48

/**
 * The title to draw for `clip` at content time `sourceTimeS`. The very same
 * object when the clip has neither a word pop nor a word box, is not a title, or
 * no word is being said yet (every other caption draws exactly as it always
 * did). Otherwise a copy that marks the word being said:
 *   wordPop   that word in the pop colour
 *   wordBox   `boxWord`, the word the rounded box is drawn around (the raster
 *             draws it behind the letters and never moves a word)
 * The two work alone or together.
 *
 * Only the word being said is marked: it goes back to normal as the next word
 * starts, because a trail of marked words would hide which one is being said. It
 * takes the pop colour even when it is a word he leaned on.
 */
export function wordPopTitle(clip: Clip, sourceTimeS: number): TitleDef | undefined {
  const title = clip.title
  if (!title || title.invertBackdrop || !(title.wordPop || title.wordBox)) return title
  const words = popWordsFor(clip)
  const at = activeWordAt(words, sourceTimeS)
  if (at < 0) return title
  const word = words[at]!
  const pop = title.wordPop
  // One state per word, not one per frame, so every frame of a word hits the same raster.
  const key = `${at}|${word.text}`
  let byState = derived.get(title)
  const known = byState?.get(key)
  if (known) return known
  if (!byState) {
    byState = new Map()
    derived.set(title, byState)
  } else if (byState.size >= DERIVED_CAP) {
    byState.clear()
  }
  const next: TitleDef = {
    ...title,
    ...(pop
      ? {
          // Last, so the word being said wears the pop colour over any highlight it had.
          wordColors: [...(title.wordColors ?? []), { at, word: word.text, color: pop.color || WORD_POP_COLOR }],
        }
      : {}),
    ...(title.wordBox ? { boxWord: { at, word: word.text } } : {}),
  }
  byState.set(key, next)
  return next
}
