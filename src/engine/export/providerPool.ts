// A bounded, LRU-evicting pool of per-clip demuxer + decoder providers, shared
// by the native (ffmpeg) and WebCodecs export paths.
//
// Export opens one mediabunny Input plus one CanvasSink (which owns a hardware
// VideoDecoder) per CLIP, not per asset, because two clips of the same file are
// read independently across a cross-dissolve. The old policy held every provider
// until the sweep passed the clip's end by 10 seconds, which is blind to how the
// timeline is CUT: at half-second cuts that is about 21 live decoders, at
// quarter-second cuts about 41. Past the platform's concurrent-decoder limit the
// decoders fall back to software or the export stalls outright, so the person
// with the most cuts pays the most.
//
// The 10 second margin still exists, because a transition into the NEXT clip
// samples this clip past its out point and the transition-duration UI caps at
// 10s. It is now the FLOOR of the policy rather than all of it: a hard ceiling
// closes the least recently used provider once the live count passes it.

import type { Id } from '../types'

/**
 * Output seconds a clip stays readable past its own end. Matches the maximum
 * transition duration the UI allows, because that is the only thing that reads a
 * clip after the sweep has left it.
 */
export const PROVIDER_REAP_MARGIN_S = 10

/**
 * Ceiling on live demuxer + decoder pairs. A single output frame reads at most
 * one clip per video track plus one extra for the far side of a transition, so 8
 * leaves headroom for a stacked timeline while staying well under the browser's
 * concurrent hardware-decoder limit. Providers in use by the CURRENT frame are
 * never evicted, so the ceiling can be exceeded briefly rather than break a
 * frame that genuinely needs more.
 */
export const DEFAULT_MAX_LIVE_PROVIDERS = 8

/** The only clip fields the pool needs to know when a clip goes out of reach. */
export interface PooledClipTiming {
  startS: number
  inS: number
  outS: number
  speed: number
}

/** Output time past which a clip's frames can never be asked for again. */
export function providerDeadAfterS(clip: PooledClipTiming): number {
  const durationS = (clip.outS - clip.inS) / Math.max(Math.abs(clip.speed) || 1, 1e-6)
  return clip.startS + durationS + PROVIDER_REAP_MARGIN_S
}

export interface ProviderPoolOptions<P> {
  /** Closes one provider. The pool guarantees exactly one call per provider. */
  close: (provider: P, id: Id) => void
  /** Overrides the ceiling. Tests use a small one; export uses the default. */
  maxLive?: number
}

interface Entry<P> {
  provider: P
  deadAfterS: number
  /** Frame counter at the last get/set, so the LRU victim is the stalest. */
  usedTick: number
}

export class ProviderPool<P> {
  private readonly entries = new Map<Id, Entry<P>>()
  private readonly closeOne: (provider: P, id: Id) => void
  private readonly maxLive: number
  private tick = 0
  /** Ids the ceiling closed, so a later miss can be counted as a re-open. */
  private readonly evictedByCeiling = new Set<Id>()
  /**
   * Providers the ceiling closed that a later frame asked for again. Each one
   * costs a re-open plus a re-seek. It stays at 0 on a normal forward sweep, and
   * a non-zero count is the signal that the ceiling is too low for this timeline.
   */
  reopens = 0

  constructor(opts: ProviderPoolOptions<P>) {
    this.closeOne = opts.close
    this.maxLive = Math.max(1, opts.maxLive ?? DEFAULT_MAX_LIVE_PROVIDERS)
  }

  /** Live provider count. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Opens a new output frame. Every provider touched from here until the next
   * call is pinned against eviction, so gathering several layers for one frame
   * can never close a provider that same frame is still reading.
   */
  beginFrame(): void {
    this.tick++
  }

  /** The live provider for a clip, marked as used by the current frame. */
  get(id: Id): P | undefined {
    const entry = this.entries.get(id)
    if (!entry) {
      if (this.evictedByCeiling.delete(id)) this.reopens++
      return undefined
    }
    entry.usedTick = this.tick
    return entry.provider
  }

  /** Adds a freshly opened provider, then closes the stalest ones over the cap. */
  set(id: Id, clip: PooledClipTiming, provider: P): void {
    this.entries.set(id, { provider, deadAfterS: providerDeadAfterS(clip), usedTick: this.tick })
    this.enforceCeiling()
  }

  /**
   * Closes every provider the sweep can no longer reach at output time t. Capped
   * at maxLive entries, so this is cheap enough to run on EVERY frame instead of
   * once per second of output, which used to leave a second of dead decoders open.
   */
  reap(t: number): void {
    for (const [id, entry] of this.entries) {
      if (t > entry.deadAfterS) this.drop(id, entry, false)
    }
  }

  /** Closes everything. Safe to call twice. */
  clear(): void {
    for (const [id, entry] of this.entries) this.drop(id, entry, false)
  }

  private enforceCeiling(): void {
    while (this.entries.size > this.maxLive) {
      let victimId: Id | undefined
      let victim: Entry<P> | undefined
      for (const [id, entry] of this.entries) {
        if (entry.usedTick === this.tick) continue // pinned by the frame being built
        if (!victim || entry.usedTick < victim.usedTick) {
          victim = entry
          victimId = id
        }
      }
      // Every live provider is feeding the current frame. Correctness beats the
      // ceiling: keep them all and let the next frame bring it back down.
      if (!victim || victimId === undefined) return
      this.drop(victimId, victim, true)
    }
  }

  private drop(id: Id, entry: Entry<P>, byCeiling: boolean): void {
    this.entries.delete(id)
    if (byCeiling) this.evictedByCeiling.add(id)
    this.closeOne(entry.provider, id)
  }
}
