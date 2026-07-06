// Transport clock (spec §4.2 playback.ts). Audio is the MASTER clock: while
// the shared AudioContext is 'running' the playhead advances on
// AudioContext.currentTime; otherwise (autoplay policy or headless Chrome can
// keep the context suspended) it falls back to performance.now()/1000 so
// playback still advances. No React, no store imports, no DOM beyond rAF.

import { ensureAudioContext, SCHEDULE_LATENCY_S } from './audio'

export type ScheduleFn = (fromS: number) => Promise<() => void>

export interface TransportOpts {
  /** Sequence end in seconds. Re-read every frame so edits mid-play count. */
  getEndS: () => number
  onTick: (tS: number) => void
  onStateChange?: (playing: boolean, rate: number) => void
  /** Schedules audio from a timeline time; resolves to a stop fn. */
  schedule: ScheduleFn
}

const perfClock = (): number => performance.now() / 1000

export class Transport {
  private readonly opts: TransportOpts
  private rafId: number | null = null
  private stopAudio: (() => void) | null = null
  private isPlaying = false
  /**
   * Intent set SYNCHRONOUSLY by play()/pause(). play() schedules audio behind
   * an await (a long clip decodes for seconds), so `isPlaying` lags; `intended`
   * lets togglePlay/pause react immediately — pressing pause during that window
   * reliably stops instead of starting a second playback.
   */
  private intended = false
  private currentRate = 0
  private startS = 0
  private anchor = 0
  private readClock: () => number = perfClock
  private lastT = 0
  /** Bumped by play()/pause() so in-flight async play() setups self-cancel. */
  private playToken = 0

  constructor(opts: TransportOpts) {
    this.opts = opts
  }

  get playing(): boolean {
    return this.intended
  }

  get rate(): number {
    return this.currentRate
  }

  currentTime(): number {
    // Live while playing so JKL re-anchors (play(t.currentTime(), newRate))
    // never jump back to a stale tick.
    return this.isPlaying ? this.liveTime() : this.lastT
  }

  /**
   * Start (or restart) playback from `fromS`. rate 1 schedules audio; any
   * other rate (JKL shuttle -4..-1, 2, 4) is a silent scrub, negative runs
   * backward. Calling while already playing tears the previous loop + audio
   * down first, so a rate change re-anchors cleanly from the passed time.
   */
  async play(fromS: number, rate = 1): Promise<void> {
    const token = ++this.playToken
    this.teardown()
    this.lastT = fromS
    this.intended = true

    if (this.opts.getEndS() <= 0) {
      // Empty sequence: don't start — immediate pause semantics.
      this.intended = false
      if (this.isPlaying) {
        this.isPlaying = false
        this.currentRate = 0
        this.opts.onStateChange?.(false, 0)
      }
      return
    }

    let audioScheduled = false
    if (rate === 1) {
      try {
        const stop = await this.opts.schedule(fromS)
        if (token !== this.playToken) {
          // Superseded by pause()/play() while decoding — kill the late audio.
          stop()
          return
        }
        this.stopAudio = stop
        audioScheduled = true
      } catch (err) {
        console.warn('OT Premiere transport: audio scheduling failed, playing silent', err)
      }
    }

    // Decide the clock source ONCE per play, after the resume attempt
    // (scheduleAudio already awaited its own resume for the rate-1 path).
    const ctx = this.attemptResume()
    if (token !== this.playToken) return
    const useAudioClock = ctx !== null && ctx.state === 'running'
    this.readClock = useAudioClock ? () => ctx.currentTime : perfClock

    this.startS = fromS
    // Scheduled sources begin SCHEDULE_LATENCY_S in the future; anchoring
    // there keeps steady-state video time equal to audio time (liveTime holds
    // ticks at fromS until the sources actually start).
    this.anchor = this.readClock() + (audioScheduled && useAudioClock ? SCHEDULE_LATENCY_S : 0)
    this.isPlaying = true
    this.currentRate = rate
    this.opts.onStateChange?.(true, rate)

    const loop = (): void => {
      const endS = Math.max(0, this.opts.getEndS())
      const t = this.liveTime()
      if (rate > 0 && t >= endS) {
        this.lastT = endS
        this.pause()
        this.opts.onTick(endS)
        return
      }
      if (rate < 0 && t <= 0) {
        this.lastT = 0
        this.pause()
        this.opts.onTick(0)
        return
      }
      this.lastT = t
      this.opts.onTick(t)
      // onTick may have called pause()/play() — never double-schedule.
      if (token !== this.playToken) return
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /** Stop the loop + audio. Returns the time playback stopped at. */
  pause(): number {
    this.playToken++
    this.teardown()
    // Fire the state change if we were playing OR merely intending to (audio
    // still decoding) — the latter guarantees the video preview is paused even
    // when the user hits pause before playback visibly started.
    const wasActive = this.isPlaying || this.intended
    this.intended = false
    this.isPlaying = false
    this.currentRate = 0
    if (wasActive) this.opts.onStateChange?.(false, 0)
    return this.lastT
  }

  /** Current transport time from the chosen clock, clamped to [0, end]. */
  private liveTime(): number {
    const raw = this.startS + (this.readClock() - this.anchor) * this.currentRate
    // Hold at startS while the anchor sits in the future (audio latency gap).
    const held = this.currentRate >= 0 ? Math.max(this.startS, raw) : Math.min(this.startS, raw)
    return Math.min(Math.max(0, this.opts.getEndS()), Math.max(0, held))
  }

  private attemptResume(): AudioContext | null {
    try {
      const ctx = ensureAudioContext()
      // Fire-and-forget: if resume lands after the clock was chosen, the
      // performance.now() fallback stays valid (shuttle rates are silent).
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined)
      return ctx
    } catch {
      // No AudioContext in this environment — perf clock still works.
      return null
    }
  }

  private teardown(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.stopAudio) {
      this.stopAudio()
      this.stopAudio = null
    }
  }
}
