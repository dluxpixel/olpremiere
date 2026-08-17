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
//    clip's own keyframes, so the panel cannot lie about a clip that was edited
//    by hand: nudge one diamond and it says Hand edited instead.
// 3. ONE GESTURE, ONE UNDO STEP. A tile click, a slider drag, a bar drag.
//
// Everything the motion desk used to open with is still here, one click away
// under "Tune it by hand": the punch buttons, the lanes, the curve editor.
//
// WHAT CHANGED AFTER v0.1.55, AND WHY. He said the pictures "look just bad", and
// rule 1 was the half of it that was not built: all ten tiles drew the SAME grey
// box with the same pale bar in it, and the only thing that told Shake from
// Drift right was the hover animation. At rest, which is how the shelf spends
// almost all of its life, and permanently for anyone who has asked their system
// for less motion, it was a word list with decoration on it. moveGlyph.ts now
// draws every tile FROM ITS OWN MOVE, standing still: where the picture starts,
// how deep it goes and where it travels on top, and when all of that happens
// underneath. Cover the labels and the ten are still ten.
//
// WHAT IT COSTS, AND WHEN IT DRAWS. The ten pictures are worked out ONCE per
// (depth, rise, tile size) and are plain SVG after that: no images, no video, no
// canvas, no timers, nothing per frame, and no new dependency. The hover loop is
// the only moving part: it runs on ONE tile, writes two attributes per frame
// with no React render behind it, and does not start at all while the transport
// is playing, while a move preview is sweeping, or under reduced motion. The
// lit-tile lookup, which is ten small rebuilds per selected clip, is cached on
// the clip OBJECTS, so a shelf that is re-rendered for some other reason costs
// nothing and a clip whose keyframes changed is recomputed on the very next
// draw.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { channelKeyframes } from '../engine/effects/channels'
import { MOVES, MOVE_CHANNELS, isBuiltInMoveId, type MoveDef, type MoveId, type MoveMatch } from '../engine/moves'
import { clipDurationS } from '../engine/timeline'
import { activeSequence, type Clip } from '../engine/types'
import {
  appendMoveToSelection,
  applyMoveToSelection,
  canTakeASecondMove,
  dropMove,
  movesOnClips,
  setMoveDepth,
  setMoveWindow,
} from '../state/moveActions'
import { listMyMoves, removeMyMove, saveMyMove, type MyMove } from '../state/myMoves'
import { normaliseRecording } from '../engine/recordMove'
import { useStore } from '../state/store'
import { liveFrame, shelfGlyphs, TAPE_UNITS, type MoveGlyph } from './moveGlyph'
import { headroomCeiling, overHeadroom } from './headroom'
import { Button } from '../ui/Button'

/**
 * The slider's ends. It used to start at 1.05, and THAT ONE CONSTANT was the
 * whole reason a move could never pull back: the engine has always handled a
 * depth below 1, it was simply unreachable. His ask, 2026-08-14: *"go out and
 * go more out than it can before."*
 *
 * 50 percent is as far back as is worth going; past that the picture is a stamp
 * in the middle of the frame. 200 is as far as his footage stretches forward.
 */
const DEPTH_MIN = 0.5
const DEPTH_MAX = 2
/**
 * ⛔ EXACTLY 100 PERCENT IS NOT SETTLEABLE, and this band is what keeps it out
 * of reach. A move at 100 percent is no move: every preset compiles to flat
 * keyframes, they are then indistinguishable from each other, and the shelf
 * would light the wrong tile and rebuild the WRONG MOVE the moment the slider
 * left the middle. Measured 2026-08-14: `rightThenLeft` came back as
 * `leftThenRight`. Crossing the middle jumps to the far side, so a drag still
 * feels continuous and every value the engine sees makes a real move.
 * "No move at all" already has a control: the None tile.
 */
const NEUTRAL_BAND = 0.04
/** The four numbers that were on the shipped chips, kept as notches under the slider. */
const NOTCHES = [0.6, 0.8, 1.2, 1.4, 1.7]

/** Push a depth out of the dead middle, to whichever side it is nearer. */
function outOfNeutral(v: number, from: number): number {
  if (Math.abs(v - 1) >= NEUTRAL_BAND) return v
  // Coming from above, land below, and the other way round, so a drag crosses
  // rather than sticking to the edge it arrived at.
  return from > 1 ? 1 - NEUTRAL_BAND : 1 + NEUTRAL_BAND
}

/** How long a hovered tile takes to run through its move, and the pause before it loops. */
const PREVIEW_RUN_S = 1.9
const PREVIEW_LOOP_S = 2.5

/** The timing strip under each picture, in px. Its own units are percent of the move, so it can be any width. */
const TAPE_H = 11

const pct = (v: number): string => `${Math.round(v * 100)}%`

/**
 * His system setting, read where the loop would start. Nothing is lost by
 * honouring it: the tile is a complete, readable picture standing still, and the
 * hover loop only ever added a moving copy of what it already says.
 */
const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The little frame, in the shape of HIS sequence. A Short is 9:16, so the tile
 * is tall and narrow, and a move that looks right in a wide box would be a lie
 * about what it does to his picture.
 *
 * These two numbers are load bearing beyond this file: the right panel's default
 * width is measured from them (see useLayoutSizes), so changing them changes how
 * many tiles fit across.
 */
function frameSize(aspect: number): { w: number; h: number } {
  const h = aspect >= 1 ? 44 : 68
  return { w: Math.round(h * aspect), h }
}

/**
 * ONE TILE: the move itself, drawn.
 *
 * The top pane is the picture that is actually on screen, at up to three moments
 * of the move: where it starts (dashed), its deepest point when that is
 * somewhere neither end is, and where it ends (solid), with the route it travels
 * and an arrow on the longest leg of that route. The strip underneath is how
 * deep the move is across its own length, with a tick standing on it for every
 * moment the move has. Every number in both comes out of the move table through
 * the same builder that writes the keyframes.
 *
 * Memoised, so moving the pointer along the shelf re-renders the two tiles whose
 * state actually changed and not the other eight.
 */
const MoveTile = memo(function MoveTile({
  def,
  glyph,
  lit,
  stage,
  live,
  onPick,
  onHover,
  liveRef,
  headRef,
}: {
  def: MoveDef
  glyph: MoveGlyph
  lit: boolean
  stage: { w: number; h: number }
  live: boolean
  onPick: (id: MoveId) => void
  onHover: (id: MoveId | null) => void
  liveRef: RefObject<SVGGElement>
  headRef: RefObject<SVGLineElement>
}) {
  const ink = lit ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'
  return (
    <button
      type="button"
      data-testid={`move-tile-${def.id}`}
      aria-pressed={lit}
      // A shelf-only move has no key, and must not claim one. `String(undefined)`
      // would put the word "undefined" into the tooltip and hand a screen reader
      // a shortcut that does nothing.
      aria-keyshortcuts={def.digit === undefined ? undefined : String(def.digit)}
      title={def.digit === undefined ? `${def.name}: ${def.hint}` : `${def.name}: ${def.hint} (press ${def.digit})`}
      onClick={() => onPick(def.id)}
      onPointerEnter={() => onHover(def.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(def.id)}
      onBlur={() => onHover(null)}
      className={`group flex flex-col items-center gap-1 rounded-field border p-1.5 transition-colors duration-[120ms] ${
        lit
          ? 'border-accent bg-accent-quiet'
          : 'border-transparent bg-bg-input hover:border-border-strong hover:bg-bg-elevated'
      }`}
    >
      <span
        className={`block shrink-0 overflow-hidden rounded-[3px] bg-bg-app ring-1 transition-colors duration-[120ms] ${
          lit ? 'ring-accent/60' : 'ring-border'
        }`}
        style={{ width: stage.w, height: stage.h }}
      >
        <svg
          data-testid={`move-glyph-${def.id}`}
          width={stage.w}
          height={stage.h}
          viewBox={`0 0 ${stage.w} ${stage.h}`}
          className={`block transition-colors duration-[120ms] ${ink}`}
          aria-hidden
        >
          {glyph.marks.map((mark) => (
            <rect
              key={mark.kind}
              x={mark.rect.x}
              y={mark.rect.y}
              width={mark.rect.w}
              height={mark.rect.h}
              rx={1}
              fill="none"
              stroke="currentColor"
              strokeWidth={mark.kind === 'to' ? 1.25 : 1}
              strokeDasharray={mark.kind === 'from' ? '2 2' : undefined}
              opacity={mark.kind === 'to' ? 1 : mark.kind === 'peak' ? 0.72 : 0.5}
            />
          ))}
          {glyph.route !== '' && (
            <path d={glyph.route} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.75} />
          )}
          {glyph.head !== '' && <path d={glyph.head} fill="currentColor" />}
          {live && (
            <g ref={liveRef} data-testid={`move-live-${def.id}`} className="text-accent">
              <rect
                x={0}
                y={0}
                width={stage.w}
                height={stage.h}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>
      </span>

      {/* The digit that picks this move, on the strip rather than over the
          picture, where the shipped one sat on the corner of the frame. Ten of
          them line up down the left of the shelf and read as an index. */}
      <span className="flex w-full items-center gap-1">
        <span
          className={`w-2 shrink-0 text-right font-numeric text-[9px] leading-none ${
            lit ? 'text-accent' : 'text-text-muted'
          }`}
          aria-hidden
        >
          {def.digit}
        </span>
        <svg
          data-testid={`move-tape-${def.id}`}
          viewBox={`0 0 ${TAPE_UNITS} ${TAPE_H}`}
          preserveAspectRatio="none"
          className={`h-[11px] min-w-0 flex-1 transition-colors duration-[120ms] ${ink}`}
          aria-hidden
        >
          {glyph.tape !== '' && <path d={glyph.tape} fill="currentColor" opacity={0.16} />}
          <path
            d={glyph.tapeLine}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            opacity={0.85}
          />
          {glyph.beats.map((beat, i) => (
            <line
              key={i}
              x1={beat.x}
              x2={beat.x}
              y1={beat.y1}
              y2={beat.y2}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.6}
            />
          ))}
          {live && (
            <line
              ref={headRef}
              x1={0}
              x2={0}
              y1={0}
              y2={TAPE_H}
              className="text-accent"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </span>

      <span
        className={`flex min-h-[26px] items-center justify-center text-center text-dense leading-[1.15] ${
          lit ? 'font-medium text-text-primary' : 'text-text-secondary'
        }`}
      >
        {def.name}
      </span>
    </button>
  )
})

/**
 * The bar under the tiles: what is on this clip, drawn across the clip itself,
 * with the ends of the move draggable.
 *
 * It answers "what did that tile just do" without a word, and dragging an end is
 * the answer to the one thing a shelf of whole-clip moves cannot otherwise say:
 * start the sweep three seconds in. Retiming is a PARAMETER of the move, so the
 * tile stays lit through it.
 */
function MoveRibbon({
  clip,
  def,
  depth,
  startS,
  endS,
  other,
  name,
  onRemove,
}: {
  clip: Clip
  def: MoveDef
  depth: number
  startS: number
  endS: number
  /** The other half of a chain, carried into the retime so it is rewritten rather than cleared. */
  other?: { id: MoveId; depth: number; startS: number; endS: number }
  /** Named only on a chain, where two identical bars would otherwise say nothing about which is which. */
  name?: string
  onRemove?: () => void
}) {
  const durS = Math.max(1e-6, clipDurationS(clip))
  const barRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<{ startS: number; endS: number } | null>(null)
  const shown = draft ?? { startS, endS }
  const left = (shown.startS / durS) * 100
  const right = (shown.endS / durS) * 100
  const moment = def.window === 'moment'
  const span = endS - startS

  const drag = (edge: 'start' | 'end') => (e: ReactPointerEvent) => {
    // ⛔ LEFT BUTTON ONLY. Every other drag in the app already checks this, and
    // these two handles were the ones that did not: a right-click on the end of
    // a move started a real retime, swallowed the context menu, and left the
    // window listeners armed until he happened to press and release the left
    // button somewhere. Keyframe audit item 8, and the same handles that used to
    // lose the move outright. → olp-retime-cannot-lose-the-move
    if (e.button !== 0) return
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
      // The move is CARRIED, never re-guessed mid drag. Guessing is what made
      // the bar die under his cursor and the tile go dark. The other half of a
      // chain rides along for the same reason.
      setMoveWindow(clip.id, next.startS, next.endS, { id: def.id, depth, other })
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
  // times, so the bar cannot show a shape the clip is not making. On a chain each
  // bar draws only the beats inside its own window, or both bars would claim
  // every diamond on the clip and neither would describe the move it names.
  //
  // Told apart by the NEIGHBOUR's window rather than by this one, because this
  // one is moving under his cursor while the neighbour's is standing still.
  const beats = channelKeyframes(clip, 'scale')
    .filter((k) => !other || k.t < other.startS || k.t > other.endS)
    .map((k) => (k.t / durS) * 100)
  const handle =
    'absolute top-0 h-full w-[7px] cursor-ew-resize rounded-[2px] bg-accent shadow-[0_0_0_1px_rgba(0,0,0,0.35)]'
  return (
    <div className="flex flex-col gap-1" data-testid="move-ribbon">
      <div ref={barRef} className="relative h-5 w-full overflow-hidden rounded-field bg-bg-input">
        {/* ⛔ THE BLOCK IS THE GESTURE THE CAPTION ALREADY PROMISED. For a
            moment-long move the caption says "drag the block", and until now
            only the 7px handle at its left edge did anything, so he was aiming
            at a sliver to do the thing the sentence under it described. Sliding
            it is what `drag('start')` already means for a moment move: it keeps
            its length and lands somewhere else. Keyframe audit item 8. */}
        <div
          className={`absolute top-0 h-full rounded-[3px] bg-accent/25 ring-1 ring-inset ring-accent/40${
            moment ? ' cursor-ew-resize' : ''
          }`}
          data-testid={moment ? 'move-ribbon-block' : undefined}
          onPointerDown={moment ? drag('start') : undefined}
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
      <div className="flex items-baseline gap-2">
        {/* ⛔ THE NAME REPLACES THE HINT, AND THE HINT STILL HAS TO BE SOMEWHERE.
            On a chain two identical bars say nothing about which is which, so each
            one takes its move's name. Printing the gesture under both as well is
            the same sentence twice; printing it under neither is how a chained
            clip quietly loses the only instruction the bar ever carried. So the
            LAST bar keeps it, and the name sits above it. */}
        <p className="text-dense text-text-muted">
          {name ?? (moment ? 'Drag the block to move when it happens' : 'Drag either end to move where it starts and ends')}
        </p>
        {onRemove && (
          <button
            type="button"
            data-testid={`drop-move-${def.id}`}
            title={`Take ${def.name} off this clip`}
            aria-label={`Take ${def.name} off this clip`}
            onClick={onRemove}
            className="ml-auto text-dense text-text-muted transition-colors hover:text-danger"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

/** Two selections are the same selection when they hold the same clip OBJECTS, in the same order. */
const sameClips = (a: readonly Clip[], b: readonly Clip[]): boolean =>
  a.length === b.length && a.every((clip, i) => clip === b[i])

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
  const fps = useStore((s) => activeSequence(s.project).fps)
  // The transport, so a tile can never be animating while he is watching the
  // monitor. Both of these change twice per playback, not once per frame.
  const playing = useStore((s) => s.ui.playing)
  const previewing = useStore((s) => s.ui.previewingMove)
  // Scalars only, so the shelf redraws when the format or the media changes and
  // on nothing else.
  const assetWidth = useStore((s) => (clips[0] ? s.project.assets[clips[0].assetId]?.width : undefined))

  const liveRef = useRef<SVGGElement>(null)
  const headRef = useRef<SVGLineElement>(null)
  const [hover, setHover] = useState<MoveId | null>(null)

  const aspect = seqHeight > 0 ? seqWidth / seqHeight : 16 / 9
  const ceiling = headroomCeiling(assetWidth, seqWidth)
  const over = overHeadroom(depth, ceiling)

  const stage = useMemo(() => frameSize(aspect), [aspect])
  // The ten pictures, worked out once. Everything downstream of this is static
  // SVG: a re-render costs a reconcile and not a single sample.
  // HIS OWN MOVES, beside the shipped ones. Kept in state rather than read on
  // every render: localStorage is synchronous and this component redraws on
  // every playhead tick that changes the selection.
  const [mine, setMine] = useState<MyMove[]>(() => listMyMoves())
  const tiles = useMemo(() => [...MOVES, ...mine.map((m) => m.def)], [mine])
  const shelf = useMemo(() => shelfGlyphs(tiles, depth, riseFrames, stage, TAPE_H), [tiles, depth, riseFrames, stage])

  // The lit tile, worked out fresh from the clips themselves, then remembered
  // against the CLIP OBJECTS it was worked out from. Object identity is the one
  // cache key that cannot go stale here: every edit in this app replaces the clip
  // it touches, so a diamond nudged by hand is a new object and the answer is
  // recomputed on the very next draw, which is the objection that killed saved
  // presets the first time round. Without the cache the shelf pays ten rebuilds
  // per selected clip on every re-render, including every frame of the move
  // preview that runs the instant a tile is clicked.
  const cache = useRef<{ clips: readonly Clip[]; key: string; value: MoveMatch[] } | null>(null)
  const cacheKey = `${fps} ${riseFrames} ${seqWidth} ${seqHeight}`
  let runs: MoveMatch[]
  const cached = cache.current
  if (cached && cached.key === cacheKey && sameClips(cached.clips, clips)) {
    runs = cached.value
  } else {
    runs = movesOnClips(clips)
    cache.current = { clips, key: cacheKey, value: runs }
  }
  const match = runs.length === 1 ? runs[0] : null

  const single = clips.length === 1 ? clips[0] : null
  // Something to save: the clip carries motion of its own, whether a tile put it
  // there or he performed it by hand in the preview.
  const hasMotion = !!single && MOVE_CHANNELS.some((ch) => channelKeyframes(single, ch).length > 0)
  const [saveName, setSaveName] = useState('')
  const lit = match?.id ?? null
  // ⛔ SEARCHED ACROSS THE WHOLE SHELF, not just the shipped table. This read
  // MOVES alone, so a clip carrying one of HIS moves lit the tile and left the
  // name beside it blank: the shelf recognised the move and then said nothing.
  const litDef = tiles.find((m) => m.id === lit) ?? null
  // Every tile the clip is using, so a chain lights BOTH of the two it is made of.
  const litIds = useMemo(() => new Set(runs.map((r) => r.id)), [runs])
  /** The runs that can be drawn as bars: a move with beats in it, and one we still have the def for. */
  const bars = useMemo(
    () =>
      runs
        .map((run, index) => ({ run, index, def: tiles.find((m) => m.id === run.id) ?? null }))
        .filter((b): b is { run: MoveMatch; index: number; def: MoveDef } => !!b.def && b.def.beats.length > 0),
    [runs, tiles],
  )
  const chained = bars.length > 1

  // WHICH tile is allowed to move, if any. Playback wins, the move preview wins,
  // and his reduced-motion setting wins over both.
  const liveId = playing || previewing || reducedMotion() ? null : hover

  // Both handlers have to keep the same identity across renders or every tile
  // re-renders whenever any of them does, which is the whole point of memoising
  // the tile. The ids are UUIDs, so one string is a safe stand-in for the list.
  const idKey = clips.map((c) => c.id).join(' ')
  /**
   * Waiting for the SECOND move of a chain, and it lasts exactly one click.
   *
   * ⛔ A ONE SHOT, NEVER A MODE. A head/tail switch left sitting above the tiles
   * is a thing he sets on Tuesday and is caught by on Thursday, and this panel's
   * whole promise is that a tile does what its picture shows. So the shelf asks
   * for the second move, takes it, and forgets it was asking.
   *
   * The ref is what the handler reads, so arming cannot change `pick`'s identity
   * and re-render all ten memoised tiles under his pointer.
   */
  const [arming, setArming] = useState(false)
  const armed = useRef(false)
  const arm = useCallback((on: boolean) => {
    armed.current = on
    setArming(on)
  }, [])
  // A different selection is a different question, so the shelf stops waiting.
  useEffect(() => arm(false), [idKey, arm])
  const pick = useCallback(
    (id: MoveId) => {
      const ids = idKey === '' ? [] : idKey.split(' ')
      if (armed.current) {
        arm(false)
        appendMoveToSelection(id, ids)
        return
      }
      applyMoveToSelection(id, ids)
    },
    [idKey, arm],
  )
  const hoverTile = useCallback((id: MoveId | null) => setHover(id), [])

  // ONE loop, on ONE tile, and only the tile under the pointer. It writes a
  // transform and two coordinates straight onto the elements, so there is no
  // React render behind any of it: the same rule the rail's playhead follows.
  useEffect(() => {
    const g = liveRef.current
    const head = headRef.current
    if (!liveId || !g || !head) return
    const table = shelf.tables.get(liveId)
    if (!table || table.length === 0) return
    const paint = (p: number): void => {
      const { rect, tapeX } = liveFrame(table, p, shelf.axes)
      g.setAttribute(
        'transform',
        `translate(${rect.x.toFixed(2)} ${rect.y.toFixed(2)}) scale(${(rect.w / shelf.axes.stage.w).toFixed(4)} ${(
          rect.h / shelf.axes.stage.h
        ).toFixed(4)})`,
      )
      head.setAttribute('x1', tapeX.toFixed(2))
      head.setAttribute('x2', tapeX.toFixed(2))
    }
    paint(0)
    let raf = 0
    const t0 = performance.now()
    const step = (now: number): void => {
      const cycle = ((now - t0) / 1000) % PREVIEW_LOOP_S
      paint(Math.min(1, cycle / PREVIEW_RUN_S))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [liveId, shelf])

  // What is on the clip, in one word, for nothing. A selection whose clips do
  // not agree says so rather than picking one of them to speak for the rest.
  // A chain names BOTH of its moves, in the order they run.
  const stateWord = chained
    ? bars.map((b) => b.def.name).join(', then ')
    : lit === null
      ? clips.length > 1
        ? 'Different moves'
        : 'Hand edited'
      : lit === 'none'
        ? 'No move'
        : (litDef?.name ?? '')

  return (
    <section className="flex flex-col gap-3 rounded-field bg-bg-elevated/50 p-2.5" data-testid="move-shelf">
      {/* Label on the left, value on the right, the same shape as the How big
          row underneath. The shipped header put the state immediately after the
          word Moves, so the panel usually read "MOVES No move" and the state
          looked like part of the title. */}
      <div className="flex items-baseline gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">Moves</h4>
        <span className="ml-auto flex items-baseline gap-1.5">
          {clips.length > 1 && <span className="text-dense text-text-muted">all {clips.length}</span>}
          <span className="text-dense text-text-secondary" data-testid="move-state">
            {stateWord}
          </span>
        </span>
      </div>

      {/* The column gap stays at 4px because the right panel's default width was
          measured against it (useLayoutSizes). The crowding he was looking at is
          vertical: one tile's label was four pixels off the next row's picture. */}
      <div
        className="grid gap-x-1 gap-y-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(66, stage.w + 16)}px, 1fr))` }}
        data-testid="move-grid"
      >
        {tiles.map((def, i) => {
          const tile = (
            <MoveTile
              key={def.id}
              def={def}
              glyph={shelf.glyphs[i]}
              lit={litIds.has(def.id)}
              stage={stage}
              live={liveId === def.id}
              liveRef={liveRef}
              headRef={headRef}
              onPick={pick}
              onHover={hoverTile}
            />
          )
          if (isBuiltInMoveId(def.id)) return tile
          // ⛔ A SHELF THAT ONLY EVER GROWS IS ONE HE COMES TO RESENT. `removeMyMove`
          // was written and tested the same hour the saving was, and nothing called
          // it, which is exactly the shape the lasso was in: a thing the app could
          // do with no gesture leading to it.
          //
          // A SIBLING of the tile, never a child: a button inside a button is not
          // valid, and nesting one would swallow the tile's own click.
          return (
            <div key={def.id} className="group/mine relative">
              {tile}
              <button
                type="button"
                data-testid={`forget-move-${def.id}`}
                title={`Forget ${def.name}`}
                aria-label={`Forget ${def.name}`}
                onClick={() => {
                  removeMyMove(def.id)
                  setMine(listMyMoves())
                }}
                className="absolute -right-0.5 -top-0.5 rounded-[3px] bg-bg-elevated px-1 text-[9px] leading-[14px] text-text-muted opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/mine:opacity-100"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      {single && hasMotion && (
        <div className="flex items-center gap-1.5" data-testid="save-my-move">
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name this move"
            aria-label="Name this move"
            data-testid="save-my-move-name"
            className="min-w-0 flex-1 rounded-field border border-border bg-bg-input px-1.5 py-1 text-dense text-text-primary"
          />
          <Button
            variant="secondary"
            data-testid="save-my-move-go"
            disabled={saveName.trim() === ''}
            onClick={() => {
              const def = normaliseRecording(single, { seqWidth, seqHeight, fps })
              if (!def) return
              const saved = saveMyMove(saveName, def)
              if (!saved) return
              setMine(listMyMoves())
              setSaveName('')
              // ⛔ AND THE SLIDER GOES TO THE SIZE HE PERFORMED AT.
              //
              // His move takes the depth slider like every built-in, which is
              // what he asked for. But he performed it at one size and the slider
              // may be sitting at another, so clicking his own tile straight
              // after saving would hand him a shallower or deeper version of the
              // thing he had just made and called finished. `recordedDepth` is
              // the size his beats are measured against, and this is the one
              // place it is worth spending: after this, the slider governs.
              if (def.recordedDepth && Math.abs(def.recordedDepth - 1) > NEUTRAL_BAND) {
                setMoveDepth(def.recordedDepth)
              }
            }}
          >
            Save this move
          </Button>
        </div>
      )}

      {single &&
        bars.map((bar, i) => (
          <MoveRibbon
            key={`${bar.run.id}-${bar.index}`}
            clip={single}
            def={bar.def}
            depth={bar.run.depth}
            startS={bar.run.startS}
            endS={bar.run.endS}
            other={chained ? bars[i === 0 ? 1 : 0].run : undefined}
            name={chained ? bar.def.name : undefined}
            onRemove={chained ? () => dropMove(single.id, bar.index) : undefined}
          />
        ))}
      {single && chained && (
        <p className="-mt-2 text-dense text-text-muted">Drag either end of either bar to move when it happens</p>
      )}

      {/* ⛔ AND WHEN IT CANNOT BE FOLLOWED, IT SAYS SO RATHER THAN SHOWING NOTHING.
          Seven of the twelve tiles end up somewhere and stay there, so on most
          clips the offer above is simply absent, and an absent control teaches him
          nothing: he would look for it, not find it, and conclude the feature is
          broken. One sentence in its place gives the reason in his own terms, and
          the reason happens to be the rule the whole panel runs on. */}
      {bars.length === 1 && !canTakeASecondMove(clips[0], bars[0].run.endS) && (
        <p className="text-dense text-text-muted" data-testid="no-second-move">
          {bars[0].def.name} ends up there and stays, so nothing can follow it
        </p>
      )}

      {/* The second move, which is the whole of chaining as a gesture: one line
          that is only there when the clip has room for it, and which asks for the
          move rather than describing a slot. A clip holds two, his word, so the
          line disappears once the second one has landed. */}
      {bars.length === 1 && canTakeASecondMove(clips[0], bars[0].run.endS) && (
        <button
          type="button"
          data-testid="add-second-move"
          aria-pressed={arming}
          onClick={() => arm(!arming)}
          className={`self-start text-dense underline decoration-dotted underline-offset-2 transition-colors duration-[120ms] ${
            arming ? 'text-accent' : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {arming ? 'Pick the move that comes after it' : 'Add a second move'}
        </button>
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
          onChange={(e) =>
            setMoveDepth(outOfNeutral(Number(e.target.value), depth), clips.map((c) => c.id))
          }
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
        className="self-start text-dense text-text-muted underline decoration-dotted underline-offset-2 transition-colors duration-[120ms] hover:text-text-secondary"
        onClick={() => setUI({ handTuneOpen: !handTuneOpen })}
      >
        {handTuneOpen ? 'Hide the hand controls' : 'Tune it by hand'}
      </button>
    </section>
  )
}
