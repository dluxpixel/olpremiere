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
import type { RenderedAudio } from './messages'

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

export const EXPORT_SAMPLE_RATE = 48000
export const EXPORT_CHANNELS = 2

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
export async function renderAudioMix(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  startS = 0,
  endS = seq.durationS,
): Promise<RenderedAudio | null> {
  if (!('AudioEncoder' in globalThis)) return null
  const rangeS = endS - startS
  if (rangeS <= 0) return null

  const anySolo = seq.tracks.some((t) => t.solo)
  const audibleTracks = seq.tracks.filter((t) => (anySolo ? t.solo : !t.muted))

  // Same duck automation as the live preview (see engine/ducking.ts).
  const duckEnv = duckEnvelope(seq.tracks, anySolo, startS)

  const candidates: { clip: Clip; track: Track; sched: ClipSchedule; asset: MediaAsset; reversed: boolean }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      if (!clipEmitsAudio(track, clip)) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      const reversed = clip.speed < 0
      const eff = reversed ? effectiveAudioClip(clip, asset.durationS) : clip
      const sched = computeClipSchedule(eff, startS)
      if (!sched) continue
      candidates.push({ clip: eff, track, sched, asset, reversed })
    }
  }
  if (candidates.length === 0) return null

  // getAudioBuffer resolves null for silent/image assets and decode failures.
  const buffers = await Promise.all(
    candidates.map((c) => (c.reversed ? getReversedAudioBuffer(c.asset) : getAudioBuffer(c.asset))),
  )
  if (!buffers.some((b) => b !== null)) return null

  const length = Math.max(1, Math.ceil(rangeS * EXPORT_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(EXPORT_CHANNELS, length, EXPORT_SAMPLE_RATE)

  // Same gain→pan-per-track → destination topology as the live preview, so the
  // exported mix matches what was heard. Offsets are relative to `startS`, which
  // is exactly clipGainEnvelope(clip, startS)'s convention.
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

  candidates.forEach(({ clip, track, sched }, i) => {
    const buffer = buffers[i]
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.abs(clip.speed)
    const gain = ctx.createGain()
    const env = clipGainEnvelope(clip, startS) ?? [{ offsetS: 0, value: dbToGain(clip.audioGainDb) }]
    env.forEach((pt, idx) => {
      if (idx === 0) gain.gain.setValueAtTime(pt.value, pt.offsetS)
      else gain.gain.linearRampToValueAtTime(pt.value, pt.offsetS)
    })
    source.connect(gain)
    gain.connect(trackInputFor(track))
    source.start(sched.whenOffsetS, sched.sourceOffsetS, sched.durationS)
  })

  const rendered = await ctx.startRendering()
  // Copy each channel so transferring the buffers to the worker can't detach
  // the AudioBuffer's internal storage.
  const channelData = Array.from(
    { length: EXPORT_CHANNELS },
    (_, ch) => new Float32Array(rendered.getChannelData(ch)),
  )
  return { sampleRate: EXPORT_SAMPLE_RATE, numberOfChannels: EXPORT_CHANNELS, channelData }
}
