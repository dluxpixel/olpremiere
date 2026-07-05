// Web Audio preview mixer (spec §4.2 audioGraph.ts). Decoded AudioBuffers are
// cached per asset and clips are scheduled onto one shared AudioContext;
// playback.ts anchors the transport clock to that context, making audio the
// MASTER clock so A/V stays in sync.

import { getBlob } from '../state/persistence'
import type { Clip, Id, MediaAsset, Sequence } from './types'

/** Sources start this far in the future so scheduling jitter can't clip the head. */
export const SCHEDULE_LATENCY_S = 0.05

export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

let sharedCtx: AudioContext | null = null

/** Lazy singleton — one AudioContext for the whole app. */
export function ensureAudioContext(): AudioContext {
  sharedCtx ??= new AudioContext()
  return sharedCtx
}

// Keyed by asset id and holding the in-flight Promise so concurrent callers
// dedupe; failures resolve to a cached null (warned once), never reject.
const bufferCache = new Map<Id, Promise<AudioBuffer | null>>()

export async function getAudioBuffer(asset: MediaAsset): Promise<AudioBuffer | null> {
  let pending = bufferCache.get(asset.id)
  if (!pending) {
    pending = decodeAssetAudio(asset)
    bufferCache.set(asset.id, pending)
  }
  return pending
}

async function decodeAssetAudio(asset: MediaAsset): Promise<AudioBuffer | null> {
  if (asset.kind === 'image' || !asset.hasAudio) return null
  const blob = await getBlob(asset.blobKey)
  if (!blob) {
    console.warn(`REEL audio: missing blob for "${asset.name}" (${asset.blobKey})`)
    return null
  }
  try {
    const bytes = await blob.arrayBuffer()
    return await ensureAudioContext().decodeAudioData(bytes)
  } catch (err) {
    console.warn(`REEL audio: decode failed for "${asset.name}"`, err)
    return null
  }
}

/** Fire-and-forget decode so the first play() doesn't stall on decoding. */
export function prewarmAudio(assets: MediaAsset[]): void {
  for (const asset of assets) void getAudioBuffer(asset)
}

export interface ClipSchedule {
  /** Seconds after "now" the source starts (0 = playhead is already inside the clip). */
  whenOffsetS: number
  /** Offset into the source asset, seconds. */
  sourceOffsetS: number
  /**
   * SOURCE-content seconds to play. AudioBufferSourceNode.start()'s duration
   * argument is consumed in buffer-content time (independent of playbackRate),
   * so the audible wall-clock length is durationS / |speed| — exactly the
   * clip's remaining timeline window.
   */
  durationS: number
}

/**
 * Pure schedule math for one clip against a transport start time `fromS`.
 * Returns null when the clip contributes no audio: disabled, reverse or
 * frozen speed (reverse audio is Phase 7; speed 0 never advances),
 * zero-length trim, or a timeline window that ends at/before `fromS`.
 */
export function computeClipSchedule(clip: Clip, fromS: number): ClipSchedule | null {
  if (!clip.enabled) return null
  if (clip.speed <= 0) return null
  const speed = clip.speed
  const sourceLenS = clip.outS - clip.inS
  if (sourceLenS <= 0) return null
  const endS = clip.startS + sourceLenS / speed
  if (endS <= fromS) return null
  const whenOffsetS = Math.max(0, clip.startS - fromS)
  const sourceOffsetS = clip.inS + Math.max(0, fromS - clip.startS) * speed
  return { whenOffsetS, sourceOffsetS, durationS: clip.outS - sourceOffsetS }
}

// resume() can stay pending forever under autoplay policy, so race a short
// timeout: scheduling proceeds either way and the transport falls back to
// performance.now() while the context stays suspended.
async function tryResume(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'running') return
  await Promise.race([
    ctx.resume().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ])
}

/**
 * Schedule every audible clip of `seq` from timeline time `fromS`.
 * Resolves to a stop() that tears the scheduled graph down exactly once.
 */
export async function scheduleAudio(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  fromS: number,
): Promise<() => void> {
  const ctx = ensureAudioContext()
  await tryResume(ctx)

  // Solo wins: if ANY track is soloed only solo tracks are audible,
  // otherwise every non-muted track is.
  const anySolo = seq.tracks.some((t) => t.solo)
  const audibleTracks = seq.tracks.filter((t) => (anySolo ? t.solo : !t.muted))

  // Clips on BOTH audio and video tracks count: a video clip carries its
  // asset's audio when asset.hasAudio — the REEL MVP has no separate linked
  // audio clips. getAudioBuffer() resolves null for silent/image assets.
  const candidates: { clip: Clip; sched: ClipSchedule; asset: MediaAsset }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      const sched = computeClipSchedule(clip, fromS)
      if (!sched) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      candidates.push({ clip, sched, asset })
    }
  }

  const buffers = await Promise.all(candidates.map((c) => getAudioBuffer(c.asset)))

  const nodes: { source: AudioBufferSourceNode; gain: GainNode }[] = []
  // One base time shared by every clip so relative offsets stay exact.
  const baseT = ctx.currentTime + SCHEDULE_LATENCY_S
  candidates.forEach(({ clip, sched }, i) => {
    const buffer = buffers[i]
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.abs(clip.speed)
    const gain = ctx.createGain()
    gain.gain.value = dbToGain(clip.audioGainDb)
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start(baseT + sched.whenOffsetS, sched.sourceOffsetS, sched.durationS)
    nodes.push({ source, gain })
  })

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    for (const { source, gain } of nodes) {
      try {
        source.stop()
      } catch {
        // stop() only throws before start(); every node here was started
      }
      source.disconnect()
      gain.disconnect()
    }
  }
}
