// How the export reads one clip's frames: forward a frame at a time, and in
// reverse a window at a time. Moved out of exportWorker.ts (2026-10-07) so a
// stand-in decoder can count what it costs; the worker imports it unchanged.

import type { CanvasSink, WrappedCanvas } from 'mediabunny'
import { frameReached } from '../frameIndex'
import { pairTransitionAt } from '../render/resolve'
import { clipEndS } from '../timeline'
import type { Clip, Id, Sequence } from '../types'

// A per-clip monotonic frame reader. Random-access getCanvas() returns null on
// VFR / cue-less MediaRecorder webm inside a worker, so export pulls frames
// SEQUENTIALLY (canvases()) and holds the newest frame the requested source
// time has reached (frameReached: the NEAREST frame, the very one the paused
// preview shows). Classic pull-down. One Input per CLIP, so two clips
// of the same asset (e.g. across a cross-dissolve) read independently.
// A ProviderPool owns the lifetime of these (see providerPool.ts): it closes the
// least recently used one once the live count passes a ceiling, so the decoder
// count stops tracking how finely the timeline is cut.
export interface ClipProvider {
  /** Kept so the iterator can be re-opened for a backward (reverse-clip) seek. */
  sink: CanvasSink
  iterator: AsyncGenerator<WrappedCanvas, void, unknown>
  dispose: () => void
  started: boolean
  current: WrappedCanvas | null
  ahead: WrappedCanvas | null
  /** The source's frame rate, which sets the slots frames are picked by. */
  fps: number | undefined
  /** Reverse play: the frames just before the last one asked for, decoded once and served backward. */
  back: BackWindow | null
  /** How many decoded frames that window may hold (reverseWindowFrames). */
  backFrames: number
  /** The clip plays backward (speed below 0), so its first frame is read as a window too. */
  reverse: boolean
  /**
   * The lowest source time this clip is ever asked for (planReverseReading): its
   * in point, or for a reversed clip a transition's reach past its end. No
   * window starts before it.
   */
  lowestS: number
}

interface BackWindow {
  /** Consecutive frames in presentation order. */
  frames: WrappedCanvas[]
  /**
   * When the frame right after the last one held starts, or null at the end of
   * the file. Only its time: holding that frame too cost one more full canvas
   * per reversed clip, 33 MB at 4K (export review, 2026-10-08).
   */
  nextS: number | null
  /** The first frame held is the file's first frame: nothing comes before it. */
  atStart: boolean
}

/**
 * The share of the frame budget (memoryBudget.ts, budgets().frames) that every
 * reverse window of one export may hold together. A quarter: 128 MB at the
 * budget's ceiling, the fixed number this used to be, and much less on a
 * machine short of memory, which his is (memoryBudget.ts: 15 GB committed past
 * his RAM before the editor opens).
 */
const REVERSE_SHARE = 1 / 4
/** Never more frames than this: past it the saving is small and the memory is not. */
const MAX_REVERSE_FRAMES = 30

/** What all reverse windows of one export may hold together, in bytes. */
export function reverseBudgetBytes(frameBudgetBytes: number): number {
  return Number.isFinite(frameBudgetBytes) ? Math.max(0, Math.floor(frameBudgetBytes * REVERSE_SHARE)) : 0
}

/**
 * How many frames a reversed clip of this size decodes at a time, inside
 * `budgetBytes`. Every frame is a fresh RGBA canvas, 8.3 MB at 1080p and 33 MB
 * at 4K. With the whole 128 MB: 16 frames at 1080p, 30 at 720p, 4 at 4K.
 *
 * ⛔ THE BUDGET IS A CEILING, AT 4K TOO. A floor of four frames whatever the
 * budget, plus the frame after the window that was held as well, made 166 MB at
 * 4K against a stated 128 MB (export review, 2026-10-08). The window now counts
 * every frame it holds, and the only floor left is one frame, the least any
 * reader holds (a forward one holds two).
 */
export function reverseWindowFrames(width: number, height: number, budgetBytes: number): number {
  const bytes = Math.max(1, width) * Math.max(1, height) * 4
  return Math.max(1, Math.min(MAX_REVERSE_FRAMES, Math.floor(budgetBytes / bytes)))
}

/** How each clip of one export is read, worked out once from the timeline. */
export interface ReverseReading {
  /** What each reversed clip's window may hold, in bytes: the budget shared by those read at once. */
  windowBytes: number
  /** Per clip id: the lowest source time it is ever asked for (ClipProvider.lowestS). */
  lowestS: Map<Id, number>
  /**
   * Per REVERSED clip id: the output time from which it is never read again,
   * its end or the end of the transition that reads it past its end. The pool
   * closes it then (ProviderPool.set), not 10 s of output later.
   */
  doneAtS: Map<Id, number>
}

/**
 * ⛔ REVERSE WINDOWS STAY INSIDE THEIR CLIP AND INSIDE THE MACHINE'S BUDGET.
 * They used to start up to a window before the in point, holding frames the clip
 * never shows; live on until the pool closed the clip 10 s of output after its
 * end; and take a fixed 128 MB each. Two reversed clips in a dissolve held about
 * 280 MB, and a boomerang reel of five 1 s reversed clips back to back about
 * half a gigabyte (export review, 2026-10-08).
 *
 * Now the reverse share of `frameBudgetBytes` is split between the most
 * reversed clips the timeline ever reads at once, a window never reaches before
 * the lowest time its clip is asked for, and a reversed clip is closed the
 * moment its last read is behind the sweep.
 */
export function planReverseReading(seq: Sequence, frameBudgetBytes: number): ReverseReading {
  const lowestS = new Map<Id, number>()
  const doneAtS = new Map<Id, number>()
  const spans: [number, number][] = []
  for (const track of seq.tracks) {
    if (track.kind !== 'video') continue
    track.clips.forEach((clip: Clip, i) => {
      const next = track.clips[i + 1] as Clip | undefined
      // A transition into the next clip reads this one past its own end, for as
      // long as resolve.ts runs it, from the next clip's start.
      const pair = next ? pairTransitionAt(clip, next, seq.fps) : null
      const readEndS = pair && next ? next.startS + pair.d : clipEndS(clip)
      const rate = Math.abs(clip.speed || 1)
      const reversed = clip.speed < 0 && clip.freezeAtS === undefined
      // Reversed, the source runs back from the out point; past the end it keeps
      // going back, below the in point, at the same rate.
      const low = clip.freezeAtS ?? (reversed ? clip.inS - Math.max(0, readEndS - clipEndS(clip)) * rate : clip.inS)
      lowestS.set(clip.id, Math.max(0, low))
      if (reversed && clip.enabled) {
        doneAtS.set(clip.id, readEndS)
        spans.push([clip.startS, readEndS])
      }
    })
  }
  // The most reversed clips read at the same moment. Spans are half open, so
  // back to back clips never count twice.
  let atOnce = 1
  for (const [at] of spans) {
    let n = 0
    for (const [s, e] of spans) if (s <= at && at < e) n++
    atOnce = Math.max(atOnce, n)
  }
  return { windowBytes: Math.floor(reverseBudgetBytes(frameBudgetBytes) / atOnce), lowestS, doneAtS }
}

/** The reverse reading fields of a new provider for `clip`, a picture `width` x `height`. */
export function reverseReaderFor(
  clip: Clip,
  reading: ReverseReading,
  width: number,
  height: number,
): Pick<ClipProvider, 'back' | 'backFrames' | 'reverse' | 'lowestS'> {
  return {
    back: null,
    backFrames: reverseWindowFrames(width, height, reading.windowBytes),
    reverse: clip.speed < 0,
    lowestS: reading.lowestS.get(clip.id) ?? Math.max(0, clip.inS),
  }
}

/** Closes one provider's iterator and its demuxer. The pool calls this exactly once. */
export const closeProvider = (p: ClipProvider): void => {
  // p.iterator, not the one captured at creation, since a reverse re-seek may
  // have replaced it.
  void p.iterator.return?.(undefined)
  p.back = null
  p.dispose()
}

async function nextFrame(p: ClipProvider): Promise<WrappedCanvas | null> {
  const r = await p.iterator.next()
  return r.done ? null : r.value
}

/**
 * The frame for sourceT if the reverse window holds it, else null. It holds it
 * when it has the last frame that has reached sourceT and knows the one after
 * it has not. Frames after the answer are let go: reverse play only ever wants
 * this one or an earlier one next.
 */
function fromWindow(back: BackWindow, sourceT: number, fps: number | undefined): WrappedCanvas | null {
  const { frames } = back
  if (frames.length === 0) return null
  // Before the file's first frame: clamp to it, as the forward reader does.
  if (!frameReached(frames[0].timestamp, sourceT, fps)) return back.atStart ? frames[0] : null
  let k = 0
  while (k + 1 < frames.length && frameReached(frames[k + 1].timestamp, sourceT, fps)) k++
  // Asked for a later frame than the window reaches: not ours.
  if (k === frames.length - 1 && back.nextS !== null && frameReached(back.nextS, sourceT, fps)) return null
  if (k + 1 < frames.length) {
    back.nextS = frames[k + 1].timestamp
    frames.length = k + 1
  }
  return frames[k]
}

/**
 * Decode the window that ends at sourceT: the frames from about backFrames
 * before it, up to the last one that has reached it, and never from before the
 * lowest time the clip is asked for.
 */
async function fillWindow(p: ClipProvider, sourceT: number): Promise<void> {
  void p.iterator.return?.(undefined)
  p.back = null
  const rate = p.fps && p.fps > 0 ? p.fps : 30
  // ⛔ NOT BEFORE THE CLIP'S OWN FIRST FRAME. The last window of every reversed
  // clip used to reach a whole window before its in point and hold frames the
  // clip never shows. Never after sourceT either, whatever lowestS says.
  const from = Math.max(0, Math.min(sourceT, Math.max(p.lowestS, sourceT - (p.backFrames - 1) / rate)))
  p.iterator = p.sink.canvases(from)
  const frames: WrappedCanvas[] = []
  let nextS: number | null = null
  let dropped = false
  for (let f = await nextFrame(p); f; f = await nextFrame(p)) {
    // The first frame is kept whatever it is: before the file's first frame, it is the answer.
    if (frames.length > 0 && !frameReached(f.timestamp, sourceT, p.fps)) {
      nextS = f.timestamp
      break
    }
    // Room is made before the new one goes in, so the window never holds more than its size.
    if (frames.length === p.backFrames) {
      frames.shift()
      dropped = true
    }
    frames.push(f)
  }
  void p.iterator.return?.(undefined)
  // The first frame held is the file's first when nothing was dropped off the
  // front and either the reader was opened at 0 or ⛔ its first frame belongs to
  // a later slot than the time it was opened at, so nothing in the file comes
  // before it. A file whose first frame starts late (a recording with a start
  // offset) got neither and its reversed clip went black from there on,
  // refilling the same window every frame (export review, 2026-10-08). By slot,
  // not by a bare `>`: a decoder's frame times are rounded to microseconds, and
  // a frame a hair after `from` is still the frame shown at `from`.
  const atStart = !dropped && frames.length > 0 && (from === 0 || !frameReached(frames[0].timestamp, from, p.fps))
  p.back = { frames, nextS, atStart }
  p.started = true
  p.current = null
  p.ahead = null
}

/**
 * Advance the clip's sequential reader to the frame shown at sourceT.
 *
 * ⛔ THE NEAREST FRAME, NOT THE LAST ONE THAT STARTED. That floor put his
 * iPhone cuts 24.1 ms behind their sound on average, always late
 * (frameIndex.ts). The rule is the paused preview's own, so preview == export.
 */
export async function frameForClip(p: ClipProvider, sourceT: number): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
  // A REVERSE clip (speed < 0) requests DECREASING sourceT, and the reader is
  // forward-only. Without a re-seek the whole reversed clip would freeze on its
  // furthest-decoded frame (the preview reverses with a random-access cache).
  //
  // ⛔ A WINDOW AT A TIME, NOT A RE-SEEK PER FRAME. Every backward step used to
  // re-open the reader at the new time, and a re-open decodes forward from the
  // keyframe before it: on 60 fps OBS footage with a keyframe every 2 s, about
  // 60 decodes and a fresh decoder for every frame of a reversed clip, where a
  // forward one costs one (export audit, 2026-10-06). Now one decode run fills
  // a window of frames ending at the time asked for, and the frames before it
  // are served from that window as reverse play walks back through them. The
  // frame chosen is the same one the forward reader would land on.
  //
  // A reversed clip's FIRST frame is a window as well. The reader is opened at
  // the in point, and a reversed clip starts at its out point, so read forward
  // that one frame decoded and drew the whole slice before reverse play began.
  if (!p.started && p.reverse) {
    await fillWindow(p, sourceT)
    return p.back ? (fromWindow(p.back, sourceT, p.fps)?.canvas ?? null) : null
  }
  if (p.back) {
    const held = fromWindow(p.back, sourceT, p.fps)
    if (held) return held.canvas
    const first = p.back.frames[0]
    if (!first || !frameReached(first.timestamp, sourceT, p.fps)) {
      // Behind the window: the next one back.
      await fillWindow(p, sourceT)
      return fromWindow(p.back, sourceT, p.fps)?.canvas ?? null
    }
    // Forward again, past the window: the plain reader, from here.
    void p.iterator.return?.(undefined)
    p.back = null
    p.iterator = p.sink.canvases(Math.max(0, sourceT))
    p.started = false
    p.current = null
    p.ahead = null
  } else if (p.current && !frameReached(p.current.timestamp, sourceT, p.fps)) {
    await fillWindow(p, sourceT)
    return p.back ? (fromWindow(p.back, sourceT, p.fps)?.canvas ?? null) : null
  }
  if (!p.started) {
    p.started = true
    p.ahead = await nextFrame(p)
  }
  while (p.ahead && frameReached(p.ahead.timestamp, sourceT, p.fps)) {
    p.current = p.ahead
    p.ahead = await nextFrame(p)
  }
  // Before the first packet clamp to it; past the last, freeze on it.
  const w = p.current ?? p.ahead
  return w ? w.canvas : null
}
