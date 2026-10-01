// Offline render of the sequence's full audio mix to PCM. Runs on the MAIN
// thread: OfflineAudioContext is not reliably available in workers, and the
// decoded-AudioBuffer cache in audio.ts already lives here.

import { TruePeakLimiter } from '../audioLimiter'
import {
  clipEdges,
  clipEmitsAudio,
  clipGainEnvelope,
  clipAudioBuffer,
  computeClipSchedule,
  connectAutoLevel,
  createClipGain,
  DECODE_CONCURRENCY,
  dbToGain,
  effectiveAudioClip,
  mapLimit,
  onSampleGrid,
  pitchPreservedSource,
  isProvedSilent,
  type ClipEdges,
  trackAlignS,
  trackLateS,
  type ClipSchedule,
} from '../audio'
import { duckEnvelope } from '../ducking'
import { LoudnessMeter, platformGainDb } from '../loudness'
import type { Clip, Id, MediaAsset, Sequence, Track } from '../types'
import type { AudioStreamMeta } from './messages'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

export const EXPORT_SAMPLE_RATE = 48000
export const EXPORT_CHANNELS = 2

/**
 * Segment size for the streamed render: 30 s of 48 kHz stereo float32 is
 * ~11.5 MB per segment, so peak audio memory no longer scales with export
 * length (a 30-minute export used to allocate ~700 MB three times over).
 * 30 s = 300 exact AUDIO_CHUNK_FRAMES chunks, so the worker's AAC framing is
 * byte-identical to the old whole-range render.
 */
export const AUDIO_SEGMENT_FRAMES = 30 * EXPORT_SAMPLE_RATE

/**
 * Pre-roll rendered before each segment after the first and discarded. Gain
 * envelopes (clip fades, duck) are pure functions of absolute time, so they
 * are exact at any fromS; the ONE stateful node, the per-track auto-level
 * DynamicsCompressorNode (release ≤ 0.25 s), needs this run-in for its
 * envelope follower to converge to the continuous render. Audibly identical;
 * bit-identity only holds for tracks without auto-level, and for any export
 * that fits one segment (the golden-test case) which takes the zero-preroll
 * path and is byte-identical to the old code by construction.
 */
export const AUDIO_PREROLL_S = 1

export interface AudioMixPlan {
  info: AudioStreamMeta
  /** Render every segment in order, awaiting the consumer between segments. */
  render: (onSegment: (channelData: Float32Array<ArrayBuffer>[]) => void | Promise<void>) => Promise<void>
}

/**
 * Mixes every audible clip over [startS, endS) with the exact rules of
 * scheduleAudio: solo wins (any solo → only solo tracks, else non-muted), clips
 * on video AND audio tracks carry audio, disabled clips and speed <= 0 are
 * skipped, and a clip at |speed| plays a pitch-preserving stretch of its slice
 * at playbackRate 1 (see pitchPreservedSource). Returns null when there is nothing
 * audible or the platform has no AudioEncoder (older Safari). The export is
 * then video-only.
 *
 * `startS` is the schedule base, which is exactly what computeClipSchedule and
 * clipGainEnvelope already take as `fromS`: a clip whose window ends before it
 * drops out, and the rest report offsets relative to it. So the rendered PCM
 * begins at the work-area in point, matching the video's zero-based timestamps.
 */
/**
 * How many audio samples the mix renders for a range the video renders as
 * whole frames. The video path rounds the range UP to whole frames
 * (exportWorker.ts, nativeExport.ts: ceil(rangeS * fps)); the audio used to
 * round the same range up to whole SAMPLES on its own, and the two ceilings
 * land on different fractions, so a file could carry up to a frame of picture
 * with no sound under it. Derive the sample count from the frame count and the
 * two tracks end together, to within one sample.
 */
export function audioFramesFor(rangeS: number, fps: number, sampleRate: number): number {
  const rate = fps > 0 ? fps : 30
  const videoFrames = Math.max(1, Math.ceil(rangeS * rate))
  return Math.max(1, Math.round((videoFrames / rate) * sampleRate))
}

export interface AudioMixOptions {
  /**
   * Bring the whole mix to this integrated loudness (LUFS) before the limiter,
   * or leave its level alone when null. The export sets PLATFORM_TARGET_LUFS
   * unless he switched "Platform loudness" off for this video.
   */
  loudnessTargetLufs?: number | null
}

export async function planAudioMix(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  startS = 0,
  endS = seq.durationS,
  /** Told which files gave no sound when SOME did, so the caller can warn him before he uploads. */
  onPartialAudio?: (fileNames: string[]) => void,
  opts: AudioMixOptions = {},
): Promise<AudioMixPlan | null> {
  if (!('AudioEncoder' in globalThis)) return null
  const rangeS = endS - startS
  if (rangeS <= 0) return null

  const anySolo = seq.tracks.some((t) => t.solo)
  const audibleTracks = seq.tracks.filter((t) => (anySolo ? t.solo : !t.muted))

  const candidates: { clip: Clip; track: Track; asset: MediaAsset; reversed: boolean; edges: ClipEdges }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      if (!clipEmitsAudio(track, clip)) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      const reversed = clip.speed < 0
      const eff = reversed ? effectiveAudioClip(clip, asset.durationS) : clip
      // Audible in the exported range at all? (Per-segment scheduling below.)
      if (!computeClipSchedule(eff, startS)) continue
      // The same de-click edges the live mix reads, off the clip as it sits on its track.
      candidates.push({ clip: eff, track, asset, reversed, edges: clipEdges(track, clip) })
    }
  }
  if (candidates.length === 0) return null

  // clipAudioBuffer resolves null for silent/image assets and decode failures,
  // and routes denoised clips through the SAME resolver as live preview.
  // ⛔ BOUNDED, 2026-08-29, and this was the last unfenced burst in the app. The
  // three preview call sites were capped on 2026-08-27; this one was missed, so
  // an export still opened one demux per distinct audible asset at once. On his
  // project that is seventeen.
  const buffers: (AudioBuffer | null)[] = new Array<AudioBuffer | null>(candidates.length).fill(null)
  await mapLimit(
    candidates.map((_, i) => i),
    DECODE_CONCURRENCY,
    async (i) => {
      const c = candidates[i]
      buffers[i] = await clipAudioBuffer(c.clip, c.asset, c.reversed)
    },
  )
  if (!buffers.some((b) => b !== null)) {
    // EVERY audible clip failed to decode, and this used to `return null`, which
    // both export paths read as "this timeline has no audio" and happily wrote a
    // silent video. His report, 2026-08-05: "to export audio doesn't work. It
    // just didn't export the audio." The decode warnings went to a console he
    // never sees, so the export looked like it worked and the file was wrong.
    //
    // A silent success is the worst outcome available here: he only finds out
    // after uploading. Throwing names the files instead, and the export stops
    // with something he can act on. An honest failure beats a quiet wrong file.
    // Only files that CLAIM to carry sound. A still image or a silent clip
    // sitting on an audio track decodes to nothing quite legitimately, and
    // raising an error for it would turn a normal timeline into a failed export.
    // ⛔ AND NOT THE ONES PROVED SILENT. `asset.hasAudio` is TRUE for every
    // video because probe.ts cannot tell at preload=metadata and defaults
    // honestly rather than guessing low. Reading that as a claim meant a clip
    // with no sound — gameplay with the mic off, a screen recording, a phone
    // clip in silent mode — could not be exported AT ALL, and the message told
    // him to re-import the file, which hands back the same silent file.
    // `isProvedSilent` is only true once the demuxer has OPENED the container and
    // found no audio stream, which outranks the guess.
    const names = [
      ...new Set(
        candidates.filter((c) => c.asset.hasAudio && !isProvedSilent(c.asset.id)).map((c) => c.asset.name),
      ),
    ]
    if (names.length === 0) return null
    throw new Error(
      `Could not read the sound from ${names.length === 1 ? names[0] : `${names.length} files (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''})`}. ` +
        `Re-import ${names.length === 1 ? 'it' : 'them'} and try again.`,
    )
  }
  // SOME clips decoded and some did not. The export can honestly continue (the
  // ones that worked are real audio), but he must be told which pieces will be
  // missing rather than discovering a silent gap later.
  const failed = candidates.filter(
    (_, i) => buffers[i] === null && candidates[i].asset.hasAudio && !isProvedSilent(candidates[i].asset.id),
  )
  if (failed.length > 0) {
    console.warn(
      `OL Premiere export: no sound from ${failed.length} clip(s): ${[...new Set(failed.map((c) => c.asset.name))].join(', ')}`,
    )
    onPartialAudio?.([...new Set(failed.map((c) => c.asset.name))])
  }

  const totalFrames = audioFramesFor(rangeS, seq.fps, EXPORT_SAMPLE_RATE)

  // Auto-level's compressor delays its track by AUTO_LEVEL_LATENCY_S; every
  // other track is scheduled that much later to match (trackLateS), and the
  // render drops that much off its front, so the whole mix is exactly on time.
  // Zero when no track uses it.
  const alignS = trackAlignS(candidates.map((c) => c.track))
  const alignFrames = Math.round(alignS * EXPORT_SAMPLE_RATE)

  /** Render one segment: [f0, f0 + segFrames) of the mix, with pre-roll. */
  const renderSegment = async (f0: number, segFrames: number): Promise<Float32Array<ArrayBuffer>[]> => {
    const prerollS = f0 === 0 ? 0 : AUDIO_PREROLL_S
    const prerollFrames = Math.round(prerollS * EXPORT_SAMPLE_RATE)
    // The schedule base: every envelope + schedule offset below is relative to
    // it, exactly the fromS convention of computeClipSchedule/clipGainEnvelope/
    // duckEnvelope. Those are all pure functions of absolute time, so a mid-mix
    // base is exact, not approximated.
    const fromS = startS + f0 / EXPORT_SAMPLE_RATE - prerollS
    const ctxFrames = prerollFrames + alignFrames + segFrames
    const ctx = new OfflineAudioContext(EXPORT_CHANNELS, ctxFrames, EXPORT_SAMPLE_RATE)

    // Same duck automation as the live preview (see engine/ducking.ts).
    const duckEnv = duckEnvelope(seq.tracks, anySolo, fromS)

    // Same gain→pan-per-track → destination topology as the live preview, so
    // the exported mix matches what was heard.
    const trackNodes = new Map<Id, GainNode>()
    const trackInputFor = (track: Track): GainNode => {
      const existing = trackNodes.get(track.id)
      if (existing) return existing
      const gain = ctx.createGain()
      gain.gain.value = dbToGain(track.volumeDb ?? 0)
      const pan = ctx.createStereoPanner()
      pan.pan.value = clamp(track.pan ?? 0, -1, 1)
      // ⛔ THE SAME FUNCTION THE LIVE MIX CALLS, not a copy of it that claims to
      // match. The claim used to live in a comment here and nothing enforced it.
      let tail: AudioNode = connectAutoLevel(ctx, gain, track.autoLevel)
      // Music ducks under the voiceover, with identical automation to the preview.
      // The sound reaches it alignS late on every track, so the duck moves with it.
      if (track.audioRole === 'music' && duckEnv) {
        const duck = ctx.createGain()
        duckEnv.forEach((pt, idx) => {
          if (idx === 0) duck.gain.setValueAtTime(pt.value, pt.offsetS + alignS)
          else duck.gain.linearRampToValueAtTime(pt.value, pt.offsetS + alignS)
        })
        tail.connect(duck)
        tail = duck
      }
      tail.connect(pan)
      // Straight to the sum. The master limiter runs on the rendered PCM below
      // (render), the same TruePeakLimiter the preview runs in its worklet.
      pan.connect(ctx.destination)
      trackNodes.set(track.id, gain)
      return gain
    }

    const ctxEndOffsetS = ctxFrames / EXPORT_SAMPLE_RATE
    candidates.forEach(({ clip, track, edges }, i) => {
      const buffer = buffers[i]
      if (!buffer) return
      const sched: ClipSchedule | null = computeClipSchedule(clip, fromS)
      // Ends before this segment's base, or starts after its end: silent here.
      if (!sched || sched.whenOffsetS >= ctxEndOffsetS) return
      const source = ctx.createBufferSource()
      // The same pitch-preserving slice the live preview schedules, so the
      // render cannot disagree with what he heard while editing.
      // `clip.inS` is the anchor, the same one the live preview passes: the mix
      // renders in 30 s segments, each its own context, and without the anchor
      // every segment ran a fresh time stretch from its own edge, so a sped up
      // clip that outlived one segment was two independent stretches butted
      // together with a click at the seam. Anchored, every segment slices the
      // one cached stretch, and the seam is not there.
      const play = pitchPreservedSource(ctx, buffer, clip.speed, sched, clip.inS)
      source.buffer = play.buffer
      source.playbackRate.value = play.playbackRate
      // A plain track starts later by the alignment, so it meets the Auto-level ones.
      const late = trackLateS(track, alignS)
      const env = clipGainEnvelope(clip, fromS, edges) ?? [{ offsetS: 0, value: dbToGain(clip.audioGainDb) }]
      // Stereo always, so a mono file plays L = R at full level: see createClipGain.
      const gain = createClipGain(ctx, env[0]!.value)
      env.forEach((pt, idx) => {
        if (idx === 0) gain.gain.setValueAtTime(pt.value, pt.offsetS + late)
        else gain.gain.linearRampToValueAtTime(pt.value, pt.offsetS + late)
      })
      source.connect(gain)
      gain.connect(trackInputFor(track))
      // On the sample grid, so no clip is low passed by interpolation: see onSampleGrid.
      source.start(onSampleGrid(sched.whenOffsetS + late, EXPORT_SAMPLE_RATE), play.offsetS, play.durationS)
    })

    const rendered = await ctx.startRendering()
    // Copy each channel (dropping the pre-roll and the tracks' shared delay) so
    // transferring the buffers to the worker can't detach the AudioBuffer's
    // internal storage.
    return Array.from(
      { length: EXPORT_CHANNELS },
      (_, ch) => new Float32Array(rendered.getChannelData(ch).subarray(prerollFrames + alignFrames)),
    )
  }

  const eachSegment = async (fn: (channelData: Float32Array<ArrayBuffer>[]) => void | Promise<void>): Promise<void> => {
    for (let f0 = 0; f0 < totalFrames; f0 += AUDIO_SEGMENT_FRAMES) {
      await fn(await renderSegment(f0, Math.min(AUDIO_SEGMENT_FRAMES, totalFrames - f0)))
    }
  }
  const target = opts.loudnessTargetLufs ?? null

  return {
    info: { sampleRate: EXPORT_SAMPLE_RATE, numberOfChannels: EXPORT_CHANNELS, totalFrames },
    render: async (onSegment) => {
      // PLATFORM LOUDNESS, his answer 2026-09-30: "Yes, on by default". The
      // whole mix is measured first (the same BS.1770 as loudness.ts, fed one
      // segment at a time so a long export is never held whole), then rendered
      // again at the gain that lands it on the target. The render is
      // deterministic, so the second pass is the mix the first one measured.
      let gain = 1
      if (target !== null) {
        const meter = new LoudnessMeter(EXPORT_SAMPLE_RATE, EXPORT_CHANNELS)
        await eachSegment((cd) => meter.push(cd))
        gain = dbToGain(platformGainDb(meter.integrated(), target))
      }
      // Then the master limiter, on the PCM, carried across the segments so a
      // peak that straddles a boundary is handled as one peak. Its look-ahead
      // delay is dropped from the front and flushed out at the end, and the
      // segments go out at exactly the sizes they were rendered at, which the
      // worker's AAC framing relies on.
      const limiter = new TruePeakLimiter(EXPORT_CHANNELS, EXPORT_SAMPLE_RATE)
      const fifo = new PcmFifo(EXPORT_CHANNELS, limiter.latency)
      const sizes: number[] = []
      const limit = (cd: Float32Array[], frames: number): void => {
        if (gain !== 1) for (const ch of cd) for (let i = 0; i < ch.length; i++) ch[i] *= gain
        const out = Array.from({ length: EXPORT_CHANNELS }, () => new Float32Array(frames))
        limiter.process(cd, out, frames)
        fifo.push(out)
      }
      await eachSegment(async (cd) => {
        sizes.push(cd[0]?.length ?? 0)
        limit(cd, cd[0]?.length ?? 0)
        while (sizes.length > 0 && fifo.available >= sizes[0]) await onSegment(fifo.take(sizes.shift()!))
      })
      limit([], limiter.latency) // silence through, to push the last frames out
      while (sizes.length > 0) await onSegment(fifo.take(sizes.shift()!))
    },
  }
}

/**
 * Frames in, frames out in any sizes, with the first `skip` frames thrown away:
 * how the limiter's look-ahead delay comes off the front of the export.
 */
class PcmFifo {
  private readonly chunks: Float32Array[][] = []
  private headOffset = 0
  private skip: number
  available = 0

  constructor(
    private readonly channels: number,
    skip: number,
  ) {
    this.skip = skip
  }

  push(chs: Float32Array[]): void {
    let data = chs
    let frames = data[0]?.length ?? 0
    if (this.skip > 0) {
      const drop = Math.min(this.skip, frames)
      this.skip -= drop
      frames -= drop
      data = data.map((c) => c.subarray(drop))
    }
    if (frames <= 0) return
    this.chunks.push(data)
    this.available += frames
  }

  /** Exactly `frames` frames (silence past the end), as fresh arrays the caller may transfer. */
  take(frames: number): Float32Array<ArrayBuffer>[] {
    const out = Array.from({ length: this.channels }, () => new Float32Array(frames))
    let filled = 0
    while (filled < frames && this.chunks.length > 0) {
      const head = this.chunks[0]
      const len = (head[0]?.length ?? 0) - this.headOffset
      const n = Math.min(len, frames - filled)
      for (let c = 0; c < this.channels; c++) out[c].set(head[c].subarray(this.headOffset, this.headOffset + n), filled)
      filled += n
      this.headOffset += n
      if (this.headOffset >= (head[0]?.length ?? 0)) {
        this.chunks.shift()
        this.headOffset = 0
      }
    }
    this.available = Math.max(0, this.available - frames)
    return out
  }
}
