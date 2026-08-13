// ONE highlighted word per caption phrase, picked off the voiceover itself.
//
// The gap this closes: `emphasis` has always been rendered (captions.ts colours
// an emphasis chunk, and `spreadWords` sets the flag from *asterisks* in a typed
// script), but the AUTO-caption path never set it once. He records a voiceover
// and hits auto caption, so every caption he has ever shipped came out flat on a
// feature the renderer already had.
//
// Pure: no React, no DOM, no store, no model. Words in, the same words out with
// at most one `emphasis` flag per phrase.
//
// ---------------------------------------------------------------------------
// WHY LOUDNESS, AND WHY ONLY JUST
//
// Measured 2026-08-09 on the one real human recording in this repo
// (_verify/vo-test.wav, 4.51 s, 11 words: "So I trapped him with a bed. And it
// actually worked."), run through the REAL pipeline in real Electron on the real
// GPU by `node _verify/word-emphasis.mjs`. What that run established, and every
// number below comes from it:
//
//   THE SIGNAL IS THERE, BARELY. Phrase loudness spreads were 5.5 dB (7 words)
//   and 1.4 dB (4 words), against a 0.9 to 1.1 dB measurement floor on a null
//   control whose words were levelled to be identical. So a long phrase carries
//   roughly 5 dB of usable range and a short one carries nothing at all. Any
//   design that cannot say "no highlight in this phrase" will invent one out of
//   1.4 dB of noise, which is why the bars below are set where they are.
//
//   DURATION IS DEAD, so it is not in here. Seconds per syllable picked a
//   function word in 12 of 14 phrases, ran the wrong way round (function 0.15
//   s/syl against content 0.14), and never caught an injected lean at any
//   threshold including +9 dB. Summing it with loudness as z scores was WORSE
//   than loudness alone: it fired on the null control 2 times out of 2.
//
//   FUNCTION WORDS ARE THE MAIN HAZARD. Raw loudness picks a function word in 7
//   of 14 phrases. Mean level was function +1.2 dB against content +2.7 dB, only
//   1.5 dB apart, so individual function words routinely beat content words: in
//   the real take "it" is louder than both "actually" and "worked." The veto is
//   mandatory, not a polish item.
//
//   AND THE BIG ONE, WHISPER'S WORD SPANS ARE NOT THE WORD. 31 of 77 measured
//   words carried a span that was over 40% not speech. "worked." was labelled
//   3.52 to 4.40 s when the take's audio stops at 3.60 s (checked outside this
//   code with ffmpeg volumedetect on 100 ms slices). Measured at face value it
//   reads -13.3 dB; measured on the aligned window it reads +1.8 dB. A 15.1 dB
//   error, landing on the LAST word of every phrase, which is where English
//   stress usually falls. Uncorrected it makes the payoff word of every sentence
//   look like the quietest thing in it. `bestLagS` below is the fix, and the lag
//   is NOT a constant (130 ms dry, 50 ms under one music bed, 130 ms under
//   another), so it is estimated per clip.
//
// HONEST LIMIT: one take, one speaker, 11 words, 2 phrases. The thresholds are
// deliberately conservative because of it. Record 30 s of his own voiceover into
// _verify/ and re-run that one command before loosening anything.

import { endsSentence, isFunctionWord, isSpeechWord, type CaptionWord } from './captions'

/**
 * The analysis window. 20 ms is short enough to sit inside a 100 ms word and
 * long enough that one glottal pulse cannot swing it, and it is the hop the
 * measurement harness used, so the numbers in this file mean what they say.
 */
export const ENVELOPE_HOP_S = 0.02

export interface EmphasisOptions {
  /**
   * A silence longer than this ends a phrase. MUST BE AT LEAST the `maxGapS` the
   * caller later passes to `chunkWords`, or the one-flag-per-block guarantee
   * breaks. The direction is easy to get backwards, so here it is spelled out:
   * the guarantee needs every phrase boundary to also be a BLOCK boundary. A
   * phrase ends at a gap over THIS number, a block breaks at a gap over the
   * chunker's, so a gap that sits between a smaller value here and a larger one
   * there would end a phrase in the MIDDLE of a block and put two highlights in
   * one caption. Equal is the right answer, and `emphasis.test.ts` pins it.
   * Defaults to the auto caption value, which is the only one in use.
   */
  maxGapS?: number
  /** The phrase needs at least this much loudness range before anything is picked, dB. */
  minSpreadDb?: number
  /** The winner must beat the runner-up CONTENT word by this much local contrast, dB. */
  minMarginDb?: number
  /** Shortest word (letters and digits only) that may carry the colour. */
  minChars?: number
  /** How far back the measurement window may slide to find the spoken word, seconds. */
  maxLagS?: number
}

/**
 * The shipping bars, straight off the threshold sweep.
 *
 *   loud local >=1.0 dB margin: fires 7/14 phrases, null control 0/2, catches
 *                               the +6 dB and +9 dB injected leans.
 *   loud local >=2.0 dB margin: fires 1/14, null 0/2, catches +9 dB only.
 *
 * 2.0 is what the measurement recommended shipping and it is what ships. It is
 * conservative on purpose: a plain caption block beats the wrong word sitting on
 * screen in yellow for the whole clip, and on the one real take measured it
 * highlights NOTHING. `minMarginDb: 1.5` is the first loosening to try once
 * there is footage of his own to watch it on (roughly 3 to 5 in 14, null still
 * clean), and it is one number in one place for exactly that reason.
 *
 * `minSpreadDb` 3 is the second gate and it is the one that kills the short
 * phrase: 1.4 dB of range over four words is indistinguishable from the 0.9 to
 * 1.1 dB floor the null control measured, so nothing there is real.
 */
/**
 * The silence that ends a PHRASE for the highlight picker.
 *
 * ⛔ THIS USED TO BE `AUTO_CAPTION_OPTIONS.maxGapS` AND IT CANNOT BE ANY MORE.
 * That number dropped to 0.05 on 2026-08-13 so a caption never spans one of his
 * pauses, and following it here would have cut his phrases at every comma:
 * measured on his own takes, about 34 phrases where there were 20, so a quarter
 * of every sentence would come out coloured instead of a sixth. The highlight is
 * meant to be the one word he leaned on.
 *
 * ⚠️ THE ONE-FLAG-PER-BLOCK GUARANTEE STILL HOLDS, and it is worth being sure
 * about because it is the reason these two ever shared a number. The rule needs
 * a phrase never to be SHORTER than a block. This is now LARGER than the
 * chunker's gap, so a phrase spans whole blocks instead of splitting one, one
 * flag per phrase still puts at most one flag in any block, and the invariant is
 * safer than it was rather than weaker.
 */
export const EMPHASIS_PHRASE_GAP_S = 0.25

export const EMPHASIS_DEFAULTS: Required<EmphasisOptions> = {
  maxGapS: EMPHASIS_PHRASE_GAP_S,
  minSpreadDb: 3,
  minMarginDb: 2,
  minChars: 3,
  maxLagS: 0.3,
}

/**
 * A level this far under the clip's own speech level is not a word, it is a
 * label sitting in silence. Not a tuning knob: the real aligned words in the
 * measured take ran -1.3 dB to +4.2 dB, so nothing genuine is anywhere near it.
 *
 * Such a word can never be picked, AND IT IS NOT A NEIGHBOUR EITHER. An earlier
 * draft kept it in the neighbour set on the grounds that "the neighbour
 * statistic is a median and a median shrugs off one outlier". That is false at
 * the edge of a phrase, and the test that proves it is `emphasis.test.ts >
 * a label with no sound behind it > never decides another word's contrast`:
 * with a clipped window the first word of a phrase had only TWO neighbours, a
 * two element median is their MEAN, so one floored reading pulled it to -30 dB
 * and handed that word +30 dB of invented contrast. It beat a genuine +6 dB
 * lean five words away and put the colour on the wrong word.
 *
 * A floor value is not a quiet measurement of his voice, it is the absence of
 * one, so it is dropped rather than averaged in. `NEIGHBOURS` below fixes the
 * other half of the same bug.
 */
const AUDIBLE_DB = -30

/**
 * How many neighbours the local contrast is measured against, and the window
 * SLIDES rather than clipping, so a word at either end of a phrase is judged
 * against as many neighbours as a word in the middle. Clipping is what left the
 * first word of every phrase with a two element "median" that one outlier could
 * swing at will.
 */
const NEIGHBOURS = 4

/** Floor for the dB conversion so a fully silent window cannot return -Infinity. */
const SILENCE_FLOOR_DB = -60

/**
 * 20 ms RMS windows over mono PCM. One pass, and it must be taken BEFORE the
 * audio is handed to the transcriber: `transcribePcm` transfers the buffer to
 * its worker and leaves the caller's Float32Array detached with length zero.
 */
export function speechEnvelope(pcm: ArrayLike<number>, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(ENVELOPE_HOP_S * sampleRate))
  const n = Math.floor(pcm.length / hop)
  const env = new Float32Array(Math.max(0, n))
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += pcm[j] * pcm[j]
    env[i] = Math.sqrt(sum / hop)
  }
  return env
}

const windowsIn = (env: ArrayLike<number>, fromS: number, toS: number): number[] => {
  const a = Math.max(0, Math.floor(fromS / ENVELOPE_HOP_S))
  const b = Math.min(env.length, Math.ceil(toS / ENVELOPE_HOP_S))
  const out: number[] = []
  for (let i = a; i < Math.max(a + 1, b) && i < env.length; i++) out.push(env[i])
  return out
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * The loudest 60 ms of a word: the mean of its three loudest 20 ms windows.
 * Plain RMS over the span is the wrong statistic, because the span is a LABEL
 * and up to half of it can be the pause that follows the word. No amount of
 * trailing silence can drag three loud windows down.
 */
const topOfWindows = (ws: readonly number[]): number => {
  if (ws.length === 0) return 0
  const desc = [...ws].sort((a, b) => b - a)
  const take = Math.min(3, desc.length)
  let sum = 0
  for (let i = 0; i < take; i++) sum += desc[i]
  return sum / take
}

/**
 * The clip's own speech level: the mean of the loudest 30% of windows. Same
 * definition as `activeRms` in _verify/caption-music-lib.mjs, so both harnesses
 * and this module agree about what 0 dB means. Plain RMS is wrong here because a
 * clip with a silent lead in measures quieter than the same clip trimmed.
 *
 * Every decision below is a DIFFERENCE of two dB values, so this reference
 * cancels out of the maths entirely. It exists so the numbers are readable and
 * so they match the ones the harness printed.
 */
function speechLevel(env: ArrayLike<number>): number {
  const s: number[] = []
  for (let i = 0; i < env.length; i++) s.push(env[i])
  s.sort((a, b) => b - a)
  const take = Math.max(1, Math.round(s.length * 0.3))
  let sum = 0
  for (let i = 0; i < take; i++) sum += s[i]
  return sum / take
}

const dbRel = (x: number, ref: number): number =>
  x > 0 && ref > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(x / ref)) : SILENCE_FLOOR_DB

/**
 * HOW LATE ARE THE WORD LABELS, in seconds, for THIS clip.
 *
 * Slide every word span earlier together and keep the offset that captures the
 * most speech energy, which is a one dimensional cross correlation of the word
 * mask against the envelope. Each word's curve is normalised to its own best
 * before they are summed, so the single loudest word cannot decide the offset
 * for the whole clip: raw summing did exactly that in the harness, handing the
 * boosted fixtures a 250 ms lag against 150 ms for the identical unboosted take,
 * which slid the window clean off the word under test.
 *
 * One pass over an envelope already in hand.
 */
function bestLagS(spans: readonly { startS: number; endS: number }[], env: ArrayLike<number>, maxLagS: number): number {
  const lags: number[] = []
  for (let lag = 0; lag <= maxLagS + 1e-9; lag += 0.01) lags.push(Math.round(lag * 100) / 100)
  const curves = spans.map((w) => {
    const e = lags.map((lag) => windowsIn(env, w.startS - lag, w.endS - lag).reduce((s, x) => s + x * x, 0))
    const mx = Math.max(...e)
    return mx > 0 ? e.map((x) => x / mx) : e.map(() => 0)
  })
  let bestLag = 0
  let bestScore = -1
  for (let i = 0; i < lags.length; i++) {
    let score = 0
    for (const c of curves) score += c[i]
    if (score > bestScore) {
      bestScore = score
      bestLag = lags[i]
    }
  }
  return bestLag
}

/**
 * Set `emphasis` on at most one word per PHRASE, and return a new array. Words
 * that are not picked come back byte for byte as they went in: only the flag may
 * ever change, never the text and never the timing.
 *
 * THE UNIT IS THE PHRASE, AND THAT IS WHAT GUARANTEES ONE FLAG PER BLOCK.
 * `chunkWords` breaks HARD on three things (captions.ts, the loop at the top of
 * the grouping pass): a sentence end, an emphasis flip, and a silence longer
 * than `maxGapS`. A phrase here is a run between a sentence end or a gap longer
 * than that SAME `maxGapS`, so every phrase boundary is already a hard block
 * break, no block can ever span two phrases, and one flag per phrase therefore
 * gives at most one flag per block for free. It also gives the right DENSITY,
 * which per-block would not: AUTO_CAPTION_OPTIONS turns the measured 11 word
 * take into 8 blocks, mostly one word each, so one highlight per block would
 * highlight nearly every word on the screen.
 *
 * WHAT THE FLAG DOES DOWNSTREAM, worth knowing before reading the output: an
 * emphasis flip is a hard break and `chunk.emphasis` is `words.some(...)`, so
 * the picked word gets its OWN block, rendered wholly in the emphasis colour.
 * That is one coloured block, not one coloured word inside a plain block. With
 * the auto options the blocks are already mostly single words, so the layout
 * barely moves, and a phrase never gains more than two blocks.
 */
export function markEmphasis(
  words: readonly CaptionWord[],
  envelope: ArrayLike<number>,
  options: EmphasisOptions = {},
): CaptionWord[] {
  const o = { ...EMPHASIS_DEFAULTS, ...options }
  const out = words.map((w) => w)
  if (envelope.length === 0) return out

  // The same words `chunkWords` will see, in the same order, so a phrase
  // boundary here is exactly a hard block break there. Sort is stable in both,
  // so equal start times keep the same order in both.
  const order = words
    .map((_w, i) => i)
    .filter((i) => words[i].text.trim().length > 0 && isSpeechWord(words[i].text))
    .sort((a, b) => words[a].startS - words[b].startS)
  if (order.length === 0) return out

  const ref = speechLevel(envelope)
  const lagS = bestLagS(
    order.map((i) => words[i]),
    envelope,
    o.maxLagS,
  )

  const loudDb = order.map((i) =>
    dbRel(topOfWindows(windowsIn(envelope, words[i].startS - lagS, words[i].endS - lagS)), ref),
  )

  // Split into phrases (positions into `order`), then decide each one alone.
  let from = 0
  for (let k = 1; k <= order.length; k++) {
    const prev = words[order[k - 1]]
    const here = k < order.length ? words[order[k]] : null
    const breaks = here === null || endsSentence(prev.text) || here.startS - prev.endS > o.maxGapS
    if (!breaks) continue
    const winner = pickInPhrase(order.slice(from, k), loudDb.slice(from, k), words, o)
    if (winner !== null) out[winner] = { ...words[winner], emphasis: true }
    from = k
  }
  return out
}

/**
 * The one word of this phrase that earns the colour, as an index into `words`,
 * or null when nothing does. Nothing does most of the time, and that is the
 * correct outcome rather than a miss.
 *
 * Three conditions, all measured, and ALL of them must hold:
 *   1. the winner is not a function word. Hard veto, and not optional: without
 *      it the second phrase of the real take highlights "it".
 *   2. the phrase's loudness spread is at least `minSpreadDb`. Below that there
 *      is nothing there to measure.
 *   3. the winner beats the runner-up CONTENT word by at least `minMarginDb` of
 *      local contrast.
 *
 * LOCAL CONTRAST, not raw level: the word against the MEDIAN of its up to four
 * nearest neighbours in the phrase. Raw and local picked identically on the
 * measured take, but local is what survives declination on a take that does
 * drift (the 7 word phrase measured -0.3 dB per word), it needs no line fit so
 * it survives a three word phrase, and it is the reason this cannot degenerate
 * into "highlight word one" (first word won 0 of 14 phrases, raw and detrended
 * alike). The neighbour set deliberately includes function words: the contrast
 * being measured is about the voice, not about the vocabulary.
 */
function pickInPhrase(
  idx: readonly number[],
  levels: readonly number[],
  words: readonly CaptionWord[],
  o: Required<EmphasisOptions>,
): number | null {
  if (idx.length < 2) return null

  // GATE 2. Spread over the words that are actually audible, so a label that
  // landed in silence cannot manufacture a spread out of its own floor value.
  const audible = levels.filter((db) => db > AUDIBLE_DB)
  if (audible.length < 2) return null
  if (Math.max(...audible) - Math.min(...audible) < o.minSpreadDb) return null

  const local = levels.map((db, i) => {
    // A window of NEIGHBOURS+1 words centred on this one, SLID back inside the
    // phrase at either end instead of being cut short there. Both halves matter:
    // sliding keeps the count up, and dropping floor readings keeps a "no
    // measurement" out of the average. See AUDIBLE_DB.
    const lo = Math.max(0, Math.min(i - NEIGHBOURS / 2, idx.length - 1 - NEIGHBOURS))
    const hi = Math.min(idx.length - 1, lo + NEIGHBOURS)
    const near: number[] = []
    for (let j = lo; j <= hi; j++) if (j !== i && levels[j] > AUDIBLE_DB) near.push(levels[j])
    return near.length ? db - median(near) : 0
  })

  // GATE 1, plus the two cheap sanity rules. A function word never carries the
  // colour however loud he said it; a word under `minChars` is too small to read
  // as a deliberate highlight ("go", "ow"); and a label sitting in silence is
  // not a word at all. Letters are counted Unicode aware, not as [a-z], because
  // Czech is a selectable caption language and an ASCII count makes every
  // accented word measure zero and blocks the feature outright.
  const eligible: number[] = []
  for (let i = 0; i < idx.length; i++) {
    const text = words[idx[i]].text
    if (isFunctionWord(text)) continue
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < o.minChars) continue
    if (levels[i] <= AUDIBLE_DB) continue
    eligible.push(i)
  }
  if (eligible.length === 0) return null

  eligible.sort((a, b) => local[b] - local[a])
  const best = eligible[0]
  const second = eligible[1]
  // A word that sits BELOW its own neighbours has not been leaned on, whatever
  // the other content words did. A sign check, not a tuned number.
  if (local[best] <= 0) return null
  // GATE 3. With no runner-up there is nothing to beat, so the same bar is
  // applied to the winner's own lift over its neighbours, which is the only
  // comparison a one-candidate phrase has.
  const margin = second === undefined ? local[best] : local[best] - local[second]
  if (margin < o.minMarginDb) return null
  return idx[best]
}
