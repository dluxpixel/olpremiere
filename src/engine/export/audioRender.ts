// Offline render of the sequence's full audio mix to PCM. Runs on the MAIN
// thread: OfflineAudioContext is not reliably available in workers, and the
// decoded-AudioBuffer cache in audio.ts already lives here.

import {
  clipEmitsAudio,
  clipGainEnvelope,
  compressorParamsFor,
  computeClipSchedule,
  dbToGain,
  effectiveAudioClip,
  getAudioBuffer,
  getReversedAudioBuffer,
  type ClipSchedule,
} from '../audio'
import { duckEnvelope } from '../ducking'
import type { Clip, Id, MediaAsset, Sequence, Track } from '../types'
import type { AudioStreamMeta } from './messages'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

export const EXPORT_SAMPLE_RATE = 48000
export const EXPORT_CHANNELS = 2

/**
 * Segment size for the streamed render: 30 s of 48 kHz stereo float32 is
 * ~11.5 MB per segment — peak audio memory no longer scales with export
 * length (a 30-minute export used to allocate ~700 MB three times over).
 * 30 s = 300 exact AUDIO_CHUNK_FRAMES chunks, so the worker's AAC framing is
 * byte-identical to the old whole-range render.
 */
export const AUDIO_SEGMENT_FRAMES = 30 * EXPORT_SAMPLE_RATE

/**
 * Pre-roll rendered before each segment after the first and discarded. Gain
 * envelopes (clip fades, duck) are pure functions of absolute time, so they
 * are exact at any fromS; the ONE stateful node — the per-track auto-level
 * DynamicsCompressorNode (release ≤ 0.25 s) — needs this run-in for its
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
 * skipped, and playbackRate = |speed|. Returns null when there is nothing
 * audible or the platform has no AudioEncoder (older Safari) — the export is
 * then video-only.
 *
 * `startS` is the schedule base, which is exactly what computeClipSchedule and
 * clipGainEnvelope already take as `fromS`: a clip whose window ends before it
 * drops out, and the rest report offsets relative to it. So the rendered PCM
 * begins at the work-area in point, matching the video's zero-based timestamps.
 */
export async function planAudioMix(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  startS = 0,
  endS = seq.durationS,
): Promise<AudioMixPlan | null> {
  if (!('AudioEncoder' in globalThis)) return null
  const rangeS = endS - startS
  if (rangeS <= 0) return null

  const anySolo = seq.tracks.some((t) => t.solo)
  const audibleTracks = seq.tracks.filter((t) => (anySolo ? t.solo : !t.muted))

  const candidates: { clip: Clip; track: Track; asset: MediaAsset; reversed: boolean }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      if (!clipEmitsAudio(track, clip)) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      const reversed = clip.speed < 0
      const eff = reversed ? effectiveAudioClip(clip, asset.durationS) : clip
      // Audible in the exported range at all? (Per-segment scheduling below.)
      if (!computeClipSchedule(eff, startS)) continue
      candidates.push({ clip: eff, track, asset, reversed })
    }
  }
  if (candidates.length === 0) return null

  // getAudioBuffer resolves null for silent/image assets and decode failures.
  const buffers = await Promise.all(
    candidates.map((c) => (c.reversed ? getReversedAudioBuffer(c.asset) : getAudioBuffer(c.asset))),
  )
  if (!buffers.some((b) => b !== null)) return null

  const totalFrames = Math.max(1, Math.ceil(rangeS * EXPORT_SAMPLE_RATE))

  /** Render one segment: [f0, f0 + segFrames) of the mix, with pre-roll. */
  const renderSegment = async (f0: number, segFrames: number): Promise<Float32Array<ArrayBuffer>[]> => {
    const prerollS = f0 === 0 ? 0 : AUDIO_PREROLL_S
    const prerollFrames = Math.round(prerollS * EXPORT_SAMPLE_RATE)
    // The schedule base: every envelope + schedule offset below is relative to
    // it, exactly the fromS convention of computeClipSchedule/clipGainEnvelope/
    // duckEnvelope — all pure functions of absolute time, so a mid-mix base is
    // exact, not approximated.
    const fromS = startS + f0 / EXPORT_SAMPLE_RATE - prerollS
    const ctxFrames = prerollFrames + segFrames
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
      let tail: AudioNode = gain
      // Same loudness-equalization chain as the live mix → export matches preview.
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
        tail = makeup
      }
      // Music ducks under the voiceover — identical automation to the preview.
      if (track.audioRole === 'music' && duckEnv) {
        const duck = ctx.createGain()
        duckEnv.forEach((pt, idx) => {
          if (idx === 0) duck.gain.setValueAtTime(pt.value, pt.offsetS)
          else duck.gain.linearRampToValueAtTime(pt.value, pt.offsetS)
        })
        tail.connect(duck)
        tail = duck
      }
      tail.connect(pan)
      pan.connect(ctx.destination)
      trackNodes.set(track.id, gain)
      return gain
    }

    const ctxEndOffsetS = ctxFrames / EXPORT_SAMPLE_RATE
    candidates.forEach(({ clip, track }, i) => {
      const buffer = buffers[i]
      if (!buffer) return
      const sched: ClipSchedule | null = computeClipSchedule(clip, fromS)
      // Ends before this segment's base, or starts after its end — silent here.
      if (!sched || sched.whenOffsetS >= ctxEndOffsetS) return
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = Math.abs(clip.speed)
      const gain = ctx.createGain()
      const env = clipGainEnvelope(clip, fromS) ?? [{ offsetS: 0, value: dbToGain(clip.audioGainDb) }]
      env.forEach((pt, idx) => {
        if (idx === 0) gain.gain.setValueAtTime(pt.value, pt.offsetS)
        else gain.gain.linearRampToValueAtTime(pt.value, pt.offsetS)
      })
      source.connect(gain)
      gain.connect(trackInputFor(track))
      source.start(sched.whenOffsetS, sched.sourceOffsetS, sched.durationS)
    })

    const rendered = await ctx.startRendering()
    // Copy each channel (dropping the pre-roll) so transferring the buffers to
    // the worker can't detach the AudioBuffer's internal storage.
    return Array.from(
      { length: EXPORT_CHANNELS },
      (_, ch) => new Float32Array(rendered.getChannelData(ch).subarray(prerollFrames)),
    )
  }

  return {
    info: { sampleRate: EXPORT_SAMPLE_RATE, numberOfChannels: EXPORT_CHANNELS, totalFrames },
    render: async (onSegment) => {
      for (let f0 = 0; f0 < totalFrames; f0 += AUDIO_SEGMENT_FRAMES) {
        const segFrames = Math.min(AUDIO_SEGMENT_FRAMES, totalFrames - f0)
        await onSegment(await renderSegment(f0, segFrames))
      }
    },
  }
}
