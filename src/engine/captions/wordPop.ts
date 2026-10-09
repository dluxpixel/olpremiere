// Word pop: each word of a caption lights up as it is said and pops a little.
//
// His ask, 2026-10-08: captions where "each word lights up as said, colour and
// a small pop". The look is stored on the caption as `title.wordPop` (just the
// colour). Which word is lit, and how big it is right now, depends on the TIME,
// so it is worked out at resolve time and handed to the rasterizer as the two
// fields a title already understands (`wordColors`) or now does (`wordScales`).
//
// ⛔ DECIDED IN ONE PLACE. `layerFor` in render/resolve.ts is the only caller of
// wordPopTitle, and the monitor and the export worker both draw layer.title, so
// what he sees in the preview is what the file gets. Nothing else may call
// activeWordAt or popScaleAt (a test reads the source to hold that line).

import type { Clip, TitleDef } from '../types'
import { spreadWords } from './captions'

/** How much bigger the word being said is drawn, at the top of its pop. */
export const WORD_POP_SCALE = 1.12
/** How long the pop takes to reach full size, timeline seconds. */
export const WORD_POP_RISE_S = 0.09
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

/**
 * How big the word is `sinceStartS` after it started: eases out from 1 to
 * WORD_POP_SCALE over WORD_POP_RISE_S, then holds. Before the word (negative or
 * not a number) it is 1. Rounded to 3 decimals so two frames that look the same
 * share one raster.
 */
export function popScaleAt(sinceStartS: number): number {
  if (!(sinceStartS > 0)) return 1
  const p = Math.min(1, sinceStartS / WORD_POP_RISE_S)
  const eased = 1 - (1 - p) * (1 - p) * (1 - p)
  return Math.round((1 + (WORD_POP_SCALE - 1) * eased) * 1000) / 1000
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

// One derived title per (title, lit word, scale), so two frames in the same state
// hand the rasterizer the SAME object and it never draws the same word twice.
// Bounded: a paused or scrubbed preview asks for arbitrary times.
const derived = new WeakMap<TitleDef, Map<string, TitleDef>>()
const DERIVED_CAP = 48

/**
 * The title to draw for `clip` at content time `sourceTimeS`. The very same
 * object when the clip has no word pop, is not a title, or no word is being said
 * yet (every other caption draws exactly as it always did). Otherwise a copy
 * with the word being said in the pop colour and, while it rises, its scale.
 *
 * Only the word being said is lit: it goes back to normal as the next word
 * starts, because a trail of lit words would hide which one is being said. It
 * takes the pop colour even when it is a word he leaned on.
 */
export function wordPopTitle(clip: Clip, sourceTimeS: number): TitleDef | undefined {
  const title = clip.title
  if (!title?.wordPop || title.invertBackdrop) return title
  const words = popWordsFor(clip)
  const at = activeWordAt(words, sourceTimeS)
  if (at < 0) return title
  const word = words[at]!
  const rate = Math.abs(clip.speed || 1)
  const scale = popScaleAt((sourceTimeS - word.startS) / rate)
  const key = `${at}|${word.text}|${scale}`
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
    // Last, so the word being said wears the pop colour over any highlight it had.
    wordColors: [...(title.wordColors ?? []), { at, word: word.text, color: title.wordPop.color || WORD_POP_COLOR }],
    ...(scale !== 1 ? { wordScales: [{ at, word: word.text, scale }] } : {}),
  }
  byState.set(key, next)
  return next
}
