// Web Audio preview mixer (spec §4.2 audioGraph.ts). Decoded AudioBuffers are
// cached per asset and clips are scheduled onto one shared AudioContext;
// playback.ts anchors the transport clock to that context, making audio the
// MASTER clock so A/V stays in sync.

import { getBlob } from '../state/persistence'
import type { AutoLevel, Clip, Id, MediaAsset, Sequence, Track } from './types'

/** Sources start this far in the future so scheduling jitter can't clip the head. */
export const SCHEDULE_LATENCY_S = 0.05

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

export interface CompressorParams {
  threshold: number
  knee: number
  ratio: number
  attack: number
  release: number
  /** Post-compression makeup gain, dB — what lifts the evened signal back up. */
  makeupDb: number
}

/**
 * Compressor + makeup-gain settings for a loudness-equalization degree. Higher
 * degree = lower threshold, higher ratio, more makeup → a more even, louder
 * track. Pure so the mapping is unit-tested; the same params drive preview and
 * export. 'off' returns null (bypass).
 */
export function compressorParamsFor(level: AutoLevel | undefined): CompressorParams | null {
  switch (level) {
    case 'low':
      return { threshold: -18, knee: 10, ratio: 2, attack: 0.01, release: 0.25, makeupDb: 2 }
    case 'medium':
      return { threshold: -24, knee: 16, ratio: 3.5, attack: 0.006, release: 0.2, makeupDb: 4 }
    case 'high':
      return { threshold: -30, knee: 22, ratio: 6, attack: 0.003, release: 0.15, makeupDb: 6 }
    default:
      return null
  }
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
    console.warn(`OL Premiere audio: missing blob for "${asset.name}" (${asset.blobKey})`)
    return null
  }
  try {
    const bytes = await blob.arrayBuffer()
    return await ensureAudioContext().decodeAudioData(bytes)
  } catch (err) {
    console.warn(`OL Premiere audio: decode failed for "${asset.name}"`, err)
    return null
  }
}

/** Fire-and-forget decode so the first play() doesn't stall on decoding. */
export function prewarmAudio(assets: MediaAsset[]): void {
  for (const asset of assets) void getAudioBuffer(asset)
}

// Reversed buffers for reverse playback (Phase 7), cached per asset.
const reversedCache = new Map<Id, Promise<AudioBuffer | null>>()

export function getReversedAudioBuffer(asset: MediaAsset): Promise<AudioBuffer | null> {
  let pending = reversedCache.get(asset.id)
  if (!pending) {
    pending = (async () => {
      const src = await getAudioBuffer(asset)
      if (!src) return null
      const ctx = ensureAudioContext()
      // Mirror about the CONTAINER duration, not the decoded length. Callers
      // mirror the clip window about asset.durationS (effectiveAudioClip); if the
      // decoded audio track is shorter/longer than the container (common for
      // screen/phone recordings, or codec priming/padding), reversing about the
      // decoded length instead would time-shift the reversed audio by the
      // difference. Sizing the reversed buffer to the container and indexing from
      // its end keeps the two axes aligned. When they're equal this is identical
      // to a plain reverse (no regression).
      const n = src.length
      // Buffer length == the mirror axis (container), so its time axis lines up
      // with effectiveAudioClip's window exactly. Fall back to the decoded length
      // if durationS is missing/zero, which reduces to a plain reverse.
      const containerLen = asset.durationS > 0 ? Math.round(asset.durationS * src.sampleRate) : n
      const L = Math.max(1, containerLen)
      const rev = ctx.createBuffer(src.numberOfChannels, L, src.sampleRate)
      for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const from = src.getChannelData(ch)
        const to = rev.getChannelData(ch)
        for (let i = 0; i < L; i++) {
          const j = L - 1 - i
          to[i] = j >= 0 && j < n ? from[j] : 0
        }
      }
      return rev
    })()
    reversedCache.set(asset.id, pending)
  }
  return pending
}

/**
 * A reverse clip (speed < 0) played on a REVERSED buffer is identical to a
 * forward clip on that buffer with the in/out window mirrored about the source
 * duration. Returning that forward-equivalent lets every schedule/fade/gain
 * routine stay direction-agnostic. Forward clips pass through unchanged.
 */
export function effectiveAudioClip(clip: Clip, sourceDurationS: number): Clip {
  if (clip.speed >= 0) return clip
  return {
    ...clip,
    speed: Math.abs(clip.speed) || 1,
    inS: sourceDurationS - clip.outS,
    outS: sourceDurationS - clip.inS,
  }
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
/**
 * Whether a clip contributes audio: audio-track clips always do; a video-track
 * clip only when it is NOT linked (a linked video clip's audio lives on its
 * linked audio-track partner). Keeps linked A/V from doubling the sound.
 */
export function clipEmitsAudio(track: Track, clip: Clip): boolean {
  if (track.kind === 'audio') return true
  return clip.linkId === undefined
}

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

export interface GainPoint {
  /** Seconds after the schedule base time (baseT for preview, 0 for export). */
  offsetS: number
  value: number
}

/**
 * Piecewise-linear gain automation for a clip scheduled from `fromS`, combining
 * its static gain (`audioGainDb`) with fade-in/out ramps. Offsets are relative
 * to the schedule base (= the transport `fromS`); the FIRST point is the audible
 * start and should be applied with setValueAtTime, the rest with
 * linearRampToValueAtTime. Fades that would overlap on a short clip are scaled
 * down proportionally so the envelope stays a clean trapezoid. Returns null in
 * exactly the cases computeClipSchedule does (no audible contribution).
 */
export function clipGainEnvelope(clip: Clip, fromS: number): GainPoint[] | null {
  if (!computeClipSchedule(clip, fromS)) return null
  const g = dbToGain(clip.audioGainDb)
  const speed = Math.abs(clip.speed) || 1
  const winStart = clip.startS
  const winEnd = clip.startS + (clip.outS - clip.inS) / speed
  const winLen = winEnd - winStart

  let fin = Math.max(0, clip.fadeInS)
  let fout = Math.max(0, clip.fadeOutS)
  if (fin + fout > winLen && fin + fout > 0) {
    const k = winLen / (fin + fout)
    fin *= k
    fout *= k
  }

  const envAt = (x: number): number => {
    const fi = fin > 0 ? clamp((x - winStart) / fin, 0, 1) : 1
    const fo = fout > 0 ? clamp((winEnd - x) / fout, 0, 1) : 1
    return g * Math.min(fi, fo)
  }

  const audibleStart = Math.max(fromS, winStart)
  const times = new Set<number>([audibleStart, winEnd])
  if (fin > 0) times.add(winStart + fin)
  if (fout > 0) times.add(winEnd - fout)
  const sorted = [...times]
    .filter((x) => x >= audibleStart - 1e-9 && x <= winEnd + 1e-9)
    .sort((a, b) => a - b)
  return sorted.map((x) => ({ offsetS: Math.max(0, x - fromS), value: envAt(x) }))
}

// ---------------------------------------------------------------------------
// Master chain + stereo meter. One persistent master bus taps a splitter into
// two AnalyserNodes so the UI can draw an L/R level meter. Created lazily on the
// first play; the meter reads ~silence until then.

export interface MasterChain {
  master: GainNode
  analyserL: AnalyserNode
  analyserR: AnalyserNode
}

let masterChain: MasterChain | null = null

export function ensureMasterChain(): MasterChain {
  if (masterChain) return masterChain
  const ctx = ensureAudioContext()
  const master = ctx.createGain()
  const splitter = ctx.createChannelSplitter(2)
  const analyserL = ctx.createAnalyser()
  const analyserR = ctx.createAnalyser()
  for (const a of [analyserL, analyserR]) {
    a.fftSize = 1024
    a.smoothingTimeConstant = 0.5
  }
  master.connect(ctx.destination) // the audible path
  master.connect(splitter) // the meter tap
  splitter.connect(analyserL, 0)
  splitter.connect(analyserR, 1)
  masterChain = { master, analyserL, analyserR }
  return masterChain
}

/** Null until the first play has built the chain — the meter shows idle. */
export function getMasterChain(): MasterChain | null {
  return masterChain
}

/** Peak absolute amplitude (0..1) of an analyser's current time-domain window. */
export function readAnalyserPeak(analyser: AnalyserNode, buf: Float32Array): number {
  analyser.getFloatTimeDomainData(buf)
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > peak) peak = a
  }
  return peak
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

  // Audio comes from audio-track clips PLUS standalone (unlinked) video clips.
  // A linked video clip is video-only — its audio plays from the linked
  // audio-track clip, so counting it here would double the sound.
  const candidates: { clip: Clip; track: Track; sched: ClipSchedule; asset: MediaAsset; reversed: boolean }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      if (!clipEmitsAudio(track, clip)) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      const reversed = clip.speed < 0
      // A reverse clip schedules as its forward-equivalent on the reversed buffer.
      const eff = reversed ? effectiveAudioClip(clip, asset.durationS) : clip
      const sched = computeClipSchedule(eff, fromS)
      if (!sched) continue
      candidates.push({ clip: eff, track, sched, asset, reversed })
    }
  }

  const buffers = await Promise.all(
    candidates.map((c) => (c.reversed ? getReversedAudioBuffer(c.asset) : getAudioBuffer(c.asset))),
  )

  const { master } = ensureMasterChain()

  // One gain→[compressor]→pan chain per audible track, feeding the shared
  // master. Built lazily so a track with no audible clip costs nothing.
  const trackNodes = new Map<Id, { input: GainNode; nodes: AudioNode[] }>()
  const trackInputFor = (track: Track): GainNode => {
    const existing = trackNodes.get(track.id)
    if (existing) return existing.input
    const gain = ctx.createGain()
    gain.gain.value = dbToGain(track.volumeDb ?? 0)
    const pan = ctx.createStereoPanner()
    pan.pan.value = clamp(track.pan ?? 0, -1, 1)
    const nodes: AudioNode[] = [gain, pan]
    let tail: AudioNode = gain
    // Loudness equalization: a compressor + makeup gain on the track bus.
    const cp = compressorParamsFor(track.autoLevel)
    if (cp) {
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = cp.threshold
      comp.knee.value = cp.knee
      comp.ratio.value = cp.ratio
      comp.attack.value = cp.attack
      comp.release.value = cp.release
      const makeup = ctx.createGain()
      makeup.gain.value = dbToGain(cp.makeupDb)
      tail.connect(comp)
      comp.connect(makeup)
      nodes.push(comp, makeup)
      tail = makeup
    }
    tail.connect(pan)
    pan.connect(master)
    trackNodes.set(track.id, { input: gain, nodes })
    return gain
  }

  const clipNodes: { source: AudioBufferSourceNode; gain: GainNode }[] = []
  // One base time shared by every clip so relative offsets stay exact.
  const baseT = ctx.currentTime + SCHEDULE_LATENCY_S
  candidates.forEach(({ clip, track, sched }, i) => {
    const buffer = buffers[i]
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.abs(clip.speed)
    const gain = ctx.createGain()
    // Fade in/out + static gain, shared with the export mix by construction.
    const env = clipGainEnvelope(clip, fromS) ?? [{ offsetS: 0, value: dbToGain(clip.audioGainDb) }]
    env.forEach((pt, idx) => {
      const when = baseT + pt.offsetS
      if (idx === 0) gain.gain.setValueAtTime(pt.value, when)
      else gain.gain.linearRampToValueAtTime(pt.value, when)
    })
    source.connect(gain)
    gain.connect(trackInputFor(track))
    source.start(baseT + sched.whenOffsetS, sched.sourceOffsetS, sched.durationS)
    clipNodes.push({ source, gain })
  })

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    for (const { source, gain } of clipNodes) {
      try {
        source.stop()
      } catch {
        // stop() only throws before start(); every node here was started
      }
      source.disconnect()
      gain.disconnect()
    }
    // Tear down the per-track nodes too; the master chain persists for the meter.
    for (const { nodes } of trackNodes.values()) {
      for (const n of nodes) n.disconnect()
    }
  }
}
