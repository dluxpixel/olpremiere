// MOVES: the shelf of finished camera moves.
//
// The unit of the old motion desk was the KEYFRAME and its unit of time was the
// PLAYHEAD, so saying "push in on the left, travel to the right, then come back
// out" cost seventeen separate actions and one of them silently ate another. The
// unit here is the whole MOVE and the unit of time is the CLIP, so the same
// sentence is one tile.
//
// Nothing under this file changes. A move is written as ordinary keyframes on
// scale / posX / posY through the same channel adapter every other builder uses,
// on curves read out of the ONE table in motion.ts, so it renders identically in
// preview and export and stays hand-editable in the lanes the instant it lands.
//
// Pure: no store, no DOM, no React. Same rule as motion.ts.

import { channelBase, channelKeyframes, withChannelKeyframes } from './effects/channels'
import { evalChannel } from './keyframes'
import { CURVE_EASE, MOTION_CURVES, withKeyframes, type MotionCurveName } from './motion'
import { quantizeToFrame } from './timecode'
import { clipDurationS, type AnimChannel, type Clip, type Keyframe } from './types'

/** The three channels a move owns. Cleared before every apply, so a second tile REPLACES the first. */
export const MOVE_CHANNELS: readonly AnimChannel[] = ['scale', 'posX', 'posY']

/**
 * When a beat happens, expressed against the move's window rather than against
 * the clock, so one table describes the same move on a 2 second clip and a 20
 * second one.
 *
 * - `frames` counts from the window's start (the snap of a punch: always whole
 *   frames, never stretched, which is what keeps a punch snappy on a long clip)
 * - `fromEnd` counts back from the window's end (the fall)
 * - `frac` is a share of the window (the travel, which SHOULD stretch)
 */
export type BeatAt = { frames: number } | { fromEnd: number } | { frac: number }

/** One moment of a move: when, how deep, where it looks, and how it leaves. */
export interface Beat {
  at: BeatAt
  /** 0 = the clip's own framing, 1 = the full chosen depth. Never outside [0, 1]. */
  d: number
  /** Where in the frame the move looks, as a share of it. 0.5 is dead centre. */
  aim: { x: number; y: number }
  /**
   * A shift that does NOT depend on the zoom, as a share of the frame. Right and
   * down are positive. Absent on every built-in move, and that is deliberate.
   *
   * ⛔ WHY THIS EXISTS, 2026-08-15. `aim` is multiplied by how far the zoom sits
   * from normal, so at normal size that multiplier is ZERO and the aim carries no
   * position at all. The ten built-ins are fine with that: every one of them
   * travels only while it is zoomed. **It means the beat model cannot express
   * "slide across at normal size", and it is why a move he records by hand could
   * not round-trip into a tile.** His ask, 2026-08-15: *"I want it to be just
   * like the built-in ten."*
   *
   * So position gained a term that stands on its own. A recorded move puts ALL of
   * its travel here and leaves `aim` at centre, which inverts exactly whatever
   * the zoom is doing. The ten keep `aim` and never set this, so they build the
   * identical keyframes they always did, and a test pins that.
   */
  shift?: { x: number; y: number }
  /** Shape of the segment LEAVING this beat, by name from MOTION_CURVES. 'linear' writes no curve. */
  curve: MotionCurveName | 'linear'
}

/** The ten and the tiles shipped beside them. A CLOSED union: MOVE_BY_ID is keyed by it. */
export type BuiltInMoveId =
  | 'none'
  | 'holdBig'
  | 'pushIn'
  | 'punchIn'
  | 'inAndOut'
  | 'pop'
  | 'leftThenRight'
  | 'rightThenLeft'
  | 'shake'
  | 'driftRight'
  | 'pullBack'
  | 'punchOut'
  | 'outAndIn'

/**
 * Any move a tile can be, including one HE recorded.
 *
 * ⛔ A saved move carries its own id (`mym-...`, from state/myMoves.ts) so two of
 * his own moves are told apart. The built-in union stays closed underneath,
 * because MOVE_BY_ID is keyed by it and must stay exhaustive.
 */
export type MoveId = BuiltInMoveId | `mym-${string}`

export interface MoveDef {
  id: MoveId
  /**
   * The key on his keyboard. Digits 0 to 9 were completely unbound.
   *
   * ⛔ OPTIONAL SINCE 2026-08-15, AND THE TEN THAT HAVE ONE NEVER MOVE. There are
   * ten digits and there are more than ten moves now, so a move added later is
   * shelf-only rather than renumbering the ten already in his hands. Muscle
   * memory beats tidiness: shifting `Push in` off 2 to make room would cost him
   * something real to gain nothing.
   */
  digit?: number
  /** His words. No tile name contains a word he would have to look up. */
  name: string
  /** One plain line, for the tooltip and the screen reader. Still no jargon. */
  hint: string
  /**
   * The size a RECORDED move was performed at, so re-applying it hands him back
   * what he saw rather than whatever the shelf slider happens to say. Absent on
   * every built-in: those take the slider, which is the point of them.
   */
  recordedDepth?: number
  /**
   * How long the move is:
   *
   * - `clip` fills its window, so it stretches with the clip and its window has
   *   two draggable ends. Its first beat is always at the window start and its
   *   last always at the window end, which is what lets the window be READ BACK
   *   off the keyframes instead of stored anywhere.
   * - `moment` takes a fixed number of frames and simply holds afterwards, so it
   *   has a start and no end. Dragging it moves WHEN it happens.
   */
  window: 'clip' | 'moment'
  beats: readonly Beat[]
}

const C = { x: 0.5, y: 0.5 }
/** Left and right thirds. Inside 0.28..0.72 at every depth, which is what keeps the picture's edge off screen. */
const L = { x: 0.28, y: 0.45 }
const R = { x: 0.72, y: 0.45 }

/**
 * THE TEN. Ordered by digit, which is the order they sit on the shelf.
 *
 * Every one of them is a move he would actually make in a Minecraft Short: push
 * in on a reveal, punch on a hit, travel across a build, pull back. Tile 6 is
 * his own sentence, word for word.
 *
 * Two invariants the tests hold this table to, because breaking either one puts
 * the edge of his footage on screen:
 *
 * 1. every `d` is inside [0, 1], so a move never shrinks the picture below the
 *    framing the clip already has;
 * 2. every `aim` is inside 0.28..0.72, so the shift a zoom pays for is always
 *    less than the room that zoom created.
 *
 * The `overshoot` curve is deliberately unused here: it travels past its target
 * on purpose, which is right on the way UP and shows black on the way down.
 */
export const MOVES: readonly MoveDef[] = [
  { id: 'none', digit: 0, name: 'None', hint: 'No move: the clip sits still, the way it is', window: 'moment', beats: [] },
  {
    id: 'holdBig',
    digit: 1,
    name: 'Hold big',
    hint: 'Starts big and stays big. Nothing moves',
    window: 'moment',
    // ONE keyframe. A lone keyframe holds everywhere, which is exactly what this
    // move means, and unlike a static size it can be taken off again with None.
    beats: [{ at: { frames: 0 }, d: 1, aim: C, curve: 'linear' }],
  },
  {
    id: 'pushIn',
    digit: 2,
    name: 'Push in',
    hint: 'Creeps bigger the whole way through, very slowly',
    window: 'clip',
    beats: [
      { at: { frames: 0 }, d: 0, aim: C, curve: 'smooth' },
      { at: { fromEnd: 0 }, d: 1, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'punchIn',
    digit: 3,
    name: 'Punch in',
    hint: 'Snaps bigger right at the start and stays there',
    window: 'moment',
    beats: [
      { at: { frames: 0 }, d: 0, aim: C, curve: 'snapIn' },
      { at: { frames: 5 }, d: 1, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'inAndOut',
    digit: 4,
    name: 'In and out',
    hint: 'Snaps in, sits there, drops back out at the end',
    window: 'clip',
    beats: [
      { at: { frames: 0 }, d: 0, aim: C, curve: 'snapIn' },
      { at: { frames: 5 }, d: 1, aim: C, curve: 'linear' },
      { at: { fromEnd: 5 }, d: 1, aim: C, curve: 'snapIn' },
      { at: { fromEnd: 0 }, d: 0, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'pop',
    digit: 5,
    name: 'Pop',
    hint: 'Starts big and settles back down to normal',
    window: 'moment',
    beats: [
      { at: { frames: 0 }, d: 1, aim: C, curve: 'settle' },
      { at: { frames: 15 }, d: 0, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'leftThenRight',
    digit: 6,
    name: 'Left, then right',
    hint: 'In on the left, across to the right, then back out',
    window: 'clip',
    // HIS SENTENCE. "I want the zoom to go to the left of the screen, and then it
    // zooms to the right, and then it zooms right back out."
    //
    // The hold at 0.30 is the beat the old build could not tell him he needed:
    // without it the picture starts creeping right the instant the punch lands
    // and the pause on the left he described never happens. Here it is a row in
    // a table and cannot be forgotten.
    beats: [
      { at: { frames: 0 }, d: 0, aim: L, curve: 'snapIn' },
      { at: { frames: 5 }, d: 1, aim: L, curve: 'linear' },
      { at: { frac: 0.3 }, d: 1, aim: L, curve: 'smooth' },
      { at: { frac: 0.72 }, d: 1, aim: R, curve: 'linear' },
      { at: { fromEnd: 5 }, d: 1, aim: R, curve: 'snapIn' },
      { at: { fromEnd: 0 }, d: 0, aim: R, curve: 'linear' },
    ],
  },
  {
    id: 'rightThenLeft',
    digit: 7,
    name: 'Right, then left',
    hint: 'The same the other way: in on the right, across to the left, back out',
    window: 'clip',
    beats: [
      { at: { frames: 0 }, d: 0, aim: R, curve: 'snapIn' },
      { at: { frames: 5 }, d: 1, aim: R, curve: 'linear' },
      { at: { frac: 0.3 }, d: 1, aim: R, curve: 'smooth' },
      { at: { frac: 0.72 }, d: 1, aim: L, curve: 'linear' },
      { at: { fromEnd: 5 }, d: 1, aim: L, curve: 'snapIn' },
      { at: { fromEnd: 0 }, d: 0, aim: L, curve: 'linear' },
    ],
  },
  {
    id: 'shake',
    digit: 8,
    name: 'Shake',
    hint: 'Hits, wobbles for a few frames, then stays big',
    window: 'moment',
    // The wobble is in WHOLE frames after the hit and never returns below the
    // clip's own size, so it reads as an impact rather than a bounce.
    beats: [
      { at: { frames: 0 }, d: 0, aim: C, curve: 'snapIn' },
      { at: { frames: 5 }, d: 1, aim: C, curve: 'linear' },
      { at: { frames: 7 }, d: 0.86, aim: { x: 0.46, y: 0.5 }, curve: 'linear' },
      { at: { frames: 9 }, d: 1, aim: { x: 0.54, y: 0.5 }, curve: 'linear' },
      { at: { frames: 11 }, d: 0.92, aim: { x: 0.48, y: 0.5 }, curve: 'linear' },
      { at: { frames: 13 }, d: 1, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'driftRight',
    digit: 9,
    name: 'Drift right',
    hint: 'Pushes in and slides across to the right in one slow move',
    window: 'clip',
    // One segment that changes size AND where it looks at the same time, which
    // is what makes it read as a drift rather than a zoom followed by a pan.
    beats: [
      { at: { frames: 0 }, d: 0.35, aim: { x: 0.34, y: 0.5 }, curve: 'smooth' },
      { at: { fromEnd: 0 }, d: 1, aim: { x: 0.68, y: 0.5 }, curve: 'linear' },
    ],
  },

  // --- The way back out ------------------------------------------------------
  //
  // HIS ASK, 2026-08-15: *"I want more presets to zoom out."*
  //
  // ⛔ AND THEY CANNOT BE THE PUSH TILES WITH A SMALLER SLIDER. `d` is a share of
  // the depth he picked, so a tile that ran 0 to 1 with the slider under 100
  // would build the SAME keyframes as one of the ten above, and `matchMove`
  // rebuilds every preset and compares: two tiles with one shape means the shelf
  // cannot say which one he is on. So these are TIME MIRRORS with their own
  // shape, and every one of them starts at the depth and comes back down.
  //
  // No digits. See MoveDef.digit: the ten in his hands keep theirs.
  {
    id: 'pullBack',
    name: 'Pull back',
    hint: 'Starts big and creeps back to normal the whole way through',
    window: 'clip',
    beats: [
      { at: { frames: 0 }, d: 1, aim: C, curve: 'smooth' },
      { at: { fromEnd: 0 }, d: 0, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'punchOut',
    name: 'Punch out',
    hint: 'Starts big and snaps back to normal right away, then stays',
    window: 'moment',
    beats: [
      { at: { frames: 0 }, d: 1, aim: C, curve: 'snapIn' },
      { at: { frames: 5 }, d: 0, aim: C, curve: 'linear' },
    ],
  },
  {
    id: 'outAndIn',
    name: 'Out and in',
    hint: 'Starts big, drops to normal, then grows back at the end',
    window: 'clip',
    beats: [
      { at: { frames: 0 }, d: 1, aim: C, curve: 'snapIn' },
      { at: { frames: 5 }, d: 0, aim: C, curve: 'linear' },
      { at: { fromEnd: 5 }, d: 0, aim: C, curve: 'snapIn' },
      { at: { fromEnd: 0 }, d: 1, aim: C, curve: 'linear' },
    ],
  },
]

/** True when this id names one of the shipped tiles rather than one he recorded. */
export const isBuiltInMoveId = (id: MoveId): id is BuiltInMoveId => !String(id).startsWith(`mym-`)

export const MOVE_BY_ID: Readonly<Record<BuiltInMoveId, MoveDef>> = Object.freeze(
  Object.fromEntries(MOVES.map((m) => [m.id, m])) as Record<MoveId, MoveDef>,
)

/** The move on a digit key, or undefined. */
export const moveByDigit = (digit: number): MoveDef | undefined => MOVES.find((m) => m.digit === digit)

/**
 * The rise, in frames, that a beat written as `{ frames: 5 }` actually means.
 * The table is written at the shipped default of 5 so it reads as real numbers;
 * a different rise scales those counts rather than shifting them.
 */
const TABLE_RISE_FRAMES = 5

export interface MoveBuildOptions {
  /** Target scale as a ratio of the clip's own size: 1.2 is 120 percent. */
  depth: number
  riseFrames?: number
  seqWidth: number
  seqHeight: number
  /** Window start in LOCAL clip seconds. Defaults to the clip's first frame. */
  startS?: number
  /** Window end in LOCAL clip seconds. Defaults to the clip's last frame. `moment` moves ignore it. */
  endS?: number
}

interface MoveTrack {
  channel: AnimChannel
  kfs: Keyframe[]
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** A beat as a real keyframe: the named curve, plus the ease it degrades to. */
const beatKeyframe = (t: number, value: number, curve: Beat['curve']): Keyframe =>
  curve === 'linear'
    ? { t, value, ease: 'linear' }
    : { t, value, ease: CURVE_EASE[curve], curve: MOTION_CURVES[curve] }

/** Frame counts in the table are written at a rise of 5; a different rise scales them. */
const scaledFrames = (frames: number, riseFrames: number): number =>
  Math.round((frames * riseFrames) / TABLE_RISE_FRAMES)

function beatTimeS(at: BeatAt, fps: number, riseFrames: number, w0: number, w1: number): number {
  if ('frames' in at) return w0 + scaledFrames(at.frames, riseFrames) / fps
  if ('fromEnd' in at) return w1 - scaledFrames(at.fromEnd, riseFrames) / fps
  return w0 + at.frac * (w1 - w0)
}

/**
 * The beats that FIT, in order, on the frame grid.
 *
 * Two beats on one frame are one diamond to the eye and to the cursor, so a beat
 * that cannot clear a frame of daylight from the one before it is dropped: a 0.4
 * second clip degrades to a plain punch and a slide rather than six keyframes
 * stacked on one pixel. The LAST beat is never the one dropped, because it is
 * the one that brings the picture home.
 */
function fittedBeats(
  def: MoveDef,
  fps: number,
  durS: number,
  riseFrames: number,
  w0: number,
  w1: number,
): { beat: Beat; t: number }[] {
  const minGap = 1 / fps
  const eps = minGap / 100
  const raw = def.beats.map((beat) => ({
    beat,
    t: clamp(quantizeToFrame(beatTimeS(beat.at, fps, riseFrames, w0, w1), fps), 0, durS),
  }))
  if (raw.length === 0) return raw
  const kept: { beat: Beat; t: number }[] = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].t >= kept[kept.length - 1].t + minGap - eps) kept.push(raw[i])
  }
  const last = raw[raw.length - 1]
  if (kept[kept.length - 1] !== last) {
    while (kept.length > 1 && last.t < kept[kept.length - 1].t + minGap - eps) kept.pop()
    if (last.t >= kept[kept.length - 1].t + minGap - eps) kept.push(last)
  }
  return kept
}

/**
 * The keyframes a move is, given the framing the clip already has.
 *
 * The position maths is punchInClip's, unchanged: a point `f` px from the centre
 * lands at `f * r` once the frame is scaled by r, so the layer shifts by
 * `-f * (r - 1)` to hold that point still. The only difference is where the aim
 * comes from. It belongs to the MOVE now, one number per beat, instead of a
 * persisted global that quietly changed every punch everywhere.
 *
 * A channel that never leaves its base is not written at all: a flat lane of
 * diamonds that do nothing is noise in the one place he goes to read what a clip
 * is doing.
 */
export function buildMove(
  def: MoveDef,
  fps: number,
  durS: number,
  bases: { scale: number; posX: number; posY: number },
  options: MoveBuildOptions,
): MoveTrack[] {
  if (def.beats.length === 0) return []
  const riseFrames = Math.max(1, Math.round(options.riseFrames ?? TABLE_RISE_FRAMES))
  const w0 = clamp(options.startS ?? 0, 0, durS)
  const w1 = def.window === 'moment' ? durS : clamp(options.endS ?? durS, w0, durS)
  const beats = fittedBeats(def, fps, durS, riseFrames, w0, w1)
  if (beats.length === 0) return []

  const depth = options.depth
  const rows = beats.map(({ beat, t }) => {
    const r = 1 + beat.d * (depth - 1)
    const fx = (beat.aim.x - 0.5) * options.seqWidth
    const fy = (beat.aim.y - 0.5) * options.seqHeight
    // ⛔ ABS, NOT (r - 1). Below 1 the picture SHRINKS and (r - 1) goes negative,
    // which silently flips every sideways move: measured 2026-08-14, "Left, then
    // right" at depth 0.8 travelled right then left. The aim is a DIRECTION he
    // picked off a tile, so it has to read the same whether the move grows or
    // shrinks. The magnitude still scales with how far from neutral it goes.
    const travel = Math.abs(r - 1)
    // The zoom-independent term. Absent on every built-in, so those arrive here
    // as exactly `- fx * travel` and cannot have moved. See Beat.shift.
    const sx = (beat.shift?.x ?? 0) * options.seqWidth
    const sy = (beat.shift?.y ?? 0) * options.seqHeight
    return {
      t,
      curve: beat.curve,
      scale: bases.scale * r,
      posX: bases.posX - fx * travel + sx,
      posY: bases.posY - fy * travel + sy,
    }
  })

  const tracks: MoveTrack[] = []
  for (const channel of MOVE_CHANNELS) {
    const base = bases[channel as 'scale' | 'posX' | 'posY']
    const values = rows.map((row) => row[channel as 'scale' | 'posX' | 'posY'])
    // A channel that never leaves its base is dropped, so an ungraded clip stays
    // cheap and a sideways-free move writes no posX/posY.
    //
    // ⚠️ AT DEPTH EXACTLY 1.0 THIS DROPS EVERYTHING and the clip ends up with no
    // keyframes at all, so `matchMove` reports 'none' and the move is forgotten.
    // Keeping a flat scale track was tried and is WORSE: at depth 1 every move
    // compiles to the same flat keyframes, so `matchMove` cannot tell them
    // apart. Measured 2026-08-14: `rightThenLeft` came back as `leftThenRight`
    // and `driftRight` as `pushIn`, which would then silently rebuild as the
    // wrong move the moment the slider left 1.0. **The depth control is what
    // keeps 1.0 out of reach instead** (NEUTRAL_BAND in MoveShelf.tsx), because
    // a move at 100 percent is no move and that is what the None tile is for.
    if (values.every((v) => Math.abs(v - base) < 1e-6)) continue
    tracks.push({
      channel,
      // The last keyframe terminates linear with no curve, the way every builder
      // in motion.ts terminates: there is no segment leaving it to shape.
      kfs: rows.map((row, i) => beatKeyframe(row.t, values[i], i === rows.length - 1 ? 'linear' : row.curve)),
    })
  }
  return tracks
}

/**
 * Take every move off a clip, keeping the framing it has when it is standing
 * still. An empty keyframe list de-animates a channel and leaves its base alone,
 * which is what shipped `removeZoom` relies on.
 */
export function clearMoveChannels(clip: Clip): Clip {
  return MOVE_CHANNELS.reduce((c, channel) => withChannelKeyframes(c, channel, []), clip)
}

/**
 * Put a move on a clip. ONE clip, pure, immutable.
 *
 * CLEARS FIRST, always. Clicking a second tile REPLACES the first rather than
 * stacking on top of it, which is what makes one clip mean one move, and what
 * makes the lit tile on the shelf true.
 */
export function applyMove(clip: Clip, fps: number, def: MoveDef, options: MoveBuildOptions): Clip {
  const cleared = clearMoveChannels(clip)
  if (def.beats.length === 0) return cleared
  const bases = {
    scale: channelBase(cleared, 'scale'),
    posX: channelBase(cleared, 'posX'),
    posY: channelBase(cleared, 'posY'),
  }
  const tracks = buildMove(def, fps || 30, clipDurationS(clip), bases, options)
  let next = cleared
  for (const track of tracks) next = withKeyframes(next, track.channel, track.kfs)
  return next
}

/** What a clip's move looks like from the outside: which one, how deep, and over what window. */
export interface MoveMatch {
  id: MoveId
  /** Read back off the keyframes, never stored. */
  depth: number
  startS: number
  endS: number
}

/**
 * Half a frame AT THIS SEQUENCE'S OWN RATE: two keyframes closer than this are
 * the same moment.
 *
 * ⛔ THIS WAS HARDCODED TO 1/60 UNDER A COMMENT SAYING "half a frame at 30fps",
 * AND HIS FOOTAGE IS 60. At 60fps one whole frame IS 1/60, so a one frame hand
 * retime landed exactly on the tolerance and the panel could not see it: he
 * nudged a diamond, the shape on screen changed, and the tile stayed lit
 * claiming the clip still held the untouched preset. Found by the keyframe
 * audit, 2026-08-14, item 7.
 *
 * Derived from the rate instead, so it is half a frame at whatever he is
 * cutting. Keyframes are quantised to frame boundaries on both sides of this
 * comparison, so the only thing left inside the tolerance is float noise, which
 * is smaller than this by ten orders of magnitude.
 */
const timeTolS = (fps: number): number => 1 / (2 * (fps > 0 ? fps : 30))
const SCALE_TOL = 1e-3
const POS_TOL_PX = 0.5

function sameTracks(a: Clip, b: Clip, fps: number): boolean {
  const timeTol = timeTolS(fps)
  for (const channel of MOVE_CHANNELS) {
    const ka = channelKeyframes(a, channel)
    const kb = channelKeyframes(b, channel)
    if (ka.length !== kb.length) return false
    const tol = channel === 'scale' ? SCALE_TOL : POS_TOL_PX
    for (let i = 0; i < ka.length; i++) {
      if (Math.abs(ka[i].t - kb[i].t) > timeTol) return false
      if (Math.abs(ka[i].value - kb[i].value) > tol) return false
      // The SHAPE counts too, or two moves that happen to land the same two
      // numbers (a punch and a very short push) read as each other, and shaping
      // a curve by hand would not unlight the tile it no longer describes.
      if (ka[i].ease !== kb[i].ease) return false
      if (String(ka[i].curve ?? '') !== String(kb[i].curve ?? '')) return false
    }
  }
  return true
}

/**
 * WHICH move is on this clip, worked out fresh from the keyframes themselves.
 *
 * Nothing is recorded anywhere. Every move is rebuilt at this clip's own length,
 * its own window and its own depth and compared against what the clip actually
 * carries, so the shelf can never lie about a clip that was edited by hand: drag
 * one diamond two frames and no tile is lit any more. That is the answer to the
 * objection that killed presets the first time round, which was that a saved
 * record goes stale the moment someone touches a keyframe.
 *
 * The window is read back the same way: the first and last keyframe on the move
 * channels ARE the window, which is why dragging its ends retimes a move without
 * turning it into a hand edit.
 */
export function matchMove(
  clip: Clip,
  fps: number,
  options: { riseFrames?: number; seqWidth: number; seqHeight: number },
): MoveMatch | null {
  const durS = clipDurationS(clip)
  const times: number[] = []
  const scales: number[] = []
  for (const channel of MOVE_CHANNELS) {
    for (const k of channelKeyframes(clip, channel)) {
      times.push(k.t)
      if (channel === 'scale') scales.push(k.value)
    }
  }
  if (times.length === 0) return { id: 'none', depth: 1, startS: 0, endS: durS }

  const startS = Math.min(...times)
  const endS = Math.max(...times)
  const base = channelBase(clip, 'scale')
  // ⛔ THE DEPTH IS THE VALUE FURTHEST FROM THE BASE, NOT THE LARGEST. This used
  // to be Math.max, which is the same thing only while every move grows. A move
  // that SHRINKS has its extreme at the bottom, so the max was just the base
  // again, depth read as 1, the rebuild came out flat and the move matched
  // nothing: measured 2026-08-14, every zoom-out failed recognition and the
  // tile went dark. Furthest-from-base is right in both directions.
  let extreme = base
  for (const v of scales) {
    if (Math.abs(v - base) > Math.abs(extreme - base)) extreme = v
  }
  const depth = base !== 0 && Number.isFinite(extreme) ? extreme / base : 1
  for (const def of MOVES) {
    if (def.beats.length === 0) continue
    const rebuilt = applyMove(clip, fps, def, {
      depth,
      riseFrames: options.riseFrames,
      seqWidth: options.seqWidth,
      seqHeight: options.seqHeight,
      startS,
      endS,
    })
    if (sameTracks(clip, rebuilt, fps)) return { id: def.id, depth, startS, endS }
  }
  return null
}

/**
 * The little picture's own clock, shared by everything a tile is drawn from so
 * the samples and the beat times can never be measured against different
 * rulers. A `moment` move gets a tail on purpose: the hold AFTER the hit is
 * what tells Punch in apart from Push in, so it has to be part of the picture.
 */
const TILE_FPS = 30
const tileDurS = (def: MoveDef): number => (def.window === 'moment' ? 1.4 : 2)

/** One sampled instant of a move, for drawing it: a size and a shift in FRAME shares. */
export interface MoveSample {
  /** 0..1 through the move. */
  p: number
  scale: number
  /** Shift as a share of the frame's width / height, ready for a CSS translate. */
  dx: number
  dy: number
}

/**
 * A move sampled for the little picture on its tile, straight off the same
 * keyframe arrays the renderer reads, through the renderer's own evalChannel.
 * A tile can therefore never show a move the clip would not actually make.
 *
 * The frame is unit sized, so `dx` and `dy` come out as shares of the frame and
 * drop into a CSS translate untouched, at any aspect.
 */
export function moveSamples(def: MoveDef, depth: number, riseFrames: number, steps = 48): MoveSample[] {
  const durS = tileDurS(def)
  const tracks = buildMove(def, TILE_FPS, durS, { scale: 1, posX: 0, posY: 0 }, {
    depth,
    riseFrames,
    seqWidth: 1,
    seqHeight: 1,
  })
  const of = (channel: AnimChannel): readonly Keyframe[] => tracks.find((t) => t.channel === channel)?.kfs ?? []
  const scaleKfs = of('scale')
  const xKfs = of('posX')
  const yKfs = of('posY')
  const out: MoveSample[] = []
  for (let i = 0; i <= steps; i++) {
    const p = i / steps
    const t = p * durS
    out.push({
      p,
      scale: evalChannel(scaleKfs, t, 1),
      dx: evalChannel(xKfs, t, 0),
      dy: evalChannel(yKfs, t, 0),
    })
  }
  return out
}

/**
 * WHEN a move's moments land, on the same clock its samples use, read off the
 * keyframes buildMove actually writes rather than off the beat table. A beat
 * the builder DROPS because two of them would land on one frame is therefore a
 * tick the tile does not draw either, which is the whole reason this reads the
 * built keyframes and not `def.beats`.
 */
export function moveBeatTimes(def: MoveDef, depth: number, riseFrames: number): { durS: number; timesS: number[] } {
  const durS = tileDurS(def)
  const tracks = buildMove(def, TILE_FPS, durS, { scale: 1, posX: 0, posY: 0 }, {
    depth,
    riseFrames,
    seqWidth: 1,
    seqHeight: 1,
  })
  const seen = new Set<number>()
  for (const track of tracks) for (const k of track.kfs) seen.add(Math.round(k.t * 1e6) / 1e6)
  return { durS, timesS: [...seen].sort((a, b) => a - b) }
}
