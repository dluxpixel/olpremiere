// Scrub audio: you hear the timeline while you drag the playhead.
//
// Cutting a talking head is a listening job. You drag the playhead to find the
// breath at the end of a sentence, and until now the app was completely silent
// while you did it, so the only way to place a cut was to play, overshoot, stop,
// and play again. Premiere, Resolve and Vegas all make sound under a dragged
// playhead, and it is the single thing that makes their timelines feel alive.
//
// The technique is granular, the same one every NLE uses. Each move of the
// playhead fires a SHORT grain of the real audio from the position it landed on,
// at normal pitch. Grains are fired no faster than a fixed interval and each is
// longer than that interval, so consecutive grains overlap and the ear hears a
// continuous, if stuttery, stream rather than a machine gun of clicks. Dragging
// slowly reads the words at their own pitch; dragging fast skips through them.
//
// Two things make it sound like audio rather than like damage:
//  - every grain gets a short fade at both ends, because cutting a waveform at a
//    non-zero sample is exactly what a click IS, and
//  - the grain carries the clip's own gain and its track's volume, so a quiet
//    take scrubs quiet and a muted track stays silent.

import {
  clipAudioBuffer,
  clipEmitsAudio,
  computeClipSchedule,
  dbToGain,
  effectiveAudioClip,
  ensureAudioContext,
  ensureMasterChain,
} from './audio'
import type { Clip, Id, MediaAsset, Sequence } from './types'

/** How often a grain may start. Below this the drag just moves the playhead. */
export const SCRUB_GRAIN_INTERVAL_S = 0.055

/**
 * How long each grain sounds. Longer than the interval on purpose: consecutive
 * grains overlap, and the overlap is what turns a series of fragments into
 * something the ear follows.
 */
export const SCRUB_GRAIN_S = 0.09

/** Fade at each end of a grain. A cut at a non-zero sample is a click. */
export const SCRUB_FADE_S = 0.008

/** One clip that should sound at the scrubbed moment. */
export interface ScrubVoice {
  clipId: Id
  assetId: Id
  /** The clip mapped to its forward equivalent, so a reversed clip reads normally. */
  clip: Clip
  reversed: boolean
  /** Where in the decoded buffer this grain starts. */
  sourceOffsetS: number
  /** Clip gain times track volume. Fades are deliberately NOT applied, see below. */
  gain: number
  /** The clip's own speed. Scrub does not add a rate of its own: normal pitch. */
  playbackRate: number
}

/**
 * Every clip audible at timeline second `t`, ready to be fired as a grain.
 *
 * Pure, so the decision of WHAT should sound is testable without an AudioContext.
 * Mirrors the live mixer's rules exactly (mute, solo, and linked A/V counted
 * once) so scrubbing a track never sounds different from playing it.
 *
 * Fade in/out are deliberately left out of `gain`. A clip fade is shaped over
 * whole seconds and a grain is 90 milliseconds, so applying it would make a grain
 * near a fade almost silent and the scrub would appear to break exactly where he
 * is most likely to be looking for his cut.
 */
export function scrubVoicesAt(seq: Sequence, assets: Record<Id, MediaAsset>, t: number): ScrubVoice[] {
  const anySolo = seq.tracks.some((tr) => tr.solo)
  const voices: ScrubVoice[] = []
  for (const track of seq.tracks) {
    if (anySolo ? !track.solo : track.muted) continue
    const trackGain = dbToGain(track.volumeDb ?? 0)
    for (const clip of track.clips) {
      if (!clipEmitsAudio(track, clip)) continue
      const asset = assets[clip.assetId]
      if (!asset) continue
      const reversed = clip.speed < 0
      const eff = reversed ? effectiveAudioClip(clip, asset.durationS) : clip
      const sched = computeClipSchedule(eff, t)
      // whenOffsetS > 0 means the clip starts LATER than t, so it is not under
      // the playhead and must not sound.
      if (!sched || sched.whenOffsetS > 0) continue
      if (sched.durationS <= 0) continue
      voices.push({
        clipId: clip.id,
        assetId: clip.assetId,
        clip: eff,
        reversed,
        sourceOffsetS: sched.sourceOffsetS,
        gain: trackGain * dbToGain(eff.audioGainDb ?? 0),
        playbackRate: Math.abs(eff.speed) || 1,
      })
    }
  }
  return voices
}

/**
 * Decides whether a grain may fire, given when the last one did. Pure, so the
 * throttle can be tested without a clock.
 *
 * A grain also fires when the playhead JUMPS (a click somewhere else rather than
 * a drag), because that is a new place and he expects to hear it immediately.
 */
export function shouldFireGrain(
  nowS: number,
  lastFiredAtS: number | null,
  lastPlayheadS: number | null,
  playheadS: number,
): boolean {
  if (lastFiredAtS === null) return true
  if (lastPlayheadS !== null && Math.abs(playheadS - lastPlayheadS) > SCRUB_GRAIN_S) return true
  return nowS - lastFiredAtS >= SCRUB_GRAIN_INTERVAL_S
}

/**
 * Fires grains as the playhead is dragged, and cleans up after itself.
 *
 * Deliberately fire-and-forget: `scrub()` is called from a pointermove handler,
 * so it must never block and must never await. The first grain for an asset may
 * arrive a beat late while its buffer decodes; every one after that is a cache
 * hit. The throttle stamps its clock when a grain is REQUESTED, not when it
 * sounds, so a slow decode cannot let a queue of grains build up behind it.
 */
export class ScrubAudioPlayer {
  private lastFiredAtS: number | null = null
  private lastPlayheadS: number | null = null
  private live = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()
  /** Bumped on every stop, so a grain whose buffer arrives late is discarded. */
  private generation = 0

  /**
   * Call on every playhead move during a scrub. Cheap and throttled internally,
   * so calling it at pointermove rate is fine.
   */
  scrub(seq: Sequence, assets: Record<Id, MediaAsset>, playheadS: number): void {
    const ctx = ensureAudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    if (!shouldFireGrain(ctx.currentTime, this.lastFiredAtS, this.lastPlayheadS, playheadS)) return
    this.lastFiredAtS = ctx.currentTime
    this.lastPlayheadS = playheadS

    const voices = scrubVoicesAt(seq, assets, playheadS)
    if (voices.length === 0) return
    const generation = this.generation
    for (const voice of voices) {
      const asset = assets[voice.assetId]
      if (!asset) continue
      void clipAudioBuffer(voice.clip, asset, voice.reversed).then((buffer) => {
        // Dropped while the buffer decoded: the drag ended, or playback started.
        if (!buffer || generation !== this.generation) return
        this.fire(buffer, voice)
      })
    }
  }

  private fire(buffer: AudioBuffer, voice: ScrubVoice): void {
    const ctx = ensureAudioContext()
    const { master } = ensureMasterChain()
    const startAt = ctx.currentTime
    const offset = Math.max(0, Math.min(voice.sourceOffsetS, buffer.duration))
    // A grain that would run off the end of the buffer is trimmed, not skipped:
    // the last moments of a take are exactly where a cut usually goes.
    const lengthS = Math.min(SCRUB_GRAIN_S, Math.max(0, buffer.duration - offset))
    if (lengthS <= 0) return

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = voice.playbackRate
    const gain = ctx.createGain()
    // Fade both ends. The ramps are clamped so they can never overlap on a grain
    // trimmed short at the end of a buffer, which would invert the envelope.
    const fade = Math.min(SCRUB_FADE_S, lengthS / 2)
    gain.gain.setValueAtTime(0, startAt)
    gain.gain.linearRampToValueAtTime(voice.gain, startAt + fade)
    gain.gain.setValueAtTime(voice.gain, startAt + lengthS - fade)
    gain.gain.linearRampToValueAtTime(0, startAt + lengthS)

    source.connect(gain)
    gain.connect(master)
    source.start(startAt, offset, lengthS)

    const entry = { source, gain }
    this.live.add(entry)
    source.onended = () => {
      this.live.delete(entry)
      source.disconnect()
      gain.disconnect()
    }
  }

  /** Call when the drag ends, and before real playback starts. Safe to call twice. */
  stop(): void {
    this.generation++
    this.lastFiredAtS = null
    this.lastPlayheadS = null
    for (const { source, gain } of this.live) {
      try {
        source.stop()
      } catch {
        // stop() only throws before start(); every node here was started
      }
      source.disconnect()
      gain.disconnect()
    }
    this.live.clear()
  }

  /** Live grain count. Tests and nothing else. */
  get liveGrains(): number {
    return this.live.size
  }
}

/**
 * The app's one scrub player. Shared like the AudioContext itself, because two
 * of them would fire two sets of grains at the same moment and sound doubled.
 */
export const scrubAudio = new ScrubAudioPlayer()
