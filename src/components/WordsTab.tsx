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
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { formatTimecode } from '../engine/timecode'
import { wordSpan, wordsOnTimeline, type TimelineWord } from '../engine/transcriptCut'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'
import { useTranscribe } from '../state/transcribeActions'
import { cutWords, listenForWords } from '../state/transcriptActions'
import { Button } from '../ui/Button'

export function WordsTab() {
  const project = useStore((s) => s.project)
  const playheadS = useStore((s) => s.ui.playheadS)
  const setUI = useStore((s) => s.setUI)
  const status = useTranscribe((s) => s.status)
  const seq = activeSequence(project)
  const rows = useMemo(() => wordsOnTimeline(seq, project.assets), [seq, project.assets])
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
  const cut = (): void => {
    if (!span) return
    cutWords(span.startS, span.endS, count)
    clear()
  }

  const pick = (e: MouseEvent, i: number, word: TimelineWord): void => {
    e.preventDefault()
    panel.current?.focus()
    if (e.shiftKey && anchor !== null) setFocus(i)
    else {
      setAnchor(i)
      setFocus(i)
    }
    dragging.current = true
    setUI({ playheadS: word.atS })
  }

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
  const currentIndex = useMemo(() => {
    let found = -1
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].atS <= playheadS + 1e-6) found = i
      else break
    }
    return found >= 0 && playheadS < flat[found].endAtS + 0.35 ? found : -1
  }, [flat, playheadS])

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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[12px] leading-6">
        {rows.length === 0 && (
          <p className="px-1 text-text-muted">Put a clip with sound on the timeline and its words show up here.</p>
        )}
        {rows.map((row, r) => (
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
              <p className="select-none px-1">
                {row.words.map((word, k) => {
                  const i = offsets[r] + k
                  const selected = sel !== null && i >= sel.lo && i <= sel.hi
                  const current = i === currentIndex
                  return (
                    <span
                      key={`${word.clipId}-${k}`}
                      data-testid="word"
                      data-index={i}
                      data-at={word.atS}
                      data-selected={selected || undefined}
                      className={`cursor-text rounded-[3px] px-0.5 ${
                        selected
                          ? 'bg-accent-quiet text-accent'
                          : current
                            ? 'text-text-primary underline decoration-accent underline-offset-2'
                            : 'text-text-primary hover:bg-bg-elevated'
                      }`}
                      onMouseDown={(e) => pick(e, i, word)}
                      onMouseEnter={() => {
                        if (dragging.current) setFocus(i)
                      }}
                    >
                      {word.text}{' '}
                    </span>
                  )
                })}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
