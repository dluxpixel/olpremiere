// The misspellings he fixes, learned from every caption he corrected, and put
// right on their own the next time the model makes them.
//
// His words, 2026-10-03: *"every single time I caption something, it just
// doesn't turn out good ... the biggest problem is that it doesn't know how to
// spell [special] stuff. Sometimes it just goes something completely random."*
//
// MEASURED the same day on his six captioned projects (584 of his words): the
// largest group of word edits he made was NAMES, 30 words in 14 edits, every one
// a Battle Cats name the model had never seen: "Bamban", "Banban", "Bonbon" and
// "Mechabamban" for Bun Bun, "Cerraral" for Sir Rel, "Pteral" for Pterowl,
// "Ken" for Cancan Cat, "legendary" for Legend Rare.
//
// A misspelling the model made AND he fixed the same way at least
// FIX_CONFIDENCE times is replaced after the fact. That changes text without
// asking the model, so it gets the bar the style profile already uses
// (styleProfile.ts): twice, never once.
//
// ⛔ DELIBERATELY NOT DONE: handing his names to Whisper as a prompt. It is the
// textbook answer (OpenAI's own Whisper API takes a `prompt` for spellings) and
// it was built and measured on 2026-10-03, through the built app, on his six
// projects with each one held out from its own learning. It made things WORSE:
//   - as a list of names ("Bun Bun, Sir Rel.") 8.6% of his words wrong became
//     9.4%. Whisper copies the style of its prompt, and a list with no digits in
//     it made it write "5 hundred forty thousand" where he had said 540,000.
//   - as his own sentences around each name, 9.8%, and it DROPPED words: with
//     "we have Pterowl Hazuku" in the prompt, the model treated that line as
//     already said and left "Pterowl Hazuku" out of his GYM captions entirely.
//     Missing words are one of the things he is complaining about.
// The bigger model fixed names on its own (20 of 39 right became 27), and on
// footage held out from the learning the prompt added no name at all while
// costing words, so it stays out until a measurement says otherwise.
//
// ⛔ IT READS `captionOrigin`, the machine's words before he touched them, the
// same field the style learning is built on. Nothing here guesses what the
// model would have written.
//
// ⛔ AND IT IS PURE: clips in, rewrites out. Where the projects come from is
// state/captionVocabulary.ts.

import type { Clip } from '../types'
import { FIX_CONFIDENCE } from './styleProfile'
import type { TranscribedWord } from './transcribe'

/**
 * A caption's words as spoken, for comparing his text with the machine's: lower
 * case, no punctuation, a stretched "pleaseeee" read as "please", a thousands
 * separator in any of the forms either side writes read as one number.
 */
export function spokenWords(text: string): string[] {
  let t = text.replace(/\([^)]*\)/g, ' ').replace(/[‘’ʼ]/g, "'").toLowerCase()
  for (let i = 0; i < 3; i++) t = t.replace(/(\d)\s*[,.]?\s*(\d{3})(?!\d)/g, '$1$2')
  t = t.replace(/[^\p{L}\p{N}'\s]/gu, ' ')
  const out: string[] = []
  for (const raw of t.split(/\s+/)) {
    const w = raw.replace(/^'+|'+$/g, '').replace(/(\p{L})\1{2,}/gu, '$1')
    if (w) out.push(w)
  }
  return out
}

/** One place the machine and he disagreed: what it heard, what he wrote. */
export interface Correction {
  heard: string[]
  his: string[]
}

/** Everything one project teaches. */
export interface ProjectCorrections {
  corrections: Correction[]
  /** Words the machine wrote that he left exactly as they were. */
  accepted: string[]
}

/**
 * Longest stretch of disagreement still read as a spelling. Past this it is a
 * sentence the model lost (his Green intro: eleven words came back as "I
 * mean"), which says nothing about how any one word is spelled.
 */
const MAX_PHRASE_WORDS = 4

/**
 * Read one project's captions into corrections.
 *
 * ⛔ ONE COPY PER MACHINE CAPTION. He splits a caption clip and retypes the
 * pieces, and every piece keeps the same `captionOrigin`: "ranking all" came
 * back three times holding "ranking", "the MOST" and "annoying bun buns". Read
 * three times, the machine would have said "ranking all" three times. A repeat
 * of the same origin that runs on from the last one is that same caption.
 *
 * ⛔ AND THE TWO SIDES ARE ALIGNED AS WORDS, NOT AS CLIPS, because his clips
 * and the machine's stopped lining up the moment he split one.
 */
export function correctionsFromClips(clips: readonly Clip[]): ProjectCorrections | null {
  const caps = clips
    .filter((c) => c.captionOrigin && c.title)
    .slice()
    .sort((a, b) => a.startS - b.startS)
  if (caps.length === 0) return null
  const machine: string[] = []
  let last: { origin: string; endS: number } | null = null
  for (const c of caps) {
    const origin = c.captionOrigin!.text
    const endS = c.startS + (c.outS - c.inS) / (Math.abs(c.speed) || 1)
    if (last && last.origin === origin && c.startS <= last.endS + 0.6) {
      last.endS = Math.max(last.endS, endS)
      continue
    }
    last = { origin, endS }
    machine.push(...spokenWords(origin))
  }
  const his = caps.flatMap((c) => spokenWords(c.title!.text))
  const ops = alignWords(his, machine)
  const corrections: Correction[] = []
  const accepted = new Set<string>()
  for (let k = 0; k < ops.length; ) {
    if (ops[k].op === 'same') {
      accepted.add(ops[k].his!)
      k++
      continue
    }
    let j = k
    while (j < ops.length && ops[j].op !== 'same') j++
    const run = ops.slice(k, j)
    const heard = run.flatMap((o) => (o.heard ? [o.heard] : []))
    const hisRun = run.flatMap((o) => (o.his ? [o.his] : []))
    if (hisRun.length > 0 && hisRun.length <= MAX_PHRASE_WORDS && heard.length <= MAX_PHRASE_WORDS) {
      corrections.push({ heard, his: hisRun })
    }
    k = j
  }
  return { corrections, accepted: [...accepted] }
}

interface AlignOp {
  op: 'same' | 'diff'
  his: string | null
  heard: string | null
}

/** Word alignment (edit distance with a backtrace), his words against the machine's. */
function alignWords(his: readonly string[], heard: readonly string[]): AlignOp[] {
  const n = his.length
  const m = heard.length
  const d: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[i - 1][j - 1] + (his[i - 1] === heard[j - 1] ? 0 : 1)
      d[i][j] = Math.min(sub, d[i - 1][j] + 1, d[i][j - 1] + 1)
    }
  }
  const ops: AlignOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (his[i - 1] === heard[j - 1] ? 0 : 1)) {
      ops.push({ op: his[i - 1] === heard[j - 1] ? 'same' : 'diff', his: his[i - 1], heard: heard[j - 1] })
      i--
      j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: 'diff', his: his[i - 1], heard: null })
      i--
    } else {
      ops.push({ op: 'diff', his: null, heard: heard[j - 1] })
      j--
    }
  }
  return ops.reverse()
}

/** A misspelling he fixed the same way often enough to fix unasked. */
export interface Rewrite {
  heard: string[]
  his: string
  seen: number
}

export interface Vocabulary {
  /** Machine misspellings to replace, longest first so a phrase beats its parts. */
  rewrites: Rewrite[]
}

export const EMPTY_VOCABULARY: Vocabulary = { rewrites: [] }

const isNumber = (w: string): boolean => /\d/.test(w)

/**
 * Fold every project's corrections into the rewrites that are safe to apply.
 *
 * ⛔ ONLY A WORD HE HAS NEVER KEPT IS EVER REPLACED. The machine side must be
 * made only of words he has not once left standing in any caption, anywhere:
 * the model's own guess at something it does not know ("Bamban", "Cerraral"),
 * never an ordinary word he uses himself. Without that, "cool" fixed to
 * "cooldown" twice would rewrite every "cool" he ever says.
 *
 * Numbers are left out: "60" for "60000" is the split the number fix in
 * transcribe.ts repairs, not a word to learn.
 */
export function learnVocabulary(projects: readonly ProjectCorrections[]): Vocabulary {
  const accepted = new Set(projects.flatMap((p) => p.accepted))
  const seenFor = new Map<string, Map<string, number>>()
  for (const p of projects) {
    for (const c of p.corrections) {
      if (c.heard.length === 0 || c.his.some(isNumber) || c.heard.some(isNumber)) continue
      if (c.heard.some((w) => accepted.has(w))) continue
      const from = c.heard.join(' ')
      const to = c.his.join(' ')
      if (from === to) continue
      const byTo = seenFor.get(from) ?? new Map<string, number>()
      byTo.set(to, (byTo.get(to) ?? 0) + 1)
      seenFor.set(from, byTo)
    }
  }
  const rewrites: Rewrite[] = []
  for (const [from, byTo] of seenFor) {
    let to = ''
    let seen = 0
    let total = 0
    for (const [cand, n] of byTo) {
      total += n
      if (n > seen) {
        to = cand
        seen = n
      }
    }
    // Twice, and never against a second spelling of his. Same bar as the style
    // profile, for the same reason: this one changes text without asking.
    if (seen >= FIX_CONFIDENCE && seen === total) rewrites.push({ heard: from.split(' '), his: to, seen })
  }
  rewrites.sort((a, b) => b.heard.length - a.heard.length || b.seen - a.seen)
  return { rewrites }
}

/**
 * Replace the misspellings he has fixed the same way twice.
 *
 * A rewrite matches whole words in a row, said without a pause between them, and
 * collapses them into ONE word holding his spelling over the time they covered,
 * because that is how he writes it: "bun bun" was one caption every time. The
 * last word's closing punctuation is kept, so a sentence still ends where it did.
 */
export function applyRewrites<T extends TranscribedWord>(words: readonly T[], v: Vocabulary): T[] {
  if (v.rewrites.length === 0) return words.slice()
  const spoken = words.map((w) => spokenWords(w.text).join(' '))
  const out: T[] = []
  for (let i = 0; i < words.length; ) {
    let hit: { len: number; to: string } | null = null
    for (const r of v.rewrites) {
      const len = r.heard.length
      if (i + len > words.length) continue
      let ok = true
      for (let k = 0; k < len && ok; k++) {
        if (spoken[i + k] !== r.heard[k]) ok = false
        else if (k > 0 && words[i + k].startS - words[i + k - 1].endS > 0.3) ok = false
      }
      if (ok) {
        hit = { len, to: r.his }
        break
      }
    }
    if (!hit) {
      out.push(words[i])
      i++
      continue
    }
    const first = words[i]
    const lastWord = words[i + hit.len - 1]
    const tail = /[.,!?;:…]+$/.exec(lastWord.text)?.[0] ?? ''
    out.push({ ...first, text: hit.to + tail, endS: Math.max(first.endS, lastWord.endS) })
    i += hit.len
  }
  return out
}
