// How the export reads one clip's frames: forward a frame at a time, and in
// reverse a window at a time. Moved out of exportWorker.ts (2026-10-07) so a
// stand-in decoder can count what it costs; the worker imports it unchanged.

import type { CanvasSink, WrappedCanvas } from 'mediabunny'
import { frameReached } from '../frameIndex'

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
}

interface BackWindow {
  /** Consecutive frames in presentation order. */
  frames: WrappedCanvas[]
  /** The frame right after the last one held, or null at the end of the file. */
  next: WrappedCanvas | null
  /** The first frame held is the file's first frame: nothing comes before it. */
  atStart: boolean
}

/** What a reverse window may hold, in bytes of decoded frames. */
export const REVERSE_WINDOW_BYTES = 128 * 1024 * 1024
/** Never fewer than this, so a 4K clip still saves most of its decodes. */
const MIN_REVERSE_FRAMES = 4
/** Never more: past this the saving is small and the memory is not. */
const MAX_REVERSE_FRAMES = 30

/**
 * How many frames a reversed clip of this size decodes at a time. Every frame
 * is a fresh RGBA canvas, 8.3 MB at 1080p, and his machine runs short of memory
 * (memoryBudget.ts), so the window is a byte budget: 16 frames at 1080p, 30 at
 * 720p, 4 at 4K.
 */
export function reverseWindowFrames(width: number, height: number): number {
  const bytes = Math.max(1, width) * Math.max(1, height) * 4
  return Math.max(MIN_REVERSE_FRAMES, Math.min(MAX_REVERSE_FRAMES, Math.floor(REVERSE_WINDOW_BYTES / bytes)))
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
  if (k === frames.length - 1 && back.next && frameReached(back.next.timestamp, sourceT, fps)) return null
  if (k + 1 < frames.length) {
    back.next = frames[k + 1]
    frames.length = k + 1
  }
  return frames[k]
}

/**
 * Decode the window that ends at sourceT: the frames from about backFrames
 * before it, up to the last one that has reached it.
 */
async function fillWindow(p: ClipProvider, sourceT: number): Promise<void> {
  void p.iterator.return?.(undefined)
  p.back = null
  const rate = p.fps && p.fps > 0 ? p.fps : 30
  const from = Math.max(0, sourceT - (p.backFrames - 1) / rate)
  p.iterator = p.sink.canvases(from)
  const frames: WrappedCanvas[] = []
  let next: WrappedCanvas | null = null
  let dropped = false
  for (let f = await nextFrame(p); f; f = await nextFrame(p)) {
    // The first frame is kept whatever it is: before the file's first frame, it is the answer.
    if (frames.length > 0 && !frameReached(f.timestamp, sourceT, p.fps)) {
      next = f
      break
    }
    frames.push(f)
    if (frames.length > p.backFrames) {
      frames.shift()
      dropped = true
    }
  }
  void p.iterator.return?.(undefined)
  // Opened at 0 with nothing dropped off the front, the first frame held is the file's first.
  p.back = { frames, next, atStart: from === 0 && !dropped }
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
