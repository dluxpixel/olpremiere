// Web Audio preview mixer (spec §4.2 audioGraph.ts). Decoded AudioBuffers are
// cached per asset and clips are scheduled onto one shared AudioContext;
// playback.ts anchors the transport clock to that context, making audio the
// MASTER clock so A/V stays in sync.

import { getBlob } from '../state/persistence'
import { denoisedBufferFor } from './denoise'
import { duckEnvelope } from './ducking'
import { evalChannel } from './keyframes'
import type { AutoLevel, Clip, Id, MediaAsset, Sequence, Track } from './types'
import { createSoftLimiter } from './audioLimiter'
import { timeStretchChannels } from './timeStretch'

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
  /** Post-compression makeup gain, dB: what lifts the evened signal back up. */
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

/**
 * Hang the loudness-equalization chain off `tail` and hand back the new tail.
 *
 * ⛔ ONE COPY, AND THAT IS THE ENTIRE POINT. These fifteen lines were written
 * twice, once in the live mixer and once in the export renderer, and each copy
 * carried a comment saying it matched the other. **A comment is not a
 * guarantee.** This repo has already shipped a preview that sounded right over
 * an export that did not, twice, and both times the cause was two pieces of code
 * that were supposed to agree and had no reason to.
 *
 * `collect` is handed every node it builds, because the live mixer has to
 * disconnect them again and the export renderer does not.
 */
export function connectAutoLevel(
  ctx: BaseAudioContext,
  tail: AudioNode,
  level: AutoLevel | undefined,
  collect?: (...made: AudioNode[]) => void,
): AudioNode {
  const cp = compressorParamsFor(level)
  if (!cp) return tail
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
  collect?.(comp, makeup)
  return makeup
}

let sharedCtx: AudioContext | null = null

// The chosen playback OUTPUT device (null = system default), persisted so the
// whole app plays to the device the user picked instead of always the OS
// default. Routed via AudioContext.setSinkId (Chromium 110+/Electron); an engine
// without it silently stays on the default output.
const AUDIO_OUTPUT_KEY = 'olpremiere:audio:output-device'
let outputDeviceId: string | null = (() => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(AUDIO_OUTPUT_KEY) : null
  } catch {
    return null
  }
})()

type SinkableCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** Whether this engine can route playback to a chosen output device at all. */
export const canPickAudioOutput = (): boolean =>
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

/**
 * ⛔ A REMEMBERED OUTPUT DEVICE THAT IS NO LONGER PLUGGED IN IS SILENT, AND
 * `setSinkId` DOES NOT ALWAYS COMPLAIN ABOUT IT, 2026-08-24.
 *
 * The chosen device is persisted, so it outlives the headphones he picked it on.
 * Come back without them and the app can route the whole mix at a device that is
 * not there: no error to catch, no log, a flat meter and a perfect picture. That
 * is one of the ways "the audio doesn't seem to be working" happens with nothing
 * wrong in the code, and it survives every restart because the id is in storage.
 *
 * So the id is checked against the devices that actually exist before it is
 * used, and forgotten when it is gone.
 *
 * ⚠️ ONLY WHEN THE LIST IS NON-EMPTY. Without microphone permission Chromium
 * hands back a list with no outputs in it at all, and treating that as "your
 * device is gone" would throw away a perfectly good choice the first time he
 * opened the app on a fresh profile.
 */
async function stillExists(id: string): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter((d) => d.kind === 'audiooutput')
    if (outputs.length === 0) return true
    return outputs.some((d) => d.deviceId === id)
  } catch {
    return true
  }
}

async function applyOutputSink(ctx: AudioContext, id: string | null): Promise<void> {
  const c = ctx as SinkableCtx
  if (typeof c.setSinkId !== 'function') return
  let target = id
  if (target && !(await stillExists(target))) {
    // Forget it, so this is decided once and not on every play.
    target = null
    outputDeviceId = null
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(AUDIO_OUTPUT_KEY)
    } catch {
      // Storage unavailable: the in-memory reset still gets him his sound back.
    }
  }
  // Device gone / permission denied: stay on the current sink rather than throw.
  await c.setSinkId(target ?? '').catch(() => {})
}

/** Lazy singleton, one AudioContext for the whole app. */
export function ensureAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext()
    if (outputDeviceId) void applyOutputSink(sharedCtx, outputDeviceId)
  }
  return sharedCtx
}

/** The chosen playback output device id (null = system default). */
export const getAudioOutputDevice = (): string | null => outputDeviceId

/**
 * Route ALL app playback to a chosen output device (null = system default) and
 * remember it. Applies live to the running context. The recording monitor shares
 * this choice, so the user picks their output once and both playback and the
 * "hear myself" monitor come out of it.
 */
export async function setAudioOutputDevice(id: string | null): Promise<void> {
  outputDeviceId = id
  try {
    if (typeof localStorage !== 'undefined') {
      if (id) localStorage.setItem(AUDIO_OUTPUT_KEY, id)
      else localStorage.removeItem(AUDIO_OUTPUT_KEY)
    }
  } catch {
    // Ignore storage failures (private mode / quota); the in-memory choice still applies.
  }
  if (sharedCtx) await applyOutputSink(sharedCtx, id)
}

// Keyed by asset id and holding the in-flight Promise so concurrent callers
// dedupe; failures resolve to a cached null (warned once), never reject.
// LRU-bounded by decoded PCM bytes: a large library previously kept EVERY
// asset's full float32 PCM in RAM forever (~23MB per stereo minute). Evicted
// entries simply re-decode on next use; anything actively scheduled is kept
// alive by the graph's own references.
const AUDIO_CACHE_MAX_BYTES = 256 * 1024 * 1024
const bufferCache = new Map<Id, Promise<AudioBuffer | null>>()
const bufferBytes = new Map<Id, number>()
let bufferTotalBytes = 0

function evictAudioOverflow(keepId: Id): void {
  // ⛔ REVERSED COPIES GO FIRST, and they used to not be here at all.
  //
  // A reversed buffer is the same size as the forward one and used to sit
  // OUTSIDE this budget entirely, never counted and never dropped, so the 256 MB
  // cap only ever guarded half of what this file holds. It is also the cheaper
  // of the two to lose: rebuilding it reverses a buffer that is usually still
  // resident, while dropping a forward buffer costs a decode from disk.
  for (const id of reversedCache.keys()) {
    if (bufferTotalBytes <= AUDIO_CACHE_MAX_BYTES) return
    if (id === keepId) continue
    bufferTotalBytes -= reversedBytes.get(id) ?? 0
    reversedBytes.delete(id)
    reversedCache.delete(id)
  }
  for (const id of bufferCache.keys()) {
    if (bufferTotalBytes <= AUDIO_CACHE_MAX_BYTES) return
    if (id === keepId) continue // never evict the entry we just decoded
    bufferTotalBytes -= bufferBytes.get(id) ?? 0
    bufferBytes.delete(id)
    bufferCache.delete(id)
  }
}

/**
 * Drop everything this file holds for one asset, for the moment it is deleted.
 *
 * The budget above bounds the total, so this is not what stops the cache growing
 * without end. What it stops is media he has thrown away holding a share of a
 * 256 MB budget that his remaining clips could be using.
 */
export function forgetAssetAudio(assetId: Id): void {
  bufferTotalBytes -= bufferBytes.get(assetId) ?? 0
  bufferBytes.delete(assetId)
  bufferCache.delete(assetId)
  bufferTotalBytes -= reversedBytes.get(assetId) ?? 0
  reversedBytes.delete(assetId)
  reversedCache.delete(assetId)
}

export async function getAudioBuffer(asset: MediaAsset): Promise<AudioBuffer | null> {
  let pending = bufferCache.get(asset.id)
  if (pending) {
    // LRU touch on both maps so hot assets stay resident.
    bufferCache.delete(asset.id)
    bufferCache.set(asset.id, pending)
    return pending
  }
  pending = decodeAssetAudio(asset).then((buf) => {
    // Account bytes when the decode actually lands (only if still cached, since
    // eviction may have raced a slow decode).
    if (buf && bufferCache.get(asset.id) === pending) {
      const bytes = buf.length * buf.numberOfChannels * 4
      bufferBytes.set(asset.id, bytes)
      bufferTotalBytes += bytes
      evictAudioOverflow(asset.id)
    }
    return buf
  })
  bufferCache.set(asset.id, pending)
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

/**
 * The same decode, AWAITABLE, so the boot card can report it honestly.
 *
 * The card's whole rule is that a row only ticks when real work has landed, so a
 * warm-up step needs something to wait on. Resolves with how many assets decoded,
 * and never rejects: a file that will not decode must not hold the app shut.
 */
export async function warmAudio(assets: MediaAsset[]): Promise<number> {
  const results = await Promise.all(assets.map((a) => getAudioBuffer(a).catch(() => null)))
  return results.filter(Boolean).length
}

// Reversed buffers for reverse playback (Phase 7), cached per asset.
const reversedCache = new Map<Id, Promise<AudioBuffer | null>>()
/** Bytes held per reversed copy, counted into the same total as the forward ones. */
const reversedBytes = new Map<Id, number>()

/**
 * Mirror a decoded buffer about the CONTAINER duration, not the decoded length.
 * Callers mirror the clip window about asset.durationS (effectiveAudioClip); if
 * the decoded audio track is shorter/longer than the container (common for
 * screen/phone recordings, or codec priming/padding), reversing about the
 * decoded length instead would time-shift the reversed audio by the difference.
 * Sizing the reversed buffer to the container and indexing from its end keeps
 * the two axes aligned. When they're equal this is identical to a plain
 * reverse (no regression). Pure: used by the cached raw path and the (uncached)
 * denoised path so both reverse identically.
 */
function reverseAboutContainer(src: AudioBuffer, asset: MediaAsset): AudioBuffer {
  const ctx = ensureAudioContext()
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
}

export function getReversedAudioBuffer(asset: MediaAsset): Promise<AudioBuffer | null> {
  let pending = reversedCache.get(asset.id)
  if (!pending) {
    pending = (async () => {
      const src = await getAudioBuffer(asset)
      if (!src) return null
      const rev = reverseAboutContainer(src, asset)
      // Accounted against the SAME budget as the forward buffers, on the same
      // terms: only if this entry is still the cached one, since an eviction can
      // race a slow reverse.
      if (reversedCache.get(asset.id) === pending) {
        const bytes = rev.length * rev.numberOfChannels * 4
        reversedBytes.set(asset.id, bytes)
        bufferTotalBytes += bytes
        evictAudioOverflow(asset.id)
      }
      return rev
    })()
    reversedCache.set(asset.id, pending)
  }
  return pending
}

/**
 * THE buffer resolver for a clip: the one place that decides which samples a
 * clip plays. Both mixers (live graph below, export's audioRender) route
 * through here, so preview==export can't diverge on audio processing.
 *
 * No `denoise` → the exact same cached promises as before (golden-safe,
 * byte-identical). With `denoise`, the raw decode is crossfaded against the
 * cached RNNoise pass at the clip's strength (engine/denoise.ts); if the wasm
 * can't load the clip falls back to raw: audibly un-denoised, never silent.
 * Reversal applies AFTER denoise so both directions play the same samples.
 */
export async function clipAudioBuffer(
  clip: Clip,
  asset: MediaAsset,
  reversed: boolean,
): Promise<AudioBuffer | null> {
  const strength = clip.denoise ?? 0
  if (strength <= 0) return reversed ? getReversedAudioBuffer(asset) : getAudioBuffer(asset)
  const src = await getAudioBuffer(asset)
  if (!src) return null
  const ctx = ensureAudioContext()
  const denoised = await denoisedBufferFor(asset, src, strength, (c, l, r) => ctx.createBuffer(c, l, r))
  const forward = denoised ?? src
  // Reversed+denoised is rare; recomputing the mirror on demand keeps the
  // cached reversed path untouched rather than doubling its cache keys.
  return reversed ? reverseAboutContainer(forward, asset) : forward
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
   * so the audible wall-clock length is durationS / |speed|, exactly the
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
  return clipEmitsAudioOn(track.kind, clip)
}

/**
 * The same rule for a caller that has the track's KIND and not the track: the
 * timeline draws clips from a kind and a height, and it needs this to know
 * whether a clip's own sound is audible and therefore worth drawing.
 *
 * One rule, one copy. D74's shape: two callers agreeing today is not a reason
 * to write it twice, because what he hears while editing and what the timeline
 * shows him must never be able to drift.
 */
export function clipEmitsAudioOn(kind: Track['kind'], clip: Clip): boolean {
  if (kind === 'audio') return true
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

/** What to hand an AudioBufferSourceNode for one clip. */
export interface ScheduledSource {
  buffer: AudioBuffer
  playbackRate: number
  /** Offset into `buffer`, seconds. */
  offsetS: number
  /** Seconds of `buffer` to play, in ITS content time. */
  durationS: number
}

/**
 * The buffer, rate and window to schedule one clip with, keeping his voice
 * where it is.
 *
 * ⛔ `playbackRate` alone cannot do this. It resamples, so 2x speed is also an
 * octave up, and that is the chipmunk. So a clip that is not at 1x gets its
 * audible slice time-stretched ahead of time and is then played at rate 1: the
 * length is unchanged and the pitch is his. A 1x clip is handed back untouched,
 * same buffer, no copy and no work, which is nearly every clip in a project.
 *
 * The stretched slice is exactly `durationS / speed` long, the same number
 * `computeClipSchedule` already promised the picture, so audio cannot drift
 * away from the frames it was cut against.
 */
export function pitchPreservedSource(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  speed: number,
  sched: ClipSchedule,
  anchorS?: number,
): ScheduledSource {
  const rate = Math.abs(speed) || 1
  if (rate === 1) {
    return { buffer, playbackRate: 1, offsetS: sched.sourceOffsetS, durationS: sched.durationS }
  }
  // ⛔ THE STRETCH IS ANCHORED TO THE CLIP, NOT TO THE PLAYHEAD, 2026-08-24, AND
  // UNTIL TODAY IT WAS THE OTHER WAY ROUND. That single choice is what made a
  // fader nudge cost hundreds of milliseconds of frozen main thread.
  //
  // The old key was `rate|sourceOffsetS|durationS`, and `sourceOffsetS` is
  // derived from the transport's `fromS`. A reschedule passes the LIVE time, so
  // the clip under the playhead produced a brand new key EVERY time and
  // re-stretched its whole remainder, synchronously, on the main thread. Every
  // mute, every fader move, every loop wrap. The comment below used to claim only
  // the first play paid; it was true of the clips AHEAD of the playhead and false
  // of the one he is listening to.
  //
  // Anchoring at the clip's own in point makes the key stand still: `end` is
  // `sourceOffsetS + durationS`, which is the clip's out point and never moves,
  // so one stretch per clip per session and every reschedule after it is free.
  // Slicing into an already stretched buffer is exact, because output time is
  // just source time over the rate.
  //
  // ⚠️ OPTIONAL, AND THE EXPORT DOES NOT PASS IT. The export renders each clip
  // once, into an offline context, so it has nothing to gain and the old
  // behaviour is one less thing to have changed underneath a byte-stability gate.
  const endS = sched.sourceOffsetS + sched.durationS
  const anchor =
    typeof anchorS === 'number' && Number.isFinite(anchorS)
      ? Math.max(0, Math.min(anchorS, sched.sourceOffsetS))
      : sched.sourceOffsetS
  const cacheKey = `${rate}|${anchor}|${endS}`
  const cached = stretchCache.get(buffer)?.get(cacheKey)
  if (cached) {
    const into = Math.max(0, (sched.sourceOffsetS - anchor) / rate)
    return { buffer: cached, playbackRate: 1, offsetS: into, durationS: Math.max(0, cached.duration - into) }
  }
  const sr = buffer.sampleRate
  const startFrame = Math.max(0, Math.min(buffer.length, Math.round(anchor * sr)))
  // Never promise more source than the buffer holds: a clip that runs off the
  // end of its asset went quiet before this change too.
  const srcFrames = Math.max(0, Math.min(Math.round((endS - anchor) * sr), buffer.length - startFrame))
  const outFrames = Math.round(srcFrames / rate)
  if (srcFrames === 0 || outFrames === 0) {
    return { buffer, playbackRate: rate, offsetS: sched.sourceOffsetS, durationS: sched.durationS }
  }

  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch).subarray(startFrame, startFrame + srcFrames))
  }
  const stretched = timeStretchChannels(channels, outFrames, sr)
  const out = ctx.createBuffer(buffer.numberOfChannels, outFrames, sr)
  for (let ch = 0; ch < stretched.length; ch++) out.copyToChannel(stretched[ch], ch)
  rememberStretch(buffer, cacheKey, out)
  const into = Math.max(0, (sched.sourceOffsetS - anchor) / rate)
  return { buffer: out, playbackRate: 1, offsetS: into, durationS: Math.max(0, outFrames / sr - into) }
}

/**
 * Stretched slices, kept so pressing play twice does not do the work twice.
 *
 * Measured 2026-08-14: a minute of stereo at 2x is about 70 ms, and a five
 * minute one is 600 ms. Every clip AHEAD of the playhead is scheduled from its
 * own in point, so its key does not move and every play after the first is
 * free; only the clip the playhead is sitting inside re-stretches, and only the
 * part of it still to come.
 *
 * A WeakMap on the decoded buffer means these die exactly when the asset's
 * audio does, and holding only a few per buffer keeps a session of speed
 * fiddling from growing without limit.
 */
const STRETCH_CACHE_PER_BUFFER = 3
const stretchCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>()

function rememberStretch(buffer: AudioBuffer, key: string, value: AudioBuffer): void {
  let slot = stretchCache.get(buffer)
  if (!slot) {
    slot = new Map()
    stretchCache.set(buffer, slot)
  }
  slot.set(key, value)
  while (slot.size > STRETCH_CACHE_PER_BUFFER) {
    const oldest = slot.keys().next()
    if (oldest.done) break
    slot.delete(oldest.value)
  }
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
  const speed = Math.abs(clip.speed) || 1
  const winStart = clip.startS
  const winEnd = clip.startS + (clip.outS - clip.inS) / speed
  const winLen = winEnd - winStart

  // Keyframed volume: sample dB at each knot; between knots every consumer
  // ramps LINEARLY IN AMPLITUDE (setValueAtTime/linearRampToValueAtTime and
  // the pure mixer's applyGainEnvelope agree, keeping all three mixers
  // byte-identical). Non-linear eases are approximated by subdividing their
  // interval into 8 knots, a bezier `curve` into 16. Without keyframes this
  // collapses to the old constant `g` and the envelope is byte-identical to
  // before.
  const volKfs = clip.keyframes?.volume
  const gAt =
    volKfs && volKfs.length > 0
      ? (x: number): number => dbToGain(evalChannel(volKfs, x - winStart, clip.audioGainDb))
      : (): number => dbToGain(clip.audioGainDb)

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
    return gAt(x) * Math.min(fi, fo)
  }

  const audibleStart = Math.max(fromS, winStart)
  const times = new Set<number>([audibleStart, winEnd])
  if (fin > 0) times.add(winStart + fin)
  if (fout > 0) times.add(winEnd - fout)
  if (volKfs) {
    for (let i = 0; i < volKfs.length; i++) {
      times.add(winStart + volKfs[i].t)
      const next = volKfs[i + 1]
      if (!next) continue
      const span = next.t - volKfs[i].t
      if (volKfs[i].ease === 'hold') {
        // Hold = freeze then SNAP: one knot just before the next keyframe, so
        // every consumer ramps over <=1ms (perceptually a step, still
        // click-safe), matching how the video channels honor hold exactly.
        times.add(winStart + next.t - Math.min(0.001, span / 2))
      } else if (volKfs[i].curve || volKfs[i].ease !== 'linear') {
        // A hand-shaped curve can overshoot its target and settle back inside
        // one segment, which a named ease never does, so it gets twice the
        // knots to stay within audible tolerance of what evalChannel draws.
        const knots = volKfs[i].curve ? 16 : 8
        for (let s = 1; s < knots; s++) times.add(winStart + volKfs[i].t + (span * s) / knots)
      }
    }
  }
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
  // The master limiter sits between the sum and the speakers, the same one the
  // export uses (engine/audioLimiter.ts). Transparent below its knee, so a
  // normal mix is untouched; past it, a levelled-up take is shaped instead of
  // hard-clipped by the device.
  const limiter = createSoftLimiter(ctx)
  master.connect(limiter.input)
  limiter.output.connect(ctx.destination) // the audible path
  // The meter taps the LIMITED signal, not the raw sum, so what the meter shows
  // is what he is actually hearing.
  limiter.output.connect(splitter) // the meter tap
  splitter.connect(analyserL, 0)
  splitter.connect(analyserR, 1)
  masterChain = { master, analyserL, analyserR }
  return masterChain
}

/** Null until the first play has built the chain, so the meter shows idle. */
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

  // One duck automation shared by every music track (see engine/ducking.ts).
  const duckEnv = duckEnvelope(seq.tracks, anySolo, fromS)

  // Audio comes from audio-track clips PLUS standalone (unlinked) video clips.
  // A linked video clip is video-only: its audio plays from the linked
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

  const buffers = await Promise.all(candidates.map((c) => clipAudioBuffer(c.clip, c.asset, c.reversed)))

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
    // Loudness equalization: a compressor + makeup gain on the track bus. The
    // export renderer calls this same function, see connectAutoLevel.
    let tail: AudioNode = connectAutoLevel(ctx, gain, track.autoLevel, (...made) => nodes.push(...made))
    // Music sits down under the voiceover: the shared duck automation rides a
    // dedicated gain so the fader/auto-level stay untouched.
    if (track.audioRole === 'music' && duckEnv) {
      const duck = ctx.createGain()
      duckEnv.forEach((pt, idx) => {
        const when = baseT + pt.offsetS
        if (idx === 0) duck.gain.setValueAtTime(pt.value, when)
        else duck.gain.linearRampToValueAtTime(pt.value, when)
      })
      tail.connect(duck)
      nodes.push(duck)
      tail = duck
    }
    tail.connect(pan)
    pan.connect(master)
    trackNodes.set(track.id, { input: gain, nodes })
    return gain
  }

  const clipNodes: { source: AudioBufferSourceNode; gain: GainNode }[] = []

  // ⛔ EVERY STRETCH HAPPENS BEFORE THE CLOCK IS READ, 2026-08-24, AND IT USED TO
  // HAPPEN AFTER. His words: *"sometimes I know it's just popping off. It's not
  // working."*
  //
  // `pitchPreservedSource` runs WSOLA SYNCHRONOUSLY on any clip that is not at 1x
  // and is not already in the stretch cache. This file's own measurement: about
  // 70 ms per stereo minute at 2x, 600 ms for a five minute one. The schedule
  // latency is 50 ms. So one long un-cached clip spent the whole budget while
  // `baseT` sat frozen above the loop, and by the time `start()` was called
  // `ctx.currentTime` had walked past it. Everything that follows from that is
  // exactly what he described:
  //   - a start time in the past plays IMMEDIATELY, so every clip inside the
  //     overrun fires at once, which is the burst,
  //   - `linearRampToValueAtTime` to a past time SNAPS to its target, so every
  //     fade-in collapses into a step, which is the click,
  //   - the transport then anchors the picture to a base the sound never used,
  //     so the two drift apart and stay apart.
  //
  // And the reschedule is the common path, not the rare one: the stretch cache
  // key carries `sourceOffsetS`, which comes from `fromS`, and a reschedule
  // passes the LIVE time, so the clip under the playhead is always a miss and
  // re-stretches its whole remainder. Every fader nudge, every mute, every loop
  // wrap paid that cost with the clock running.
  //
  // The export never had this: it starts sources at absolute offsets into an
  // OfflineAudioContext, where the same stall costs render time and nothing else.
  // That is why he says the export is fine.
  const plays = candidates.map(({ clip, sched }, i) => {
    const buffer = buffers[i]
    // `clip.inS` is the anchor: it makes the stretch cache key stand still across
    // a reschedule, so a fader nudge mid-playback costs nothing. See the docblock
    // on pitchPreservedSource.
    return buffer ? pitchPreservedSource(ctx, buffer, clip.speed, sched, clip.inS) : null
  })

  // One base time shared by every clip so relative offsets stay exact. Read AFTER
  // the last slow call above, so nothing can walk the clock past it.
  const baseT = ctx.currentTime + SCHEDULE_LATENCY_S
  candidates.forEach(({ clip, track, sched }, i) => {
    const play = plays[i]
    if (!play) return
    const source = ctx.createBufferSource()
    source.buffer = play.buffer
    source.playbackRate.value = play.playbackRate
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
    source.start(baseT + sched.whenOffsetS, play.offsetS, play.durationS)
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
