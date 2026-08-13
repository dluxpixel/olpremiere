import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTitleDef, newTitleClip } from '../types'
import {
  TRANSCRIBE_SAMPLE_RATE,
  tidyTranscribedWords,
  timelineWords,
  transcribePcm,
  wordsFromAsrChunks,
  type AsrChunk,
} from './transcribe'

const chunk = (text: string, start: number, end: number | null): AsrChunk => ({
  text,
  timestamp: [start, end],
})

describe('wordsFromAsrChunks', () => {
  it('trims Whisper’s leading spaces and keeps word order', () => {
    const words = wordsFromAsrChunks([chunk(' so', 0, 0.2), chunk(' I', 0.2, 0.35)])
    expect(words.map((w) => w.text)).toEqual(['so', 'I'])
    expect(words[0]).toEqual({ text: 'so', startS: 0, endS: 0.2 })
  })

  it('drops empties and bracketed noise tags', () => {
    const words = wordsFromAsrChunks([
      chunk('  ', 0, 0.1),
      chunk('[BLANK_AUDIO]', 0.1, 0.5),
      chunk('(music)', 0.5, 0.9),
      chunk(' real', 1, 1.2),
    ])
    expect(words.map((w) => w.text)).toEqual(['real'])
  })

  it('repairs null and inverted end times (typical for the final word)', () => {
    const words = wordsFromAsrChunks([chunk(' hello', 1, null), chunk(' hi', 3, 2.5)])
    expect(words[0].endS).toBeGreaterThan(words[0].startS)
    expect(words[1].endS).toBeGreaterThan(words[1].startS)
  })

  it('clamps negative start times to zero', () => {
    const words = wordsFromAsrChunks([chunk(' x', -0.2, 0.1)])
    expect(words[0].startS).toBe(0)
  })
})

describe('timelineWords', () => {
  it('offsets slice-relative times by the clip start', () => {
    const clip = { ...newTitleClip(defaultTitleDef('x'), 10, 5), speed: 1 }
    const words = timelineWords([{ text: 'go', startS: 1, endS: 1.4 }], clip)
    expect(words[0].startS).toBeCloseTo(11, 9)
    expect(words[0].endS).toBeCloseTo(11.4, 9)
  })

  it('compresses times by the playback speed', () => {
    const clip = { ...newTitleClip(defaultTitleDef('x'), 10, 5), speed: 2 }
    const words = timelineWords([{ text: 'go', startS: 1, endS: 2 }], clip)
    expect(words[0].startS).toBeCloseTo(10.5, 9)
    expect(words[0].endS).toBeCloseTo(11, 9)
  })
})

describe('tidyTranscribedWords', () => {
  const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })

  it('collapses a recogniser loop but keeps a genuine repeat', () => {
    // Whisper skipping: the same token again with no audible gap.
    const looped = tidyTranscribedWords([
      w('the', 0.0, 0.2), w('the', 0.2, 0.4), w('the', 0.4, 0.6), w('wall', 0.6, 1.0),
    ])
    expect(looped.map((x) => x.text)).toEqual(['the', 'wall'])

    // Actually saying a word twice leaves a real gap between them.
    const real = tidyTranscribedWords([w('go', 0.0, 0.3), w('go', 0.9, 1.2)])
    expect(real).toHaveLength(2)
  })

  it('drops tokens that are only punctuation', () => {
    const out = tidyTranscribedWords([w('hi', 0, 0.3), w('.', 0.3, 0.35), w('there', 0.4, 0.8)])
    expect(out.map((x) => x.text)).toEqual(['hi', 'there'])
  })

  // Czech is one of the caption languages he can pick, and the punctuation rule
  // used to test `a-z0-9`, so a word whose only letter carries a diacritic read
  // as a bare mark and was deleted before it could ever reach the screen.
  it('keeps an accented one letter word, and still drops the marks around it', () => {
    const out = tidyTranscribedWords([
      w('Ó', 0, 0.3), w(',', 0.3, 0.35),
      w('ať', 0.5, 0.9), w('.', 0.9, 0.95),
      w('žije', 1.1, 1.5),
    ])
    expect(out.map((x) => x.text)).toEqual(['Ó', 'ať', 'žije'])
  })

  it('still drops every token that carries no letter and no digit', () => {
    const marks = ['.', ',', '-', '...', '?!', '"', '♪', '♪♪♪']
    const out = tidyTranscribedWords(marks.map((t, i) => w(t, i, i + 0.4)))
    expect(out).toEqual([])
  })

  // The loop check compares two words with their punctuation stripped, and that
  // strip was ASCII only, so every accented word flattened to the same empty
  // string and two different ones in a row looked like the recogniser skipping.
  it('does not read two different accented words as a recogniser loop', () => {
    const different = tidyTranscribedWords([w('ó', 0, 0.2), w('á', 0.25, 0.5)])
    expect(different.map((x) => x.text)).toEqual(['ó', 'á'])

    // A real repeat of the same accented word with no audible gap still collapses.
    const looped = tidyTranscribedWords([w('ó', 0, 0.2), w('ó', 0.25, 0.5)])
    expect(looped.map((x) => x.text)).toEqual(['ó'])
  })

  it('strips the end-of-silence hallucination, but only after a real pause', () => {
    const invented = tidyTranscribedWords([
      w('diamonds', 0.0, 0.6),
      w('thanks', 3.0, 3.3), w('for', 3.3, 3.5), w('watching', 3.5, 4.0),
    ])
    expect(invented.map((x) => x.text)).toEqual(['diamonds'])

    // Said straight after the previous word, so that is the creator actually
    // signing off, and it stays.
    const spoken = tidyTranscribedWords([
      w('diamonds', 0.0, 0.6),
      w('thanks', 0.7, 1.0), w('for', 1.0, 1.2), w('watching', 1.2, 1.6),
    ])
    expect(spoken).toHaveLength(4)
  })

  it('leaves ordinary punctuation attached, because the chunker breaks captions on it', () => {
    const out = tidyTranscribedWords([w('done.', 0, 0.5), w('next', 0.6, 1.0)])
    expect(out[0].text).toBe('done.')
  })

  // His report, 2026-08-09: "with the auto caption, it also captions music."
  // Whisper learned from subtitle files, so over a backing track it writes the
  // subtitler's note instead of words. wordsFromAsrChunks already drops a tag
  // that arrives whole, but this pipeline asks for WORD-level timestamps, which
  // split "[MUSIC PLAYING]" on the space: neither "[MUSIC" nor "PLAYING]" is a
  // complete bracket, so both used to land as captions over his music.
  it('drops a bracketed stage direction that is split across words', () => {
    const out = tidyTranscribedWords([
      w('so', 0.0, 0.3),
      w('[MUSIC', 1.0, 1.4), w('PLAYING]', 1.4, 1.9),
      w('anyway', 2.2, 2.6),
    ])
    expect(out.map((x) => x.text)).toEqual(['so', 'anyway'])
  })

  it('drops a whole-token tag and a round-bracket one', () => {
    const out = tidyTranscribedWords([
      w('[Music]', 0.0, 0.4),
      w('(upbeat', 0.5, 0.8), w('music)', 0.8, 1.2),
      w('diamonds', 2.0, 2.4),
    ])
    expect(out.map((x) => x.text)).toEqual(['diamonds'])
  })

  it('drops a tag that carries trailing punctuation, and one that opens on its own token', () => {
    const comma = tidyTranscribedWords([w('[Music],', 0, 0.4), w('right', 0.6, 0.9)])
    expect(comma.map((x) => x.text)).toEqual(['right'])

    const split = tidyTranscribedWords([w('[', 0, 0.1), w('MUSIC', 0.1, 0.5), w(']', 0.5, 0.6), w('go', 1, 1.3)])
    expect(split.map((x) => x.text)).toEqual(['go'])
  })

  it('drops a bare musical note, kept by the punctuation rule so there is one of it', () => {
    const out = tidyTranscribedWords([w('♪', 0, 0.4), w('♪♪♪', 0.5, 1.0), w('mine', 1.5, 1.8)])
    expect(out.map((x) => x.text)).toEqual(['mine'])
  })

  // The failure that would actually cost him work is a DELETED sentence, so the
  // bracket rule has to give up rather than guess. An opening bracket that never
  // closes nearby keeps every word after it.
  it('never eats a sentence behind a bracket that does not close', () => {
    const said = ['(so', 'I', 'went', 'down', 'to', 'the', 'cave', 'and', 'mined']
    const out = tidyTranscribedWords(said.map((t, i) => w(t, i * 0.4, i * 0.4 + 0.3)))
    expect(out.map((x) => x.text)).toEqual(said)
  })

  it('keeps singing between musical notes, because a note span can hold his voice too', () => {
    const out = tidyTranscribedWords([
      w('♪', 0, 0.2),
      w('never', 0.3, 0.6), w('gonna', 0.6, 0.9), w('give', 0.9, 1.2),
      w('♪', 1.3, 1.5),
    ])
    expect(out.map((x) => x.text)).toEqual(['never', 'gonna', 'give'])
  })
})

/**
 * The run lifecycle, with a stand-in for the Worker. What is under test is not
 * Whisper but the three ways a run can stop without a transcript: it is
 * cancelled, it stops responding, or the handoff itself throws. Each one has to
 * hand the worker's memory back AND clear the single-run lock, because a lock
 * left set makes every later caption run in the session report that one is
 * already going.
 */
class FakeWorker {
  static last: FakeWorker | null = null
  /** Set before a run, because the handoff happens inside transcribePcm. */
  static throwOnPost = false
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  posted: unknown[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }
  postMessage(msg: unknown): void {
    if (FakeWorker.throwOnPost) throw new Error('buffer already detached')
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  /** How many listeners are still attached, which is the leak check. */
  count(): number {
    return (this.listeners.message ?? []).length + (this.listeners.error ?? []).length
  }
  emit(data: unknown): void {
    for (const fn of [...(this.listeners.message ?? [])]) fn({ data })
  }
}

/** A minute of silence, which is only ever used for its length. */
const minute = (): Float32Array => new Float32Array(60 * TRANSCRIBE_SAMPLE_RATE)

describe('transcribePcm run lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    // `last` is deliberately NOT reset: a run that ended normally leaves the
    // worker alive on purpose, so the next run reuses that same instance and
    // constructs nothing. Resetting here would read as a missing worker.
    FakeWorker.throwOnPost = false
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('gives up on a run that stops responding, and hands the worker back', async () => {
    const run = transcribePcm(minute(), 'en', () => {})
    const worker = FakeWorker.last!
    // Claimed up front: the watchdog rejects while the timers are being
    // advanced, so a handler attached afterwards would arrive a tick late.
    const gaveUp = expect(run.promise).rejects.toThrow('stopped responding')
    worker.emit({ type: 'progress', phase: 'listening', pct: null })
    // Ten seconds of allowance per second of audio, on top of the floor.
    await vi.advanceTimersByTimeAsync(60_000 + 60 * 10_000 + 1)
    await gaveUp
    expect(worker.terminated).toBe(true)
    expect(worker.count()).toBe(0)
    // The lock is clear: a second run gets a real worker, not the busy error.
    const next = transcribePcm(minute(), 'en', () => {})
    expect(FakeWorker.last).not.toBe(worker)
    next.promise.catch(() => {})
    next.cancel()
  })

  it('keeps the worker alive on a normal finish and stops the clock', async () => {
    const run = transcribePcm(minute(), 'en', () => {})
    const worker = FakeWorker.last!
    worker.emit({ type: 'progress', phase: 'listening', pct: null })
    worker.emit({ type: 'done', chunks: [{ text: ' hey', timestamp: [0, 0.2] }] })
    await expect(run.promise).resolves.toHaveLength(1)
    // The model stays loaded for the next clip, and the watchdog cannot fire
    // late and tear down a worker that is doing nothing wrong.
    await vi.advanceTimersByTimeAsync(60_000 + 60 * 10_000 + 1)
    expect(worker.terminated).toBe(false)
    expect(worker.count()).toBe(0)
  })

  it('cancel terminates, drops the listeners and clears the lock', async () => {
    const run = transcribePcm(minute(), 'en', () => {})
    const worker = FakeWorker.last!
    worker.emit({ type: 'progress', phase: 'listening', pct: null })
    run.cancel()
    await expect(run.promise).rejects.toEqual({ cancelled: true })
    expect(worker.terminated).toBe(true)
    expect(worker.count()).toBe(0)
    const next = transcribePcm(minute(), 'en', () => {})
    expect(FakeWorker.last).not.toBe(worker)
    next.promise.catch(() => {})
    next.cancel()
  })

  it('a handoff that throws fails that run only, never the whole session', async () => {
    FakeWorker.throwOnPost = true
    const first = transcribePcm(minute(), 'en', () => {})
    expect(FakeWorker.last!.terminated).toBe(true)
    await expect(first.promise).rejects.toThrow('detached')
    FakeWorker.throwOnPost = false
    // Without the guard this left the lock set and every later run in the
    // session answered "A transcription is already running".
    const second = transcribePcm(minute(), 'en', () => {})
    FakeWorker.last!.emit({ type: 'done', chunks: [] })
    await expect(second.promise).resolves.toEqual([])
  })
})

describe('tidyTranscribedWords, phrase loops', () => {
  const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })
  const loop = (phrase: string[], times: number, from = 0) => {
    const out = []
    let t = from
    for (let n = 0; n < times; n++) {
      for (const word of phrase) {
        out.push(w(word, t, t + 0.03))
        t += 0.03
      }
    }
    return out
  }

  it('keeps one copy of the phrase Whisper got stuck on', () => {
    // The measured shape: 40 s of a rigid backing bed, one phrase over and over.
    const out = tidyTranscribedWords(loop(['a', 'little', 'bit', 'of'], 74))
    expect(out.map((x) => x.text)).toEqual(['a', 'little', 'bit', 'of'])
  })

  it('stretches the kept copy over everything the loop covered', () => {
    const out = tidyTranscribedWords(loop(['come', 'on'], 20, 5))
    expect(out).toHaveLength(2)
    expect(out[0].startS).toBe(5)
    // 20 repeats of 2 words at 0.03 s each ends at 5 + 40 * 0.03.
    expect(out.at(-1)!.endS).toBeCloseTo(6.2, 5)
  })

  it('leaves a phrase said twice alone, because people do that', () => {
    const said = loop(['come', 'on'], 2)
    expect(tidyTranscribedWords(said).map((x) => x.text)).toEqual(['come', 'on', 'come', 'on'])
  })

  it('leaves a repeated phrase alone when there is a real gap between the takes', () => {
    const said = [...loop(['say', 'it'], 1, 0), ...loop(['say', 'it'], 1, 3), ...loop(['say', 'it'], 1, 6)]
    expect(tidyTranscribedWords(said)).toHaveLength(6)
  })

  it('takes the shortest cycle, not a longer one that happens to match', () => {
    // "a little bit of" x 6 is one four word phrase, never two eight word ones.
    const out = tidyTranscribedWords(loop(['a', 'little', 'bit', 'of'], 6))
    expect(out.map((x) => x.text)).toEqual(['a', 'little', 'bit', 'of'])
  })

  it('keeps the words either side of the loop', () => {
    const words = [
      w('so', 0, 0.2),
      ...loop(['a', 'little', 'bit'], 10, 0.2),
      w('anyway', 5, 5.4),
    ]
    const out = tidyTranscribedWords(words)
    expect(out.map((x) => x.text)).toEqual(['so', 'a', 'little', 'bit', 'anyway'])
  })

  it('never touches ordinary speech that merely reuses words', () => {
    const words = [
      w('I', 0, 0.2),
      w('went', 0.2, 0.5),
      w('to', 0.5, 0.6),
      w('the', 0.6, 0.7),
      w('shop', 0.7, 1.0),
      w('and', 1.0, 1.2),
      w('I', 1.2, 1.35),
      w('went', 1.35, 1.6),
      w('home', 1.6, 2.0),
    ]
    expect(tidyTranscribedWords(words)).toHaveLength(9)
  })
})

// ⛔ A CLIP THAT IS NOTHING BUT THE OUTRO KEEPS IT.
//
// The trailing-invention filter measures the pause before the phrase to tell a
// real sign-off from one Whisper dreamed into the silence at the end. With NO
// word before it there was nothing to measure, the guard was skipped outright,
// and the whole transcript went: an outro clip saying only "Thanks for
// watching!" came back empty with "No speech found in the clip" over it. That
// is an ordinary clip to have in a Shorts edit.
describe('the trailing-invention filter never empties a clip', () => {
  const w = (text: string, startS: number, endS: number) => ({ text, startS, endS })

  it('keeps an outro that IS the whole clip', () => {
    const words = [w('Thanks', 0, 0.3), w('for', 0.3, 0.5), w('watching!', 0.5, 1.0)]
    expect(tidyTranscribedWords(words).map((x) => x.text)).toEqual(['Thanks', 'for', 'watching!'])
  })

  it('still drops one invented after a real silence', () => {
    // The case it exists for: he stops talking, the audio runs on, and Whisper
    // fills the quiet with the credits it was trained on.
    const words = [w('diamonds', 0, 0.5), w('Thanks', 3, 3.3), w('for', 3.3, 3.5), w('watching!', 3.5, 4)]
    expect(tidyTranscribedWords(words).map((x) => x.text)).toEqual(['diamonds'])
  })

  it('keeps one he actually said, straight after his last word', () => {
    const words = [w('diamonds', 0, 0.5), w('Thanks', 0.6, 0.9), w('for', 0.9, 1.1), w('watching!', 1.1, 1.6)]
    expect(tidyTranscribedWords(words)).toHaveLength(4)
  })
})
