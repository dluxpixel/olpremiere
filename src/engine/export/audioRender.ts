// Offline render of the sequence's full audio mix to PCM. Runs on the MAIN
// thread: OfflineAudioContext is not reliably available in workers, and the
// decoded-AudioBuffer cache in audio.ts already lives here.

import { computeClipSchedule, dbToGain, getAudioBuffer, type ClipSchedule } from '../audio'
import type { Clip, Id, MediaAsset, Sequence } from '../types'
import type { RenderedAudio } from './messages'

export const EXPORT_SAMPLE_RATE = 48000
export const EXPORT_CHANNELS = 2

/**
 * Mixes every audible clip from t=0 with the exact rules of scheduleAudio:
 * solo wins (any solo → only solo tracks, else non-muted), clips on video AND
 * audio tracks carry audio, disabled clips and speed <= 0 are skipped, and
 * playbackRate = |speed|. Returns null when there is nothing audible or the
 * platform has no AudioEncoder (older Safari) — the export is then video-only.
 */
export async function renderAudioMix(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
): Promise<RenderedAudio | null> {
  if (!('AudioEncoder' in globalThis)) return null
  if (seq.durationS <= 0) return null

  const anySolo = seq.tracks.some((t) => t.solo)
  const audibleTracks = seq.tracks.filter((t) => (anySolo ? t.solo : !t.muted))

  const candidates: { clip: Clip; sched: ClipSchedule; asset: MediaAsset }[] = []
  for (const track of audibleTracks) {
    for (const clip of track.clips) {
      const sched = computeClipSchedule(clip, 0)
      if (!sched) continue
      const asset: MediaAsset | undefined = assets[clip.assetId]
      if (!asset) continue
      candidates.push({ clip, sched, asset })
    }
  }
  if (candidates.length === 0) return null

  // getAudioBuffer resolves null for silent/image assets and decode failures.
  const buffers = await Promise.all(candidates.map((c) => getAudioBuffer(c.asset)))
  if (!buffers.some((b) => b !== null)) return null

  const length = Math.max(1, Math.ceil(seq.durationS * EXPORT_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(EXPORT_CHANNELS, length, EXPORT_SAMPLE_RATE)
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
