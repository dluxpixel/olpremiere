// Transcript parsing for the caption generator: paste a word-timed JSON list
// or an SRT and get CaptionWords back. SRT cues carry sentence-level timing,
// so each cue's text is spread across its window word-by-word (same
// length-weighted spread as the manual split). Pure: no DOM, no store.

import { spreadWords, type CaptionWord } from './captions'

/** "00:01:02,345" or "00:01:02.345" (SRT allows both separators) → seconds. */
function srtTimeToS(t: string): number | null {
  const m = /^(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})$/.exec(t.trim())
  if (!m) return null
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
  )
}

function parseJsonWords(text: string): CaptionWord[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const words: CaptionWord[] = []
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) return null
    const w = raw as { text?: unknown; startS?: unknown; endS?: unknown; emphasis?: unknown }
    if (typeof w.text !== 'string' || typeof w.startS !== 'number') return null
    const startS = w.startS
    const endS = typeof w.endS === 'number' && w.endS > startS ? w.endS : NaN
    words.push({
      text: w.text.trim(),
      startS,
      endS, // repaired below once the successor is known
      ...(w.emphasis === true ? { emphasis: true } : {}),
    })
  }
  const cleaned = words.filter((w) => w.text.length > 0).sort((a, b) => a.startS - b.startS)
  for (let i = 0; i < cleaned.length; i++) {
    if (!Number.isFinite(cleaned[i].endS)) {
      const next = cleaned[i + 1]
      cleaned[i].endS = next
        ? Math.min(next.startS, cleaned[i].startS + 1)
        : cleaned[i].startS + Math.max(0.25, 0.05 * cleaned[i].text.length)
    }
  }
  return cleaned
}

function parseSrt(text: string): CaptionWord[] | null {
  // Cue = a "start --> end" line followed by text lines. Index lines optional.
  const lines = text.replace(/\r/g, '').split('\n')
  const words: CaptionWord[] = []
  let sawCue = false
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].split('-->')
    if (arrow.length !== 2) continue
    const startS = srtTimeToS(arrow[0])
    const endS = srtTimeToS(arrow[1])
    if (startS === null || endS === null || endS <= startS) continue
    sawCue = true
    const cueText: string[] = []
    for (i++; i < lines.length && lines[i].trim() !== ''; i++) cueText.push(lines[i])
    // Strip basic SRT markup (<i>, {\an8}) before spreading.
    const plain = cueText.join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '')
    words.push(...spreadWords(plain, startS, endS - startS))
  }
  return sawCue ? words : null
}

/**
 * Parse pasted transcript text: word-timed JSON first (exact timings win),
 * then SRT. Returns null when the text is neither — the caller shows what the
 * two accepted shapes look like.
 */
export function parseTranscript(text: string): CaptionWord[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return parseJsonWords(trimmed) ?? parseSrt(trimmed)
}

/** How long the last tapped word stays up when nothing follows it. */
const TAP_TAIL_S = 0.4

/**
 * The tap-to-time flow's output: the nth tap timestamps the nth word's start;
 * each word runs to the next tap. Stopping early keeps only the tapped words.
 * Out-of-order taps (seek-back mid-flow) are dropped rather than emitting
 * overlapping captions.
 */
export function tapsToWords(words: readonly string[], tapTimesS: readonly number[]): CaptionWord[] {
  const out: CaptionWord[] = []
  const n = Math.min(words.length, tapTimesS.length)
  let lastT = -Infinity
  for (let i = 0; i < n; i++) {
    const text = words[i].trim()
    const t = tapTimesS[i]
    if (!text || t <= lastT) continue
    lastT = t
    const next = i + 1 < n ? tapTimesS[i + 1] : undefined
    out.push({
      text,
      startS: t,
      endS: next !== undefined && next > t ? next : t + TAP_TAIL_S,
    })
  }
  return out
}
