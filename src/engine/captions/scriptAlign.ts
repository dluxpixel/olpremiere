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

type Step = 'pair' | 'script' | 'heard' | 'oneTwo' | 'twoOne'

/**
 * His script, each word timed by what the recogniser heard. Null when nothing
 * in the script was heard at all (the wrong clip), so the caller can say so
 * instead of laying a script over somebody else's words.
 *
 * - A word heard as written (or close) takes the heard word's time.
 * - A word the model split ("mine draft" for "Minecraft") takes both.
 * - Two words the model ran together ("bamban" for "Bun Bun") share its time
 *   by letter count.
 * - A word the model missed shares the time between its neighbours.
 * - A heard word the script does not have is dropped: the script wins.
 * - Anything in [square brackets] is a direction ("[hook]", "[cut to the
 *   base]"), never said, so it is never captioned.
 *
 * The words are aligned in order, with a band around the diagonal so a long
 * voiceover costs a strip of the table and not all of it.
 */
export function alignScript(script: string, heard: readonly CaptionWord[]): CaptionWord[] | null {
  // Punctuation standing on its own (", ", "...") rides on the word before it.
  const written: string[] = []
  for (const token of script.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean)) {
    if (bare(token) || written.length === 0) written.push(token)
    else written[written.length - 1] += ` ${token}`
  }
  const s = written.map(bare)
  const h = heard.map((w) => bare(w.text))
  const n = s.length
  const m = h.length
  if (n === 0 || m === 0) return null

  // Banded table: row i holds columns lo(i)..lo(i)+width-1 around the diagonal.
  const band = Math.max(64, Math.ceil(0.15 * Math.max(n, m)) + Math.abs(n - m))
  const width = 2 * band + 1
  const lo = (i: number): number => Math.round((i * m) / n) - band
  const cost = new Float64Array((n + 1) * width).fill(Infinity)
  const step = new Uint8Array((n + 1) * width)
  const STEPS: Step[] = ['pair', 'script', 'heard', 'oneTwo', 'twoOne']
  const at = (i: number, j: number): number => {
    const k = j - lo(i)
    return k >= 0 && k < width && j >= 0 && j <= m ? i * width + k : -1
  }
  const get = (i: number, j: number): number => {
    const x = at(i, j)
    return x < 0 ? Infinity : cost[x]!
  }
  cost[at(0, 0)] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = Math.max(0, lo(i)); j <= Math.min(m, lo(i) + width - 1); j++) {
      if (i === 0 && j === 0) continue
      let best = Infinity
      let how = 0
      const offer = (c: number, k: number): void => {
        if (c < best) {
          best = c
          how = k
        }
      }
      if (i > 0 && j > 0) offer(get(i - 1, j - 1) + unlike(s[i - 1]!, h[j - 1]!), 0)
      if (i > 0) offer(get(i - 1, j) + GAP, 1)
      if (j > 0) offer(get(i, j - 1) + GAP, 2)
      if (i > 0 && j > 1) {
        const word = s[i - 1]!
        const join = joinCost(unlike(word, h[j - 2]! + h[j - 1]!), unlike(word, h[j - 2]!), unlike(word, h[j - 1]!))
        offer(get(i - 1, j - 2) + join, 3)
      }
      if (i > 1 && j > 0) {
        const word = h[j - 1]!
        const join = joinCost(unlike(s[i - 2]! + s[i - 1]!, word), unlike(s[i - 2]!, word), unlike(s[i - 1]!, word))
        offer(get(i - 2, j - 1) + join, 4)
      }
      const x = at(i, j)
      cost[x] = best
      step[x] = how
    }
  }
  if (!Number.isFinite(get(n, m))) return null

  // Walk back: which heard span each script word was given, if any. A heard
  // word the highlight picked passes its colour on to the word he wrote.
  type Span = { startS: number; endS: number; emphasis?: true }
  const span: (Span | null)[] = new Array(n).fill(null)
  const lit = (...ws: CaptionWord[]): { emphasis?: true } => (ws.some((w) => w.emphasis) ? { emphasis: true } : {})
  let paired = 0
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const how = STEPS[step[at(i, j)]!]!
    if (how === 'pair') {
      // Only a pairing that is really the same word counts as heard; a guess
      // across two different words is a missed word, timed by its neighbours.
      if (unlike(s[i - 1]!, h[j - 1]!) <= SAME_WORD) {
        span[i - 1] = { startS: heard[j - 1]!.startS, endS: heard[j - 1]!.endS, ...lit(heard[j - 1]!) }
        paired++
      }
      i--
      j--
    } else if (how === 'script') i--
    else if (how === 'heard') j--
    else if (how === 'oneTwo') {
      if (unlike(s[i - 1]!, h[j - 2]! + h[j - 1]!) <= SAME_WORD) {
        span[i - 1] = { startS: heard[j - 2]!.startS, endS: heard[j - 1]!.endS, ...lit(heard[j - 2]!, heard[j - 1]!) }
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
        paired += 2
      }
      i -= 2
      j--
    }
  }
  if (paired === 0) return null

  // A run of words the model missed shares the time between its neighbours,
  // by letter count. With no room there, it takes the back half of the word
  // before it (or, at the very start, the front half of the word after), so
  // every word he wrote is on screen for a moment and none sits on another.
  const out: CaptionWord[] = []
  for (let i = 0; i < n; ) {
    const got = span[i]
    if (got) {
      out.push({ text: written[i]!, ...got })
      i++
      continue
    }
    let k = i
    while (k < n && !span[k]) k++
    const before = out[out.length - 1]
    const after = span[k] ?? null
    const letters = written.slice(i, k).map((w) => Math.max(1, bare(w).length))
    const total = letters.reduce((a, b) => a + b, 0)
    const want = MISSED_WORD_S * (k - i)
    let from = before ? before.endS : after ? Math.max(0, after.startS - want) : 0
    let to = after ? after.startS : from + want
    if (to - from < want && before) {
      // Borrow from the word before, never past the middle of it.
      from = Math.max(before.startS + (before.endS - before.startS) / 2, to - want)
      before.endS = from
    } else if (to - from < want && after) {
      // Nothing before: borrow from the word after, never past the middle of it.
      to = Math.min(after.startS + (after.endS - after.startS) / 2, from + want)
      after.startS = to
    }
    if (to <= from) to = from + want
    let t = from
    for (let q = i; q < k; q++) {
      const len = ((to - from) * letters[q - i]!) / total
      out.push({ text: written[q]!, startS: t, endS: t + len })
      t += len
    }
    i = k
  }
  return out
}
