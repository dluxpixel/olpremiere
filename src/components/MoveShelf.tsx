// MOVES: the shelf of finished moves, and the one slider.
//
// This is the front door of the motion desk. He clicks a clip, he clicks a
// move, it is done. Two actions, against the seventeen the same sentence used to
// cost, and it is two whether one clip is selected or twenty.
//
// Three rules this block is built on:
//
// 1. NOTHING HERE IS A PARAMETER. Every tile is a finished move with a name a
//    person understands, and every tile SHOWS what it does rather than
//    describing it. There is no word on this panel he would have to look up.
// 2. THE LIT TILE IS DERIVED, NEVER REMEMBERED. It is worked out fresh from the
//    clip's own keyframes on every draw, so the panel cannot lie about a clip
//    that was edited by hand: nudge one diamond and it says Hand edited instead.
// 3. ONE GESTURE, ONE UNDO STEP. A tile click, a slider drag, a bar drag.
//
// Everything the motion desk used to open with is still here, one click away
// under "Tune it by hand": the punch buttons, the lanes, the curve editor.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { channelKeyframes } from '../engine/effects/channels'
import { MOVES, moveSamples, type MoveDef, type MoveId } from '../engine/moves'
import { clipDurationS } from '../engine/timeline'
import { activeSequence, type Clip } from '../engine/types'
import { applyMoveToSelection, moveOnClips, setMoveDepth, setMoveWindow } from '../state/moveActions'
import { useStore } from '../state/store'
import { headroomCeiling, overHeadroom } from './punchPresets'

/** The slider's ends. 105 percent is the smallest move that reads at all; 200 is as far as his footage stretches. */
const DEPTH_MIN = 1.05
const DEPTH_MAX = 2
/** The four numbers that were on the shipped chips, kept as notches under the slider. */
const NOTCHES = [1.1, 1.2, 1.4, 1.7]

/** How long the little pictures take to run through their move, and the pause before they loop. */
const PREVIEW_RUN_S = 1.9
const PREVIEW_LOOP_S = 2.5

const pct = (v: number): string => `${Math.round(v * 100)}%`

/**
 * One tile: a small frame with a smaller picture inside it that actually makes
 * the move. The picture is driven by ONE shared animation loop that only runs
 * while the pointer is over the shelf, writing a transform straight onto the
 * element. Zero React renders per frame, the same rule the rail's playhead
 * follows, which is why the shelf costs nothing during playback.
 */
function MoveTile({
  def,
  lit,
  aspect,
  onPick,
  register,
}: {
  def: MoveDef
  lit: boolean
  aspect: number
  onPick: () => void
  register: (id: MoveId, el: HTMLElement | null) => void
}) {
  const frame = frameSize(aspect)
  return (
    <button
      type="button"
      data-testid={`move-tile-${def.id}`}
      aria-pressed={lit}
      title={`${def.name}: ${def.hint} (press ${def.digit})`}
      onClick={onPick}
      className={`group relative flex flex-col items-center gap-1 rounded-field border p-1.5 transition-colors duration-[120ms] ${
        lit
          ? 'border-accent bg-accent-quiet'
          : 'border-transparent bg-bg-input hover:border-border-strong hover:bg-bg-elevated'
      }`}
    >
      <span
        className={`absolute right-1 top-1 z-10 font-numeric text-[9px] leading-none ${
          lit ? 'text-accent' : 'text-text-muted'
        } opacity-60`}
        aria-hidden
      >
        {def.digit}
      </span>
      <span
        className="relative block shrink-0 overflow-hidden rounded-[3px] bg-bg-app ring-1 ring-border"
        style={{ width: frame.w, height: frame.h }}
      >
        <span
          ref={(el) => register(def.id, el)}
          className="absolute inset-0 block will-change-transform"
          style={{ transform: 'translate(0%, 0%) scale(1)' }}
          aria-hidden
        >
          {/* A stand-in for his footage. Not a photograph: a horizon, a bright
              thing left of centre and a band along the bottom, which is the
              least it takes for a zoom AND a slide across to both be obvious at
              forty pixels tall. */}
          <span className="absolute inset-0 block bg-gradient-to-b from-accent-quiet via-transparent to-transparent" />
          <span className="absolute inset-x-0 top-[46%] block h-px bg-border-strong" />
          <span className="absolute left-[20%] top-[22%] block h-[30%] w-[24%] rounded-[2px] bg-accent/70" />
          <span className="absolute bottom-[14%] left-[12%] right-[12%] block h-[16%] rounded-[2px] bg-text-muted/30" />
        </span>
      </span>
      <span
        className={`flex h-[22px] items-center text-center text-[9.5px] leading-[1.15] ${
          lit ? 'text-accent' : 'text-text-secondary'
        }`}
      >
        {def.name}
      </span>
    </button>
  )
}

/**
 * The little frame, in the shape of HIS sequence. A Short is 9:16, so the tile
 * is tall and narrow, and a move that looks right in a wide box would be a lie
 * about what it does to his picture.
 */
function frameSize(aspect: number): { w: number; h: number } {
  const h = aspect >= 1 ? 44 : 68
  return { w: Math.round(h * aspect), h }
}

/**
 * The bar under the tiles: what is on this clip, drawn across the clip itself,
 * with the ends of the move draggable.
 *
 * It answers "what did that tile just do" without a word, and dragging an end is
 * the answer to the one thing a shelf of whole-clip moves cannot otherwise say:
 * start the sweep three seconds in. Retiming is a PARAMETER of the move, so the
 * tile stays lit through it.
 */
function MoveRibbon({ clip, def, startS, endS }: { clip: Clip; def: MoveDef; startS: number; endS: number }) {
  const durS = Math.max(1e-6, clipDurationS(clip))
  const barRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<{ startS: number; endS: number } | null>(null)
  const shown = draft ?? { startS, endS }
  const left = (shown.startS / durS) * 100
  const right = (shown.endS / durS) * 100
  const moment = def.window === 'moment'
  const span = endS - startS

  const drag = (edge: 'start' | 'end') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const bar = barRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const at = (clientX: number): number => ((clientX - rect.left) / Math.max(1, rect.width)) * durS
    const move = (ev: PointerEvent): void => {
      const t = Math.max(0, Math.min(durS, at(ev.clientX)))
      // A moment-long move keeps its length and simply lands somewhere else; a
      // clip-length move has two ends that move independently.
      const next =
        moment || edge === 'start'
          ? { startS: moment ? t : Math.min(t, shown.endS - 1 / 30), endS: moment ? t + span : shown.endS }
          : { startS: shown.startS, endS: Math.max(t, shown.startS + 1 / 30) }
      setDraft(next)
      setMoveWindow(clip.id, next.startS, next.endS)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The beats, drawn where they actually are: these are the clip's OWN keyframe
  // times, so the bar cannot show a shape the clip is not making.
  const beats = channelKeyframes(clip, 'scale').map((k) => (k.t / durS) * 100)
  const handle =
    'absolute top-0 h-full w-[7px] cursor-ew-resize rounded-[2px] bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.35)]'
  return (
    <div className="flex flex-col gap-1" data-testid="move-ribbon">
      <div ref={barRef} className="relative h-5 w-full overflow-hidden rounded-field bg-bg-input">
        <div
          className="absolute top-0 h-full rounded-[3px] bg-accent/25 ring-1 ring-inset ring-accent/40"
          style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }}
        />
        {beats.map((px, i) => (
          <div key={i} className="absolute top-1 h-3 w-px bg-accent/70" style={{ left: `${px}%` }} aria-hidden />
        ))}
        <div className={handle} style={{ left: `calc(${left}% - 1px)` }} data-testid="move-ribbon-start" onPointerDown={drag('start')} />
        {!moment && (
          <div className={handle} style={{ left: `calc(${right}% - 6px)` }} data-testid="move-ribbon-end" onPointerDown={drag('end')} />
        )}
      </div>
      <p className="text-[10px] leading-tight text-text-muted">
        {moment ? 'Drag the block to move when it happens' : 'Drag either end to move where it starts and ends'}
      </p>
    </div>
  )
}

/**
 * The shelf. `clips` is every clip the tiles will act on: one when he has one
 * selected, all of them when he has the whole Short selected.
 */
export function MoveShelf({ clips }: { clips: Clip[] }) {
  const depth = useStore((s) => s.ui.punchDepth)
  const riseFrames = useStore((s) => s.ui.punchRiseFrames)
  const handTuneOpen = useStore((s) => s.ui.handTuneOpen)
  const setUI = useStore((s) => s.setUI)
  const seqWidth = useStore((s) => activeSequence(s.project).width)
  const seqHeight = useStore((s) => activeSequence(s.project).height)
  // Scalars only, so the shelf redraws when the format or the media changes and
  // on nothing else.
  const assetWidth = useStore((s) => (clips[0] ? s.project.assets[clips[0].assetId]?.width : undefined))

  const framesRef = useRef(new Map<MoveId, HTMLElement>())
  const [hot, setHot] = useState(false)

  const aspect = seqHeight > 0 ? seqWidth / seqHeight : 16 / 9
  const ceiling = headroomCeiling(assetWidth, seqWidth)
  const over = overHeadroom(depth, ceiling)

  // The lit tile, worked out fresh from the clips themselves on every draw.
  // Not memoised: it is nine small rebuilds per clip and it has to be right the
  // instant a keyframe changes, which is exactly what a cache would get wrong.
  const match = moveOnClips(clips)
  const single = clips.length === 1 ? clips[0] : null
  const lit = match?.id ?? null
  const litDef = MOVES.find((m) => m.id === lit) ?? null

  const samples = useMemo(
    () => new Map(MOVES.map((m) => [m.id, moveSamples(m, depth, riseFrames)])),
    [depth, riseFrames],
  )

  const register = (id: MoveId, el: HTMLElement | null): void => {
    if (el) framesRef.current.set(id, el)
    else framesRef.current.delete(id)
  }

  // ONE loop for the whole grid, and only while he is looking at it.
  useEffect(() => {
    const frames = framesRef.current
    const paint = (id: MoveId, p: number): void => {
      const el = frames.get(id)
      const table = samples.get(id)
      if (!el || !table) return
      const s = table[Math.min(table.length - 1, Math.max(0, Math.round(p * (table.length - 1))))]
      el.style.transform = `translate(${(s.dx * 100).toFixed(3)}%, ${(s.dy * 100).toFixed(3)}%) scale(${s.scale.toFixed(4)})`
    }
    if (!hot) {
      for (const id of frames.keys()) paint(id, 0)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, ((now - t0) / 1000) % PREVIEW_LOOP_S / PREVIEW_RUN_S)
      for (const id of frames.keys()) paint(id, p)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [hot, samples])

  // What is on the clip, in one word, for nothing. A selection whose clips do
  // not agree says so rather than picking one of them to speak for the rest.
  const stateWord =
    lit === null
      ? clips.length > 1
        ? 'Different moves'
        : 'Hand edited'
      : lit === 'none'
        ? 'No move'
        : (litDef?.name ?? '')

  return (
    <section className="flex flex-col gap-2.5 rounded-field bg-bg-elevated/50 p-2.5" data-testid="move-shelf">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Moves</h4>
        <span className="text-dense text-text-secondary" data-testid="move-state">
          {stateWord}
        </span>
        {clips.length > 1 && (
          <span className="text-dense text-text-muted">· all {clips.length}</span>
        )}
      </div>

      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(66, frameSize(aspect).w + 16)}px, 1fr))` }}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => setHot(false)}
        data-testid="move-grid"
      >
        {MOVES.map((def) => (
          <MoveTile
            key={def.id}
            def={def}
            lit={lit === def.id}
            aspect={aspect}
            register={register}
            onPick={() => applyMoveToSelection(def.id, clips.map((c) => c.id))}
          />
        ))}
      </div>

      {single && litDef && litDef.beats.length > 0 && match && (
        <MoveRibbon clip={single} def={litDef} startS={match.startS} endS={match.endS} />
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <label htmlFor="move-depth" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
            How big
          </label>
          <span
            className={`ml-auto font-numeric text-dense ${over ? 'text-warning' : 'text-accent'}`}
            data-testid="move-depth-readout"
            title={
              ceiling !== null
                ? `${assetWidth}px of picture in a ${seqWidth}px frame, so past ${pct(
                    ceiling,
                  )} it is being stretched and starts to soften. A warning, not a limit.`
                : undefined
            }
          >
            {pct(depth)}
          </span>
        </div>
        <input
          id="move-depth"
          type="range"
          data-testid="move-depth"
          aria-label="How big the move goes"
          className={`h-1 w-full cursor-pointer ${over ? 'accent-warning' : 'accent-accent'}`}
          min={DEPTH_MIN}
          max={DEPTH_MAX}
          step={0.01}
          value={depth}
          list="move-depth-notches"
          onChange={(e) => setMoveDepth(Number(e.target.value), clips.map((c) => c.id))}
        />
        <datalist id="move-depth-notches">
          {NOTCHES.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </div>

      <button
        type="button"
        data-testid="tune-by-hand"
        aria-expanded={handTuneOpen}
        className="self-start text-[10px] text-text-muted underline decoration-dotted underline-offset-2 transition-colors duration-[120ms] hover:text-text-secondary"
        onClick={() => setUI({ handTuneOpen: !handTuneOpen })}
      >
        {handTuneOpen ? 'Hide the hand controls' : 'Tune it by hand'}
      </button>
    </section>
  )
}
