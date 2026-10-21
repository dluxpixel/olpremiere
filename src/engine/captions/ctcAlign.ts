// Exact word timing from a CTC forced aligner. PURE: no model, no audio, only
// the maths on a table of per-frame log probabilities, so it is tested on
// made-up tables (ctcAlign.test.ts) and the model code lives in alignRunner.ts.
//
// WHY THIS EXISTS. Whisper's own word times (the cross-attention ones) run
// about 0.19 s late and wander, which wordTiming.correctWordLag only averages
// away. A wav2vec2 CTC model is trained to put each letter at a frame, so
// forcing the words Whisper already heard through it gives each word's onset
// to within a frame or two, and `aligned` words skip the blanket lag
// correction. The text is the recogniser's, the times are the aligner's.
//
// The lattice is the one torchaudio's forced_align uses: 2L+1 states, a blank
// between every token, so a doubled letter ("ll") MUST have a blank between
// its two copies, and a token may be skipped over only into a DIFFERENT token.
// Memory is one byte per (frame, state) for the backpointers, so a window of
// 20 s and 400 states is under a megabyte; alignmentWindows is what keeps a
// long recording from ever making one big table.

/** Seconds per model frame: wav2vec2's convolutional stride is 320 samples at 16 kHz. */
export const FRAME_S = 0.02

/** A token that stands for "speech I could not spell": scored per frame, see forcedAlign. */
export const STAR = -1

/** The lattice is T x S bytes; past this many cells the window is refused (about 64 MB). */
const MAX_LATTICE_CELLS = 64_000_000

// The numbers below are the ones MEASURED in _verify/aligner (see the figures
// in transcribeConfig.ts), kept here so the test and the worker share them.

/** How far below the best any-letter score a star frame is scored (log prob). */
export const STAR_PENALTY = 0.5
/** A word that moves more than this from the recogniser's time is not trusted. */
export const MAX_SHIFT_S = 1
/** A window whose letters average below this log prob was not the audio it was given. */
export const WINDOW_FLOOR = -3
/**
 * Seconds added to every aligned time. The CTC spike for a letter sits a little
 * inside the letter, so onsets come out late by a constant; measured value in
 * the note above BIAS_S's use in alignWords.
 */
export const ONSET_BIAS_S = 0

/** A window is at most this long, padding included. */
export const WINDOW_MAX_S = 20
/** Audio kept on each side of a window's words, so the first and last letter are whole. */
export const WINDOW_PAD_S = 1

// ---------------------------------------------------------------- vocabulary

/** What the aligner needs of a CTC model's character vocabulary. */
export interface AlignVocab {
  /** One-character tokens to their ids (the blank and the delimiter excluded). */
  ids: ReadonlyMap<string, number>
  blankId: number
  /** The word delimiter token ("|"), or null for a vocabulary without one. */
  delimiterId: number | null
  /** The case the vocabulary spells in: base-960h is capitals only. */
  fold: 'lower' | 'upper'
}

/**
 * Reads a model's vocab.json. `blank` is the blank token's text ("<pad>" for
 * base-960h, "[PAD]" for the multilingual one). The case defaults to the
 * lower case when the vocabulary has an "a", capitals otherwise.
 */
export function makeAlignVocab(
  vocab: Readonly<Record<string, number>>,
  blank: string,
  delimiter = '|',
  fold?: 'lower' | 'upper',
): AlignVocab {
  const blankId = vocab[blank]
  if (typeof blankId !== 'number') throw new Error(`The aligner vocabulary has no ${blank} token`)
  const delimiterId = typeof vocab[delimiter] === 'number' ? vocab[delimiter] : null
  const ids = new Map<string, number>()
  for (const [tok, id] of Object.entries(vocab)) {
    if (id === blankId || id === delimiterId) continue
    if ([...tok].length === 1) ids.set(tok, id)
  }
  return { ids, blankId, delimiterId, fold: fold ?? (ids.has('a') ? 'lower' : 'upper') }
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/** True for a chunk with nothing to say aloud: "-", "...", "?" . */
export function isSilentText(text: string): boolean {
  return !WORD_CHAR.test(text)
}

/**
 * The token ids that spell a word, or null when no sound can be read off its
 * letters (digits, symbols, emoji: "2026" is "twenty twenty six" aloud).
 * Punctuation is dropped, typographic apostrophes are plain ones, and an
 * apostrophe or an accent the vocabulary lacks is dropped or reduced to its
 * base letter ("don't" is "dont" in a vocabulary with no apostrophe).
 */
export function vocabTokens(word: string, vocab: AlignVocab): number[] | null {
  // A digit anywhere means the letters are not the whole sound ("mp3", "4K").
  if (/\p{N}/u.test(word)) return null
  const clean = word.normalize('NFC').replace(/[‘’ʼ´`]/g, "'")
  const cased = vocab.fold === 'lower' ? clean.toLowerCase() : clean.toUpperCase()
  const out: number[] = []
  for (const ch of cased) {
    const direct = vocab.ids.get(ch)
    if (direct !== undefined && (ch === "'" || /[\p{L}\p{M}]/u.test(ch))) {
      out.push(direct)
      continue
    }
    if (!/\p{L}/u.test(ch)) continue
    // A letter the vocabulary lacks: its base letter if it has one ("é" to "e").
    for (const base of ch.normalize('NFD').replace(/\p{M}+/gu, '')) {
      const id = vocab.ids.get(base)
      if (id !== undefined) out.push(id)
    }
  }
  return out.length > 0 ? out : null
}

// ------------------------------------------------------------ forced aligner

/** Frames a token holds: [start, end). */
export interface TokenSpan {
  start: number
  end: number
}

export interface ForcedAlignment {
  spans: TokenSpan[]
  /** Mean log prob over each token's frames; NaN for a star (it has no letter to score). */
  scores: number[]
}

/**
 * CTC Viterbi: the best path that says `tokens` in order over T frames of
 * V-wide log probabilities (row-major, frame by frame), blanks between.
 *
 * A STAR token stands for speech with no spelling. It is scored per frame as
 * the best ANY-token log prob minus `starPenalty`, so it is cheap wherever
 * something is being said or nothing is, and always a little worse than a real
 * letter that fits. Blank is in that maximum on purpose: with the best
 * NON-blank score instead a star was cheapest on a letter's spike, so the star
 * at a window's edge stole the first word's first letter out of silent padding
 * (measured, _verify/aligner), pushing that onset late.
 *
 * Returns null when there is no path (too few frames for the tokens) or the
 * table would be too big.
 */
export function forcedAlign(
  logProbs: Float32Array,
  T: number,
  V: number,
  tokens: readonly number[],
  blankId: number,
  starPenalty = STAR_PENALTY,
): ForcedAlignment | null {
  const L = tokens.length
  if (L === 0 || T <= 0) return null
  const S = 2 * L + 1
  if (T * S > MAX_LATTICE_CELLS || logProbs.length < T * V) return null

  let starRow: Float32Array | null = null
  if (tokens.includes(STAR)) {
    starRow = new Float32Array(T)
    for (let t = 0; t < T; t++) {
      let best = -Infinity
      for (let v = 0, o = t * V; v < V; v++) if (logProbs[o + v] > best) best = logProbs[o + v]
      starRow[t] = best - starPenalty
    }
  }
  // A skip from token k-1 to token k (over the blank) needs them to differ;
  // a star differs from everything.
  const canSkip = new Uint8Array(L)
  for (let k = 1; k < L; k++) canSkip[k] = tokens[k] === STAR || tokens[k - 1] === STAR || tokens[k] !== tokens[k - 1] ? 1 : 0

  const emit = (t: number, s: number): number => {
    if ((s & 1) === 0) return logProbs[t * V + blankId]
    const tok = tokens[s >> 1]
    return tok === STAR ? starRow![t] : logProbs[t * V + tok]
  }

  // Backpointer per (frame, state): 0 stay, 1 from s-1, 2 from s-2.
  const back = new Uint8Array(T * S)
  let prev = new Float32Array(S).fill(-Infinity)
  let cur = new Float32Array(S)
  prev[0] = emit(0, 0)
  prev[1] = emit(0, 1)
  for (let t = 1; t < T; t++) {
    const row = t * S
    for (let s = 0; s < S; s++) {
      let best = prev[s]
      let code = 0
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1]
        code = 1
      }
      if (s >= 2 && (s & 1) === 1 && canSkip[s >> 1] === 1 && prev[s - 2] > best) {
        best = prev[s - 2]
        code = 2
      }
      cur[s] = best + emit(t, s)
      back[row + s] = code
    }
    const swap = prev
    prev = cur
    cur = swap
  }

  // The path ends on the last token or the blank after it.
  let state = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2
  if (!(prev[state] > -Infinity)) return null

  const spans: TokenSpan[] = tokens.map(() => ({ start: -1, end: -1 }))
  const sums = new Float64Array(L)
  const counts = new Uint32Array(L)
  for (let t = T - 1; t >= 0; t--) {
    if ((state & 1) === 1) {
      const k = state >> 1
      spans[k].start = t
      if (spans[k].end < 0) spans[k].end = t + 1
      sums[k] += emit(t, state)
      counts[k]++
    }
    if (t > 0) state -= back[t * S + state]
  }
  const scores = tokens.map((tok, k) => (tok === STAR || counts[k] === 0 ? Number.NaN : sums[k] / counts[k]))
  return { spans, scores }
}

// --------------------------------------------------------------- the windows

/** A word as the recogniser timed it (seconds into the recording). */
export interface RoughWord {
  startS: number
  endS: number
}

/** Words [first, end) are aligned against the audio from fromS to toS. */
export interface AlignWindow {
  first: number
  end: number
  fromS: number
  toS: number
}

/**
 * Cuts a recording's words into windows of at most `maxS` seconds, padded
 * `padS` each side, so no table is ever larger than one window. A window ends
 * at the biggest gap between rough word times it can (the pause is where an
 * edge does the least harm), and never smaller than half full unless the
 * recording ends. Every word belongs to exactly one window.
 */
export function alignmentWindows(
  words: readonly RoughWord[],
  durationS: number,
  opts: { maxS?: number; padS?: number } = {},
): AlignWindow[] {
  const maxS = opts.maxS ?? WINDOW_MAX_S
  const padS = opts.padS ?? WINDOW_PAD_S
  const n = words.length
  if (n === 0) return []
  const budget = Math.max(1, maxS - 2 * padS)

  // Rough times can overlap or run backwards by a hair: make the starts
  // non-decreasing and the ends a running maximum so gaps are never negative.
  const st = new Float64Array(n)
  const en = new Float64Array(n)
  let reach = 0
  for (let i = 0; i < n; i++) {
    st[i] = Math.max(words[i].startS, i > 0 ? st[i - 1] : 0)
    reach = Math.max(reach, words[i].endS, st[i])
    en[i] = reach
  }

  const out: AlignWindow[] = []
  let a = 0
  while (a < n) {
    let b = a + 1
    while (b < n && en[b] - st[a] <= budget) b++
    let cut = b
    if (b < n) {
      let bestGap = -1
      for (let k = b; k > a; k--) {
        if (k < b && en[k - 1] - st[a] < budget / 2) break
        const gap = st[k] - en[k - 1]
        if (gap > bestGap) {
          bestGap = gap
          cut = k
        }
      }
    }
    const fromS = Math.max(0, st[a] - padS)
    const toS = Math.max(fromS, Math.min(durationS, en[cut - 1] + padS, fromS + maxS * 1.5))
    out.push({ first: a, end: cut, fromS, toS })
    a = cut
  }
  return out
}

// ------------------------------------------------------------- word timings

/** One window's model output: T frames of V log probabilities, row-major. */
export interface Emissions {
  logProbs: Float32Array
  T: number
  V: number
}

export interface AlignInput extends RoughWord {
  text: string
}

export interface AlignedWord extends RoughWord {
  /** True when the time is the aligner's; false keeps the recogniser's. */
  aligned: boolean
}

export interface AlignOpts {
  starPenalty?: number
  maxShiftS?: number
  floor?: number
  biasS?: number
}

export interface WindowAlignment {
  words: AlignedWord[]
  /** Mean log prob over the window's letters, null when nothing was aligned. */
  meanLogProb: number | null
}

/**
 * Times the words of one window. `windowStartS` is where the emissions' first
 * frame sits in the recording; `frameS` is the seconds per frame.
 *
 * A word's start is the first frame of its first letter and its end the frame
 * after its last letter. A word with no spelling (a number) is a star, and gets
 * the stretch between its neighbours. Words are kept at the recogniser's time,
 * not aligned, when:
 *   - the chunk has nothing to say aloud (punctuation only);
 *   - it moved more than `maxShiftS` from the recogniser's time (the alignment
 *     latched onto other speech);
 *   - the whole window's letters average below `floor` (the audio was not the
 *     words), or no path exists.
 */
export function alignWords(
  words: readonly AlignInput[],
  emissions: Emissions,
  frameS: number,
  windowStartS: number,
  vocab: AlignVocab,
  opts: AlignOpts = {},
): WindowAlignment {
  const maxShift = opts.maxShiftS ?? MAX_SHIFT_S
  const floor = opts.floor ?? WINDOW_FLOOR
  const bias = opts.biasS ?? ONSET_BIAS_S
  const unaligned = (): WindowAlignment => ({
    words: words.map((w) => ({ startS: w.startS, endS: w.endS, aligned: false })),
    meanLogProb: null,
  })

  // The token sequence: a star at each edge to take the neighbours' speech in
  // the padding, then the words with the delimiter between them.
  const tokens: number[] = [STAR]
  const ranges: ({ from: number; to: number; star: boolean } | null)[] = []
  const letterTokens: number[] = []
  let spoken = 0
  for (const w of words) {
    if (isSilentText(w.text)) {
      ranges.push(null)
      continue
    }
    if (spoken > 0 && vocab.delimiterId !== null) tokens.push(vocab.delimiterId)
    spoken++
    const ids = vocabTokens(w.text, vocab)
    const from = tokens.length
    if (ids === null) tokens.push(STAR)
    else {
      for (const id of ids) {
        letterTokens.push(tokens.length)
        tokens.push(id)
      }
    }
    ranges.push({ from, to: tokens.length, star: ids === null })
  }
  tokens.push(STAR)
  if (spoken === 0) return unaligned()

  const path = forcedAlign(emissions.logProbs, emissions.T, emissions.V, tokens, vocab.blankId, opts.starPenalty)
  if (!path) return unaligned()

  let meanLogProb: number | null = null
  if (letterTokens.length > 0) {
    let sum = 0
    for (const k of letterTokens) sum += path.scores[k]
    meanLogProb = sum / letterTokens.length
    if (!(meanLogProb >= floor)) return { ...unaligned(), meanLogProb }
  }

  const out: AlignedWord[] = words.map((w, i) => {
    const r = ranges[i]
    if (!r) return { startS: w.startS, endS: w.endS, aligned: false }
    const startS = windowStartS + path.spans[r.from].start * frameS + bias
    const endS = windowStartS + path.spans[r.to - 1].end * frameS + bias
    if (!(Math.abs(startS - w.startS) <= maxShift)) return { startS: w.startS, endS: w.endS, aligned: false }
    return { startS, endS, aligned: true }
  })

  // A word kept at the recogniser's time must not run over an aligned word that follows.
  for (let i = out.length - 2; i >= 0; i--) {
    const next = out[i + 1]
    if (!out[i].aligned && next.aligned && out[i].endS > next.startS) {
      out[i] = { ...out[i], endS: Math.max(out[i].startS, next.startS) }
    }
  }
  return { words: out, meanLogProb }
}
