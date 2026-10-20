// Word pop: each word of a caption lights up in colour as it is said.
//
// His ask, 2026-10-08: captions where "each word lights up as said, colour and
// a small pop". The look is stored on the caption as `title.wordPop` (just the
// colour). Which word is lit depends on the TIME, so it is worked out at resolve
// time and handed to the rasterizer as a field a title already understands
// (`wordColors`). The word being said is lit in colour and, with the Word box,
// boxed, and with the size pop (`title.wordPopSize`, the peak, 1.15 is 15 percent
// bigger) it swells and settles back in a fifth of a second from the moment it
// starts: `popScaleAt` is that curve, and the size at this frame is handed to
// the rasterizer as `popWord`. The colour and the size each work alone.
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
import { splitWords } from '../types'
import { spreadWords } from './captions'

/** The lit colour a new Word pop style starts with: lime, not white and not the yellow punch. */
export const WORD_POP_COLOR = '#A3FF12'
/** The peak a new size pop starts with: 15 percent bigger at the top of the pop. */
export const WORD_POP_SIZE = 1.15
/** The pop rises for this long from the moment the word starts, then settles for as long again. */
const POP_RISE_S = 0.1
const POP_SETTLE_S = 0.1
/** A word he leaned on (`emphasis`) pops a third further than the others. */
const EMPHASIS_BOOST = 4 / 3
/** The size a frame is drawn at is rounded to this step, so frames that look the same share one raster. */
const SCALE_STEP = 0.005
/** A first word this close after the caption's start is said "at the start": the start went onto a frame. */
const FIRST_WORD_SLACK_S = 0.05

/** One word with the time it is said, in the clip's own content time. */
export interface PopWord {
  text: string
  startS: number
  endS: number
  /** He leaned on this word: it pops further. Copied from `clip.captionWords`. */
  emphasis?: boolean
}

/**
 * How big the word being said is drawn, `dtS` seconds after it started (in the
 * clip's own content time, the same clock as the word times). 1 before it starts.
 * Rises from 1 to `peak` over the first tenth of a second (ease out, so it jumps
 * and then slows), settles back to 1 over the next tenth (ease in and out), and is
 * exactly 1 from a fifth of a second on. A word he leaned on (`emphasis`) peaks a
 * third higher: 1 + (peak - 1) * 4/3. A peak of 1 or less, or not a number, is no
 * pop at all. Pure, and the only place the curve lives.
 */
export function popScaleAt(dtS: number, peak: number, emphasis = false): number {
  if (!(peak > 1) || !Number.isFinite(peak) || !(dtS >= 0)) return 1
  if (dtS >= POP_RISE_S + POP_SETTLE_S) return 1
  const top = emphasis ? 1 + (peak - 1) * EMPHASIS_BOOST : peak
  const swell = top - 1
  if (dtS <= POP_RISE_S) {
    const u = dtS / POP_RISE_S
    return 1 + swell * (1 - Math.pow(1 - u, 3))
  }
  const u = (dtS - POP_RISE_S) / POP_SETTLE_S
  return 1 + swell * (1 - (1 - Math.cos(Math.PI * u)) / 2)
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
  const tokens = splitWords(text)
  const said = clip.captionWords
  let words: PopWord[] = []
  if (tokens.length > 0) {
    if (said && said.length === tokens.length && said.every((w, i) => w.text === tokens[i])) {
      words = said.map((w) => ({
        text: w.text,
        startS: w.startS,
        endS: w.endS,
        ...(w.emphasis ? { emphasis: true } : {}),
      }))
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
// Bounded: a paused or scrubbed preview asks for arbitrary times. A pop adds a
// state per step of the swell (rounded to SCALE_STEP), so the cap leaves room for
// every word of a long caption to be visited a few times before it is cleared.
const derived = new WeakMap<TitleDef, Map<string, TitleDef>>()
/** Exported so the test can walk past it. */
export const DERIVED_CAP = 160

/**
 * The pop peak a title asks for, or 0 for none: only a finite number above 1 is a
 * pop (null, missing, 1, 0 and junk are all "no pop").
 */
function popPeakOf(title: TitleDef): number {
  const peak = title.wordPopSize
  return typeof peak === 'number' && Number.isFinite(peak) && peak > 1 ? peak : 0
}

/**
 * The title to draw for `clip` at content time `sourceTimeS`. The very same
 * object when the clip has no word pop, word box or size pop, is not a title, or
 * no word is being said yet (every other caption draws exactly as it always
 * did). Otherwise a copy that marks the word being said:
 *   wordPop      that word in the pop colour
 *   wordBox      `boxWord`, the word the rounded box is drawn around (the raster
 *                draws it behind the letters and never moves a word)
 *   wordPopSize  `popWord`, the word and how big it is drawn this frame (the
 *                raster scales it about its own centre and leaves every other
 *                word where it was). Only while it is bigger than 1: once the
 *                pop has settled the title is the plain one again.
 * The three work alone or together.
 *
 * Only the word being said is marked: it goes back to normal as the next word
 * starts, because a trail of marked words would hide which one is being said. It
 * takes the pop colour even when it is a word he leaned on.
 *
 * The size is worked out at the frame's OWN time (the time resolve hands in), so
 * the motion blur samples inside one frame all see the same word size: no smear.
 */
export function wordPopTitle(clip: Clip, sourceTimeS: number): TitleDef | undefined {
  const title = clip.title
  if (!title || title.invertBackdrop) return title
  const peak = popPeakOf(title)
  if (!(title.wordPop || title.wordBox || peak)) return title
  const words = popWordsFor(clip)
  const at = activeWordAt(words, sourceTimeS)
  if (at < 0) return title
  const word = words[at]!
  const pop = title.wordPop
  // The size this frame, in whole SCALE_STEPs above 1 (0 is "not popped now").
  const steps = peak ? Math.round((popScaleAt(sourceTimeS - word.startS, peak, word.emphasis) - 1) / SCALE_STEP) : 0
  // A size pop alone, between pops: nothing differs from the plain title, so hand it back as it is.
  if (steps <= 0 && !pop && !title.wordBox) return title
  // One state per word and step, not one per frame, so frames that look the same hit the same raster.
  const key = `${at}|${word.text}|${steps}`
  let byState = derived.get(title)
  const known = byState?.get(key)
  if (known) return known
  if (!byState) {
    byState = new Map()
    derived.set(title, byState)
  } else if (byState.size >= DERIVED_CAP) {
    byState.clear()
  }
  // Rounded to the thousandth so the step does not carry float dust into the cache key.
  const scale = steps > 0 ? Math.round((1 + steps * SCALE_STEP) * 1000) / 1000 : 1
  const next: TitleDef = {
    ...title,
    ...(pop
      ? {
          // Last, so the word being said wears the pop colour over any highlight it had.
          wordColors: [...(title.wordColors ?? []), { at, word: word.text, color: pop.color || WORD_POP_COLOR }],
        }
      : {}),
    ...(title.wordBox ? { boxWord: { at, word: word.text } } : {}),
    ...(scale > 1 ? { popWord: { at, word: word.text, scale } } : {}),
  }
  byState.set(key, next)
  return next
}
