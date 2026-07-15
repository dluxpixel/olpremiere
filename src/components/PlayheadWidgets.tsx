// Zero-re-render playhead readouts. The transport writes ui.playheadS on EVERY
// animation frame while playing; any React component that subscribes via a hook
// re-renders at the display's refresh rate. On a high-refresh monitor that
// re-rendered the entire Timeline ~144×/s and starved the actual video — the
// "laggy preview". These leaves subscribe imperatively (store.subscribe) and
// write style/text through a ref, so a playhead tick costs two DOM writes and
// ZERO React renders anywhere.

import { useEffect, useRef, useState } from 'react'
import { useCollab } from '../collab/collabControl'
import { formatTimecode, parseTimecode } from '../engine/timecode'
import { activeSequence } from '../engine/types'
import { useStore } from '../state/store'

/** The timeline's red playhead line. Position = playheadS × pxPerS, imperative. */
export function PlayheadLine({ pxPerS }: { pxPerS: number }) {
  const ref = useRef<HTMLDivElement>(null)
  // The subscription callback must see the CURRENT zoom without resubscribing
  // (zoom changes mid-play are legal), so the scale rides in a ref.
  const pxPerSRef = useRef(pxPerS)
  pxPerSRef.current = pxPerS

  useEffect(() => {
    const position = (t: number): void => {
      if (ref.current) ref.current.style.left = `${t * pxPerSRef.current}px`
    }
    position(useStore.getState().ui.playheadS)
    return useStore.subscribe((s) => s.ui.playheadS, position)
  }, [])

  // Zoom changed: reposition immediately at the current time (React render path).
  useEffect(() => {
    if (ref.current) ref.current.style.left = `${useStore.getState().ui.playheadS * pxPerS}px`
  }, [pxPerS])

  return (
    <div
      ref={ref}
      data-testid="playhead"
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-playhead"
    >
      <div
        className="absolute -left-[5px] top-0 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent"
        style={{ borderTopColor: 'var(--color-playhead)' }}
      />
    </div>
  )
}

/**
 * Every OTHER editor's playhead in the room: a thin colored line + name tag.
 * Presence arrives every ~2s, so these are plain React renders (a handful of
 * absolutely-positioned divs — nothing like the local playhead's tick rate).
 */
export function RemotePlayheads({ pxPerS }: { pxPerS: number }) {
  const peers = useCollab((s) => s.peers)
  if (peers.length === 0) return null
  return (
    <>
      {peers.map((p) => (
        <div
          key={p.clientId}
          data-testid="remote-playhead"
          className="pointer-events-none absolute bottom-0 top-0 z-20 w-px opacity-70"
          style={{ left: p.playheadS * pxPerS, background: p.color }}
        >
          <span
            className="absolute left-1 top-0 max-w-24 truncate rounded-[3px] px-1 text-[9px] leading-4 text-black/80"
            style={{ background: p.color }}
          >
            {p.name}
          </span>
        </div>
      ))}
    </>
  )
}

/** A live timecode span for the current playhead time. Text updates imperatively. */
export function PlayheadTimecode({
  fps,
  className,
  testId,
  editable,
}: {
  fps: number
  className?: string
  testId?: string
  /** Double-click to type a timecode and jump the playhead there. */
  editable?: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const fpsRef = useRef(fps)
  fpsRef.current = fps
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    if (editing !== null) return // frozen while typing
    let last = ''
    const write = (t: number): void => {
      const text = formatTimecode(t, fpsRef.current)
      if (text !== last && ref.current) {
        last = text
        ref.current.textContent = text
      }
    }
    write(useStore.getState().ui.playheadS)
    return useStore.subscribe((s) => s.ui.playheadS, write)
  }, [editing])

  // fps changed (sequence switch): rewrite with the new frame base.
  useEffect(() => {
    if (editing === null && ref.current)
      ref.current.textContent = formatTimecode(useStore.getState().ui.playheadS, fps)
  }, [fps, editing])

  if (editable && editing !== null) {
    const commit = () => {
      const t = parseTimecode(editing, fps)
      if (t !== null) {
        const seq = activeSequence(useStore.getState().project)
        useStore.getState().setUI({ playheadS: Math.max(0, Math.min(t, seq.durationS)) })
      }
      setEditing(null)
    }
    return (
      <input
        autoFocus
        data-testid={testId ? `${testId}-input` : undefined}
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(null)
        }}
        className={`w-[86px] rounded-[3px] bg-bg-input px-1 tabular-nums text-text-primary outline-none ${className ?? ''}`}
      />
    )
  }

  return (
    <span
      ref={ref}
      data-testid={testId}
      title={editable ? 'Double-click to type a time' : undefined}
      className={`${className ?? ''} ${editable ? 'cursor-text' : ''}`}
      onDoubleClick={
        editable
          ? () => setEditing(formatTimecode(useStore.getState().ui.playheadS, fps))
          : undefined
      }
    />
  )
}
