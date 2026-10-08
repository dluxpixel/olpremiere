// Captions from his own script, timed by the listening (CA-6).
//
// His Shorts are scripted, and the biggest group of his caption corrections
// was names the model had never heard: "Bamban" for Bun Bun, "Cerraral" for
// Sir Rel (vocabulary.ts). The script already spells every one of them right.
// So his words are laid down as written, and the recogniser is asked only WHEN
// each was said: his spelling, his punctuation, the measured timing.
//
// Pure: script and heard words in, timed script words out.

import type { CaptionWord } from './captions'
import { spokenWords } from './vocabulary'

/** A word as letters and digits only, for comparing what he wrote with what was heard. */
const bare = (text: string): string => spokenWords(text).join('')

/** Edit distance between two short strings, as a share of the longer: 0 same, 1 nothing alike. */
function unlike(a: string, b: string): number {
  if (a === b) return 0
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 1
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    const row = [i]
    for (let j = 1; j <= m; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[m]! / Math.max(n, m)
}

/** What a script word or heard word costs to leave unpaired. Any pairing costs at most this. */
const GAP = 1

/**
 * What heard words left unpaired INSIDE the script cost on top of GAP (S-1): a
 * little for each word, and a little more for the first of a run of them. A
 * line said in several takes ties between them to the last decimal, and a tie
 * used to go to the LAST take, or to a word from one take and its neighbours
 * from another. A skip between two words that are paired costs a little more
 * than one before the first or after the last, so a line is laid whole in one
 * take (the fewest words skipped between its own), and the first of equal takes wins.
 */
const SKIP_RUN = 1e-3
const SKIP_WORD = 1e-4

/** Costs closer than this are the same cost: sums of fractions differ in the last bits. */
const TIE = 1e-9

/** How unlike a written word and a heard word may be and still be the same word said. */
const SAME_WORD = 0.5

/**
 * What it costs to read one word as two run together (or two as one): only a
 * join that is really the same word said AND reads better than either half on
 * its own. Without that test a join is always cheap ("um now" is 0.4 unlike
 * "now"), so a filler word before a word, or a word the model missed before
 * the next one, was swallowed into the join and took its time.
 */
function joinCost(joined: number, halfA: number, halfB: number): number {
  return joined <= SAME_WORD && joined < Math.min(halfA, halfB) ? joined : Infinity
}

/** The shortest a script word the model missed is given, when there is room. */
const MISSED_WORD_S = 0.12

/**
 * The most script words in a row the model can have missed inside a line it
 * heard. More than this in a row were not said here (a line cut from the edit,
 * a hook moved elsewhere, script for another clip), unless the model heard
 * about as many words of its own right where they would be.
 */
const MISSED_RUN = 2

/**
 * Sounds said between words. They are heard, but they are never the model's
 * version of a word of his script, so they do not count towards a stretch it
 * "heard as about as many words of its own".
 */
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'eh', 'hm', 'hmm', 'mm', 'mmm', 'mhm', 'like'])

/** A direction in his script, never said: "[HOOK]", "[cut to the base]", "(laughs)". */
const DIRECTION = /\[[^\]]*\]|\([^)]*\)/g

type Step = 'pair' | 'script' | 'oneTwo' | 'twoOne'

/** His script against what was heard: the words that were said here, timed, and what was not. */
export interface ScriptHeard {
  words: CaptionWord[]
  /** Lines of his script with no word heard in these clips, so with no caption. */
  unheardLines: number
  /** Words left out of lines that were otherwise heard. */
  unheardWords: number
}

/** {@link scriptHeard}, the timed words only. */
export function alignScript(script: string, heard: readonly CaptionWord[]): CaptionWord[] | null {
  return scriptHeard(script, heard)?.words ?? null
}

/**
 * His script, each word timed by what the recogniser heard. Null when nothing
 * in the script was heard at all (the wrong clip), so the caller can say so
 * instead of laying a script over somebody else's words.
 *
 * - A word heard as written (or close) takes the heard word's time.
 * - A word the model split ("mine draft" for "Minecraft") takes both.
 * - Two words the model ran together ("bamban" for "Bun Bun") share its time
 *   by letter count.
 * - One or two words the model missed in a line it heard, or a stretch it
 *   heard as other words, share the time between their neighbours, never
 *   outside the heard words around them.
 * - A heard word the script does not have is dropped: the script wins.
 * - A line said in several takes is laid in ONE of them, whole, and when the
 *   takes are equal it is the first (S-1). Never a word from one take with its
 *   neighbours from another, and never the last take by default.
 * - Anything in [square brackets] or (parentheses) is a direction ("[hook]",
 *   "(laughs)"), never said, so it is never captioned.
 *
 * ⛔ SCRIPT THAT WAS NOT HEARD IS NOT CAPTIONED (R-2). Every unpaired word used
 * to be given a time anyway: a whole script pasted with one clip selected laid
 * the rest of it 0.12 s a word over the clips either side, replacing their
 * captions; a line cut from the edit flashed for a frame, squeezed between
 * two words; a line cut at the end ran past the last word and made the
 * sequence longer. Now only the words heard here, and a word or two the model
 * missed inside a line it heard, are laid. What was left out is counted, by
 * line, so the caller can say so.
 *
 * The words are aligned in order, with a band around the diagonal so a long
 * voiceover costs a strip of the table and not all of it.
 */
export function scriptHeard(script: string, heard: readonly CaptionWord[]): ScriptHeard | null {
  // Punctuation standing on its own (", ", "...") rides on the word before it.
  // A direction keeps its line breaks, so the lines around it stay lines.
  const written: string[] = []
  const lineOf: number[] = []
  script
    .replace(DIRECTION, (d) => d.replace(/[^\n]+/g, ' '))
    .split('\n')
    .forEach((line, li) => {
      for (const token of line.split(/\s+/).filter(Boolean)) {
        if (bare(token) || written.length === 0) {
          written.push(token)
          lineOf.push(li)
        } else written[written.length - 1] += ` ${token}`
      }
    })
  const s = written.map(bare)
  const h = heard.map((w) => bare(w.text))
  const n = s.length
  const m = h.length
  if (n === 0 || m === 0) return null

  // Banded table: row i holds columns lo(i)..lo(i)+width-1 around the diagonal.
  //
  // Three kinds of last move, so a skip of heard words can be priced by where
  // it falls (S-1): a pairing or a script word left out (state A, whatever
  // moved last), and a heard word left out (state Y). The table keeps the best
  // cost of either, and one byte per cell for the walk back.
  const band = Math.max(64, Math.ceil(0.15 * Math.max(n, m)) + Math.abs(n - m))
  const width = 2 * band + 1
  const lo = (i: number): number => Math.round((i * m) / n) - band
  const cost = new Float64Array((n + 1) * width).fill(Infinity)
  // Bits 0-1: the move that reached state A here. Bit 2: the best here is state Y.
  // Bit 3: state Y here carried on a skip from the heard word before.
  const step = new Uint8Array((n + 1) * width)
  const STEPS: Step[] = ['pair', 'script', 'oneTwo', 'twoOne']
  const BEST_Y = 4
  const KEEP_Y = 8
  const at = (i: number, j: number): number => {
    const k = j - lo(i)
    return k >= 0 && k < width && j >= 0 && j <= m ? i * width + k : -1
  }
  const get = (i: number, j: number): number => {
    const x = at(i, j)
    return x < 0 ? Infinity : cost[x]!
  }
  for (let i = 0; i <= n; i++) {
    // State A and state Y of the cell to the left, in this row.
    let leftA = Infinity
    let leftY = Infinity
    for (let j = Math.max(0, lo(i)); j <= Math.min(m, lo(i) + width - 1); j++) {
      let a = Infinity
      let how = 0
      if (i === 0 && j === 0) a = 0
      else {
        const offer = (c: number, k: number): void => {
          if (c < a - TIE) {
            a = c
            how = k
          }
        }
        if (i > 0 && j > 0) offer(get(i - 1, j - 1) + unlike(s[i - 1]!, h[j - 1]!), 0)
        if (i > 0) offer(get(i - 1, j) + GAP, 1)
        if (i > 0 && j > 1) {
          const word = s[i - 1]!
          const join = joinCost(unlike(word, h[j - 2]! + h[j - 1]!), unlike(word, h[j - 2]!), unlike(word, h[j - 1]!))
          offer(get(i - 1, j - 2) + join, 2)
        }
        if (i > 1 && j > 0) {
          const word = h[j - 1]!
          const join = joinCost(unlike(s[i - 2]! + s[i - 1]!, word), unlike(s[i - 2]!, word), unlike(s[i - 1]!, word))
          offer(get(i - 2, j - 1) + join, 3)
        }
      }
      // A heard word left out. Before the first script word and after the last
      // it costs no more than GAP: those words are another take, not a gap.
      let y = Infinity
      let keep = 0
      if (j > 0) {
        const inside = i > 0 && i < n
        const begin = leftA + GAP + (inside ? SKIP_WORD + SKIP_RUN : 0)
        const carry = leftY + GAP + (inside ? SKIP_WORD : 0)
        if (carry <= begin + TIE) {
          y = carry
          keep = KEEP_Y
        } else y = begin
      }
      const x = at(i, j)
      // On a tie the heard word is the one left out, so the earliest take is the one used.
      const bestY = y <= a + TIE
      cost[x] = Math.min(a, y)
      step[x] = how | keep | (bestY ? BEST_Y : 0)
      leftA = a
      leftY = y
    }
  }
  if (!Number.isFinite(get(n, m))) return null

  // Walk back: which heard span each script word was given, if any. A heard
  // word the highlight picked passes its colour on to the word he wrote.
  type Span = { startS: number; endS: number; emphasis?: true }
  const span: (Span | null)[] = new Array(n).fill(null)
  // Which heard words each word he wrote was paired with: [from, to).
  const heardFrom = new Array<number>(n).fill(-1)
  const heardTo = new Array<number>(n).fill(-1)
  const took = (i: number, from: number, to: number): void => {
    heardFrom[i] = from
    heardTo[i] = to
  }
  const lit = (...ws: CaptionWord[]): { emphasis?: true } => (ws.some((w) => w.emphasis) ? { emphasis: true } : {})
  let paired = 0
  let inY = (step[at(n, m)]! & BEST_Y) !== 0
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const flags = step[at(i, j)]!
    if (inY) {
      // A heard word left out: the walk goes on in state Y if the skip carried on.
      inY = (flags & KEEP_Y) !== 0
      j--
      continue
    }
    const how = STEPS[flags & 3]!
    if (how === 'pair') {
      // Only a pairing that is really the same word counts as heard; a guess
      // across two different words is a missed word, timed by its neighbours.
      if (unlike(s[i - 1]!, h[j - 1]!) <= SAME_WORD) {
        span[i - 1] = { startS: heard[j - 1]!.startS, endS: heard[j - 1]!.endS, ...lit(heard[j - 1]!) }
        took(i - 1, j - 1, j)
        paired++
      }
      i--
      j--
    } else if (how === 'script') i--
    else if (how === 'oneTwo') {
      if (unlike(s[i - 1]!, h[j - 2]! + h[j - 1]!) <= SAME_WORD) {
        span[i - 1] = { startS: heard[j - 2]!.startS, endS: heard[j - 1]!.endS, ...lit(heard[j - 2]!, heard[j - 1]!) }
        took(i - 1, j - 2, j)
        paired++
      }
      i--
      j -= 2
    } else {
      if (unlike(s[i - 2]! + s[i - 1]!, h[j - 1]!) <= SAME_WORD) {
        const { startS, endS } = heard[j - 1]!
        const cut = startS + ((endS - startS) * s[i - 2]!.length) / Math.max(1, s[i - 2]!.length + s[i - 1]!.length)
        span[i - 2] = { startS, endS: cut, ...lit(heard[j - 1]!) }
        span[i - 1] = { startS: cut, endS, ...lit(heard[j - 1]!) }
        took(i - 2, j - 1, j)
        took(i - 1, j - 1, j)
        paired += 2
      }
      i -= 2
      j--
    }
    inY = (step[at(i, j)]! & BEST_Y) !== 0
  }
  if (paired === 0) return null

  // Which lines were heard at all: a missed word is only ever one of those.
  const lines = (lineOf[n - 1] ?? 0) + 1
  const heardIn = new Array<number>(lines).fill(0)
  for (let i = 0; i < n; i++) if (span[i]) heardIn[lineOf[i]!]!++

  // Words the model missed share the time between their neighbours, by letter
  // count. With no room there they take the back half of the word before (or,
  // with no word before, the front half of the word after), so every word he
  // wrote is on screen for a moment, none sits on another, and none is ever
  // timed outside the heard words around it.
  //
  // Missed means one or two words in a row, or, between two words that were
  // heard, a stretch the model heard as about as many words of its own
  // ("nthatswhen" for "and that's when"). More words than that, or words with
  // nothing heard where they would be, were not said here.
  const out: CaptionWord[] = []
  const laidIn = new Array<number>(lines).fill(0)
  for (let i = 0; i < n; ) {
    const got = span[i]
    if (got) {
      out.push({ text: written[i]!, ...got })
      laidIn[lineOf[i]!]!++
      i++
      continue
    }
    let k = i
    while (k < n && !span[k]) k++
    const run: number[] = []
    for (let q = i; q < k; q++) if (heardIn[lineOf[q]!]! > 0) run.push(q)
    let misheard = 0
    if (i > 0 && k < n) for (let q = heardTo[i - 1]!; q < heardFrom[k]!; q++) if (!FILLER.has(h[q]!)) misheard++
    const len = k - i
    const sameSize = misheard > 0 && Math.max(len, misheard) <= 2 * Math.min(len, misheard) + 1
    if ((len > MISSED_RUN && !sameSize) || run.length === 0) {
      // Not said here: no caption, and nothing squeezed or spilled.
      i = k
      continue
    }
    const before = out[out.length - 1]
    const after = span[k] ?? null
    const letters = run.map((q) => Math.max(1, bare(written[q]!).length))
    const total = letters.reduce((a, b) => a + b, 0)
    const want = MISSED_WORD_S * run.length
    let from: number
    let to: number
    if (before && after) {
      from = before.endS
      to = after.startS
      if (to - from < want) {
        // Borrow from the word before, never past the middle of it.
        from = Math.max(before.startS + (before.endS - before.startS) / 2, to - want)
        before.endS = from
      }
    } else if (before) {
      // The last words: the back of the word before, never past where it ends.
      to = before.endS
      from = Math.max(before.startS + (before.endS - before.startS) / 2, to - want)
      before.endS = from
    } else {
      // The first words: the front of the word after, never before it starts.
      from = after!.startS
      to = Math.min(after!.startS + (after!.endS - after!.startS) / 2, from + want)
      after!.startS = to
    }
    if (to <= from) to = from + want
    let t = from
    run.forEach((q, r) => {
      const len = ((to - from) * letters[r]!) / total
      out.push({ text: written[q]!, startS: t, endS: t + len })
      laidIn[lineOf[q]!]!++
      t += len
    })
    i = k
  }
  // A line with no word laid was not heard. Words left out of a heard line are counted on their own.
  const wordsIn = new Array<number>(lines).fill(0)
  for (const li of lineOf) wordsIn[li]!++
  let unheardLines = 0
  let inUnheard = 0
  for (let li = 0; li < lines; li++) {
    if (wordsIn[li] === 0 || laidIn[li]! > 0) continue
    unheardLines++
    inUnheard += wordsIn[li]!
  }
  return { words: out, unheardLines, unheardWords: n - out.length - inUnheard }
}

/** A stretch of the timeline one clip sits in. */
export interface Take {
  startS: number
  endS: number
}

const startsIn = (w: CaptionWord, t: Take): boolean => w.startS >= t.startS - 1e-9 && w.startS < t.endS - 1e-9

/**
 * Which takes his script really landed in (S-1), and only those. The alignment
 * is a best guess over every take at once, so a line said in one take can leave
 * a stray word in another: one "right" or "so" of the script that the model also
 * heard somewhere in a take of ad-libbing. That take is not the script's, yet a
 * caption laid in it replaces the captions the take had.
 *
 * A take is HIT when at least two words were laid in it, or when it is a short
 * take the script is about: it has a word laid and at least half of what was
 * heard in it was laid. When no take is hit the ones with the most words laid are
 * used, so a run never drops the whole of what the script found. The words laid
 * in a take that is not hit are dropped, and counted, because laying one would
 * end the caption it lands inside early.
 */
export function keepHitTakes(
  laid: readonly CaptionWord[],
  heard: readonly CaptionWord[],
  takes: readonly Take[],
): { words: CaptionWord[]; dropped: number } {
  const laidIn = takes.map((t) => laid.filter((w) => startsIn(w, t)).length)
  const heardIn = takes.map((t) => heard.filter((w) => startsIn(w, t)).length)
  let hit = takes.map((_, i) => laidIn[i]! >= 2 || (laidIn[i]! > 0 && laidIn[i]! * 2 >= heardIn[i]!))
  if (!hit.some(Boolean)) {
    const most = Math.max(...laidIn)
    hit = laidIn.map((n) => n === most && n > 0)
  }
  const words = laid.filter((w) => {
    const inside = takes.map((t, i) => (startsIn(w, t) ? i : -1)).filter((i) => i >= 0)
    return inside.length === 0 || inside.some((i) => hit[i])
  })
  return { words, dropped: laid.length - words.length }
}
