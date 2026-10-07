// The Words tab: the timeline read out loud, and a cut made by deleting words.
//
// Premiere's text based editing, the thing its users called "a game changer"
// (community research, 2026-09-15). One paragraph per clip with sound, in
// timeline order. Click a word and the playhead goes there. Drag across words,
// or Shift+click, to select a run; Delete (or the button) takes that stretch
// out of the timeline and closes the gap, on every unlocked track, in one undo
// step. A clip whose media has not been listened to yet offers to listen.
//
// The reading and the cut are engine/transcriptCut.ts, pure; the store side is
// state/transcriptActions.ts. This file is only the surface.

import { Ear, Scissors } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { formatTimecode } from '../engine/timecode'
import { wordIndexAt, wordSpan, wordsOnTimeline, type TimelineWord } from '../engine/transcriptCut'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { useTranscribe, wordLagNow } from '../state/transcribeActions'
import { cutWords, listenForEveryClip, listenForWords } from '../state/transcriptActions'
import { Button } from '../ui/Button'

/**
 * One clip's words. Drawn again only when something about THESE words changes:
 * the word under the playhead moving into or out of it, or the selection.
 */
const WordsParagraph = memo(function WordsParagraph({
  words,
  offset,
  selLo,
  selHi,
  current,
  onPick,
  onEnter,
}: {
  words: readonly TimelineWord[]
  /** Where this clip's first word sits in the whole tab's list. */
  offset: number
  /** The selected run, as whole-tab indexes; -1 for both when none of it is here. */
  selLo: number
  selHi: number
  /** The word under the playhead, as a whole-tab index; -1 when it is not here. */
  current: number
  onPick: (e: MouseEvent, i: number, word: TimelineWord) => void
  onEnter: (i: number) => void
}) {
  return (
    <p className="select-none px-1">
      {words.map((word, k) => {
        const i = offset + k
        const selected = i >= selLo && i <= selHi && selLo >= 0
        return (
          <span
            key={`${word.clipId}-${k}`}
            data-testid="word"
            data-index={i}
            data-at={word.atS}
            data-selected={selected || undefined}
            className={`cursor-text rounded-inner px-0.5 ${
              selected
                ? 'bg-accent-quiet text-accent'
                : i === current
                  ? 'text-text-primary underline decoration-accent underline-offset-2'
                  : 'text-text-primary hover:bg-bg-elevated'
            }`}
            onMouseDown={(e) => onPick(e, i, word)}
            onMouseEnter={() => onEnter(i)}
          >
            {word.text}{' '}
          </span>
        )
      })}
    </p>
  )
})

export function WordsTab() {
  const project = useStore((s) => s.project)
  const status = useTranscribe((s) => s.status)
  const seq = activeSequence(project)
  // Words kept before they were stored on time are shifted by the lag on read.
  const rows = useMemo(() => wordsOnTimeline(seq, project.assets, wordLagNow()), [seq, project.assets])
  // One flat list so a selection can run across clips; each row knows its offset.
  const { flat, offsets } = useMemo(() => {
    const flat: TimelineWord[] = []
    const offsets: number[] = []
    for (const row of rows) {
      offsets.push(flat.length)
      flat.push(...row.words)
    }
    return { flat, offsets }
  }, [rows])

  // Clips with no words yet that can be heard: one button listens to them all.
  const unheard = useMemo(() => rows.filter((row) => row.words.length === 0 && row.clip.speed > 0).length, [rows])

  const [anchor, setAnchor] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const dragging = useRef(false)
  const panel = useRef<HTMLDivElement>(null)

  // A cut or a listen changes the words under a selection; a range that ran
  // off the end is simply gone rather than pointing at words that moved.
  const sel =
    anchor !== null && focus !== null && anchor < flat.length && focus < flat.length
      ? { lo: Math.min(anchor, focus), hi: Math.max(anchor, focus) }
      : null
  const span = sel ? wordSpan(flat, sel.lo, sel.hi, seq.fps) : null
  const count = sel ? sel.hi - sel.lo + 1 : 0

  const clear = (): void => {
    setAnchor(null)
    setFocus(null)
  }
  // A different project is different words; a run picked in the last one must
  // not arm the Cut button against this one.
  useEffect(() => {
    setAnchor(null)
    setFocus(null)
  }, [project.id])
  const cut = (): void => {
    if (!span) return
    cutWords(span.startS, span.endS, count)
    clear()
  }

  // Stable, so a paragraph whose words did not change is never drawn again.
  const pick = useCallback((e: MouseEvent, i: number, word: TimelineWord): void => {
    e.preventDefault()
    panel.current?.focus()
    // Shift extends the run from where it started; anything else starts one here.
    const extend = e.shiftKey
    setAnchor((a) => (extend && a !== null ? a : i))
    setFocus(i)
    dragging.current = true
    useStore.getState().setUI({ playheadS: word.atS })
  }, [])
  const enter = useCallback((i: number): void => {
    if (dragging.current) setFocus(i)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // The global keymap would delete the timeline SELECTION on this key; in
      // here it deletes the selected words and nothing else.
      e.stopPropagation()
      e.preventDefault()
      cut()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      clear()
    }
  }

  // The word under the playhead, so the paragraph follows playback.
  //
  // ⛔ THE WORD, NOT THE TIME (CA-12, UI-8). Playback writes the playhead to the
  // store on every frame, and this tab subscribed to it, so the whole tab and
  // every word in it was drawn again up to 240 times a second while he played a
  // clip to find what to cut. The word under the playhead changes a few times a
  // second, and only then does anything here draw again.
  const currentIndex = useStore((s) => wordIndexAt(flat, s.ui.playheadS))

  return (
    <div
      ref={panel}
      data-testid="words-tab"
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={onKeyDown}
      onMouseUp={() => {
        dragging.current = false
      }}
      onMouseLeave={() => {
        dragging.current = false
      }}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <Button variant="secondary" data-testid="cut-words" disabled={!span} onClick={cut}>
          <Scissors size={16} strokeWidth={1.5} />
          {count > 0 ? `Cut ${count} ${count === 1 ? 'word' : 'words'}` : 'Cut words'}
        </Button>
        <span className="truncate text-[11px] text-text-muted tabular-nums">
          {span ? `${formatTimecode(span.endS - span.startS, seq.fps)} of the edit` : 'Drag across words, then Delete'}
        </span>
      </div>
      {unheard > 1 && (
        <div className="px-2 pb-2">
          <Button
            variant="secondary"
            data-testid="listen-every-clip"
            disabled={status !== 'idle'}
            onClick={() => void listenForEveryClip()}
            className="w-full justify-center"
          >
            <Ear size={14} strokeWidth={1.5} />
            {`Listen to all ${unheard} clips`}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[12px] leading-6">
        {rows.length === 0 && (
          <p className="px-1 text-text-muted">Put a clip with sound on the timeline and its words show up here.</p>
        )}
        {rows.map((row, r) => {
          const from = offsets[r]
          const to = from + row.words.length - 1
          // Only what falls in this clip is handed down, so every other clip
          // sees the same props as last time and is not drawn again.
          const mine = sel !== null && sel.lo <= to && sel.hi >= from
          return (
            <section key={row.clip.id} data-testid="words-clip" className="mb-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
                <span className="truncate" title={row.asset.name}>
                  {row.asset.name}
                </span>
                <span className="shrink-0 tabular-nums">{formatTimecode(row.clip.startS, seq.fps)}</span>
              </div>
              {row.words.length === 0 ? (
                <Button
                  variant="secondary"
                  data-testid="listen-for-words"
                  disabled={status !== 'idle'}
                  onClick={() => void listenForWords(row.clip.id)}
                >
                  <Ear size={14} strokeWidth={1.5} />
                  {status === 'idle' ? 'Listen for words' : 'Listening'}
                </Button>
              ) : (
                <WordsParagraph
                  words={row.words}
                  offset={from}
                  selLo={mine ? Math.max(sel.lo, from) : -1}
                  selHi={mine ? Math.min(sel.hi, to) : -1}
                  current={currentIndex >= from && currentIndex <= to ? currentIndex : -1}
                  onPick={pick}
                  onEnter={enter}
                />
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
