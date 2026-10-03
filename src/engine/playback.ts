// Transport clock (spec §4.2 playback.ts). Audio is the MASTER clock: while
// the shared AudioContext is 'running' the playhead advances on
// AudioContext.currentTime; otherwise (autoplay policy or headless Chrome can
// keep the context suspended) it falls back to performance.now()/1000 so
// playback still advances. No React, no store imports, no DOM beyond rAF.

import { ensureAudioContext, SCHEDULE_LATENCY_S } from './audio'

/**
 * Stops one audio graph. `startsAtCtxS` is the context time its first sound was
 * scheduled for, when the scheduler knows it: that is what he actually hears,
 * which the transport's own clock only matches on a clean start.
 */
export type StopAudio = (() => void) & { startsAtCtxS?: number }

export type ScheduleFn = (fromS: number) => Promise<StopAudio>

/**
 * Where a stretch of the timeline reaches his EARS: timeline `timelineS` is
 * heard at `heardAtMs` (the performance.now() clock) and runs on in real time
 * from there. A voiceover recorded against the preview is placed with these.
 */
export interface HeardSpan {
  timelineS: number
  heardAtMs: number
  /**
   * The sound was rebuilt while play went on (a late first sound, a clock that
   * started late, a mix change): this stretch CONTINUES the one before it rather
   * than starting a new one, so a take recorded across it stays one clip.
   */
  continues?: boolean
}

/** Why a heard stretch ended, when it matters: 'end' is the preview running off the end of his edit. */
export type HeardEnd = 'end'

/**
 * How long pressing Play may wait for audio before the picture rolls anyway.
 *
 * Under this and the two start together, sample-aligned on the audio clock,
 * which is the good case and the usual one on a warm project. Over it and a
 * press of Space would start to feel broken, so the picture goes and the sound
 * catches up. 120 ms is about four frames: long enough that a warm timeline
 * never loses its audio clock, short enough that no press of Space feels dead.
 */
export const AUDIO_START_BUDGET_MS = 120

export interface TransportOpts {
  /** Sequence end in seconds. Re-read every frame so edits mid-play count. */
  getEndS: () => number
  onTick: (tS: number) => void
  onStateChange?: (playing: boolean, rate: number) => void
  /** Schedules audio from a timeline time; resolves to a stop fn. */
  schedule: ScheduleFn
  /**
   * Loop range (in/out marks or the whole sequence), re-read every frame;
   * null/undefined = no looping. Forward play at the range end re-anchors to
   * the start instead of pausing, so the caption/beat-timing workflow replays
   * the same two seconds forever.
   */
  getLoopRange?: () => { startS: number; endS: number } | null
  /**
   * What he HEARS, for a take recorded against the preview (MIC-4 and MIC-5,
   * 2026-09-30): called with a span when a stretch of the timeline starts
   * reaching his ears, and with null plus the time it stopped reaching them when
   * it ends (and 'end' when the preview ran off the end of the edit). Only
   * normal speed play makes spans; a shuttle is not performed to.
   */
  onHeard?: (span: HeardSpan | null, endedAtMs?: number, why?: HeardEnd) => void
}

const perfClock = (): number => performance.now() / 1000

/**
 * The performance.now() time at which context time `ctxS` comes out of the
 * speakers. getOutputTimestamp pairs the sample at the output right now with
 * the performance clock, so the output latency is inside it, not guessed.
 */
function heardAtMsOf(ctx: AudioContext, ctxS: number): number {
  try {
    const ts = ctx.getOutputTimestamp()
    if (ts.contextTime !== undefined && ts.performanceTime) return ts.performanceTime + (ctxS - ts.contextTime) * 1000
  } catch {
    // An engine without output timestamps: the latencies it reports instead.
  }
  const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
  return performance.now() + (ctxS - ctx.currentTime + latency) * 1000
}

export class Transport {
  private readonly opts: TransportOpts
  private rafId: number | null = null
  private stopAudio: (() => void) | null = null
  private isPlaying = false
  /**
   * Intent set SYNCHRONOUSLY by play()/pause(). play() schedules audio behind
   * an await (a long clip decodes for seconds), so `isPlaying` lags; `intended`
   * lets togglePlay/pause react immediately: pressing pause during that window
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
  /**
   * Which audio graph is the LIVE one. Bumped by every schedule and by every
   * teardown, so a build that lands after a newer one started kills itself
   * instead of playing on top. See claimAudio.
   */
  private audioToken = 0
  /**
   * The stretch he is hearing now, or null. `sound` says it is the live audio
   * graph rather than the picture alone (no sound was ready yet), which decides
   * when it ends: the moment a graph is torn down he stops hearing it. A sound
   * also keeps `ctxS`, the context time it started at, so its end is counted on
   * the same clock as the playhead (see endHeard).
   */
  private heard: (HeardSpan & { sound: boolean; ctxS?: number }) | null = null
  /** Set for the one pause that happens because play ran off the end of the edit. */
  private stoppingAtEnd = false
  /** How long a sound rebuild mid-play takes, learned as it goes (see rescheduleAudio). */
  private rebuildS = 0.01

  constructor(opts: TransportOpts) {
    this.opts = opts
  }

  get playing(): boolean {
    return this.intended
  }

  get rate(): number {
    return this.currentRate
  }

  /** The stretch of the timeline reaching his ears right now, or null. */
  get heardSpan(): HeardSpan | null {
    return this.heard ? { timelineS: this.heard.timelineS, heardAtMs: this.heard.heardAtMs } : null
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
      // Empty sequence: don't start (immediate pause semantics).
      this.intended = false
      if (this.isPlaying) {
        this.isPlaying = false
        this.currentRate = 0
        this.opts.onStateChange?.(false, 0)
      }
      return
    }

    let audioScheduled = false
    let adopted: StopAudio | null = null
    if (rate === 1) {
      try {
        // THE PICTURE MUST NOT WAIT FOR THE WHOLE TIMELINE TO DECODE.
        //
        // His report, 2026-08-06: "I click space or click the play button. It
        // just doesn't work, or it's really late."
        //
        // This used to be a bare `await this.opts.schedule(fromS)`, and
        // scheduleAudio decodes EVERY audible clip before it resolves. On a warm
        // project that is instant, which is why it looked fine for a long time.
        // The moment anything is cold - a take he just recorded, a file he just
        // imported, a project opened from disk, a cut-heavy timeline where one
        // asset fell out of the LRU - pressing Space sat there decoding whole
        // files before a single frame moved. A decode that never resolves (a
        // damaged blob) meant Space did nothing at all, forever.
        //
        // So the wait is now BOUNDED. Win the race and everything is exactly as
        // it was, audio-clocked and sample-aligned. Lose it and the picture
        // starts now on the performance clock, and the audio joins from wherever
        // the playhead has reached by the time it is ready. That late join is
        // not new machinery: it is rescheduleAudio, the same swap a mid-play
        // mute already performs.
        const claim = this.claimAudio()
        const pending = this.opts.schedule(fromS)
        const stop = await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), AUDIO_START_BUDGET_MS)),
        ])
        if (token !== this.playToken) {
          // Superseded by pause()/play() while decoding. Kill the late audio.
          if (stop) stop()
          else void pending.then((s) => s()).catch(() => undefined)
          return
        }
        if (stop) {
          this.adoptAudio(claim, stop, fromS)
          audioScheduled = true
          adopted = stop
        } else {
          // Too slow to wait for. Roll the picture; bring the sound in behind it.
          void pending
            .then((late) => {
              late()
              if (token === this.playToken) this.rescheduleAudio()
            })
            .catch(() => undefined)
        }
      } catch (err) {
        console.warn('OL Premiere transport: audio scheduling failed, playing silent', err)
      }
    }

    // Decide the clock source ONCE per play, after the resume attempt
    // (scheduleAudio already awaited its own resume for the rate-1 path).
    const ctx = this.attemptResume()
    if (token !== this.playToken) return
    // ⛔ `state === 'running'` DOES NOT MEAN THE CLOCK IS RUNNING, and believing
    // it cost him a third of a second on every cold press of Space.
    //
    // MEASURED 2026-08-12, his machine, a freshly imported clip:
    //   space -> video reports playing        28 ms
    //   space -> the audio clock first ticks 333 ms   <- currentTime pinned at 0
    //   space -> the playhead moves          384 ms   = 333 + the latency below
    // The same press on a warm context is 77 ms. So ~300 ms of a cold start was
    // the picture waiting on a clock that called itself running and was not.
    //
    // A brand new context reports 'running' the moment it is resumed, but its
    // currentTime stays at exactly 0 until the audio device actually opens.
    // Anchoring the picture to a clock stuck at 0 means liveTime() keeps
    // returning fromS, so the playhead sits still while the video plays behind
    // it. That is his 2026-08-06 report, "I click space and it's really late",
    // in the one place the bounded-wait fix above could not reach: that fix
    // bounds how long we WAIT for audio, and this is a clock that answers
    // instantly with a number that does not move.
    //
    // So the test is whether the clock has actually STARTED, not what the
    // context calls itself. When it has not, the picture rolls on the
    // performance clock and the sound joins behind it, which is not new
    // machinery: it is the same late-join the lost-the-race path above uses.
    const ctxClockStarted = ctx !== null && ctx.state === 'running' && ctx.currentTime > 0
    const useAudioClock = ctxClockStarted
    this.readClock = useAudioClock ? () => ctx.currentTime : perfClock

    this.startS = fromS
    // Scheduled sources begin SCHEDULE_LATENCY_S in the future; anchoring
    // there keeps steady-state video time equal to audio time (liveTime holds
    // ticks at fromS until the sources actually start).
    //
    // On the EXACT context time the sound was scheduled for, when the scheduler
    // says it. Reading the clock again here can land a render quantum later, and
    // then the playhead and the sound disagree by up to a few ms: measured in the
    // real app, 0.6 to 1.3 ms between where a dubbing pause stopped the sound and
    // where the playhead said it stopped (MIC-5).
    this.anchor =
      audioScheduled && useAudioClock
        ? (adopted?.startsAtCtxS ?? this.readClock() + SCHEDULE_LATENCY_S)
        : this.readClock()
    this.isPlaying = true
    this.currentRate = rate
    this.opts.onStateChange?.(true, rate)
    if (rate === 1) {
      // What he hears from here: the sound, at the time it was scheduled for,
      // when there is sound on a running clock. Otherwise the picture alone,
      // until a late sound joins it (adoptAudio opens that span).
      const startsAt = audioScheduled && useAudioClock ? (adopted?.startsAtCtxS ?? this.anchor) : null
      if (startsAt !== null) {
        this.openHeard({ timelineS: fromS, heardAtMs: heardAtMsOf(ctx!, startsAt), sound: true, ctxS: startsAt })
      }
      else {
        const heardAtMs = useAudioClock ? heardAtMsOf(ctx!, this.anchor) : this.anchor * 1000
        this.openHeard({ timelineS: fromS, heardAtMs, sound: false })
      }
    }

    // ⛔ THE SOUND WAS SCHEDULED AGAINST A CLOCK THAT HAD NOT STARTED.
    //
    // Rolling the picture on the performance clock (above) fixes the wait, and
    // on its own it would trade a late start for a WORSE fault: the audio
    // sources were scheduled at `ctx.currentTime + latency`, so they begin when
    // the device opens, about a third of a second after the picture. Silent
    // desync is worse than a slow start, and it is the kind of fault he would
    // only find after uploading.
    //
    // So the sound re-joins the picture the moment the clock actually starts.
    // rescheduleAudio re-schedules from liveTime(), which is where the picture
    // has got to, and it is the same swap a mid-play mute already performs.
    let realignAudio = audioScheduled && !ctxClockStarted && ctx !== null

    const loop = (): void => {
      if (realignAudio && ctx !== null && ctx.currentTime > 0) {
        realignAudio = false
        this.rescheduleAudio()
      }
      const endS = Math.max(0, this.opts.getEndS())
      const t = this.liveTime()
      const loopRange = rate > 0 ? (this.opts.getLoopRange?.() ?? null) : null
      const stopAt = loopRange
        ? Math.min(Math.max(loopRange.endS, loopRange.startS + 0.05), endS)
        : endS
      if (rate > 0 && t >= stopAt) {
        if (loopRange) {
          // Re-anchor and swap the audio in place (no pause/play state churn,
          // the rAF loop never dies). Audio rejoins a scheduling-latency later;
          // video restarts on this very frame.
          const fromS = Math.max(0, Math.min(loopRange.startS, stopAt))
          this.lastT = fromS
          this.startS = fromS
          this.anchor = this.readClock()
          // The pass he was hearing ends at the wrap, sound or picture alone.
          this.endHeard()
          const claim = this.claimAudio()
          void this.opts
            .schedule(fromS)
            .then((stop) => this.adoptAudio(claim, stop, fromS))
            .catch(() => undefined)
          this.opts.onTick(fromS)
          if (token !== this.playToken) return
          this.rafId = requestAnimationFrame(loop)
          return
        }
        this.lastT = endS
        this.stoppingAtEnd = true
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
      // onTick may have called pause()/play(), so never double-schedule.
      if (token !== this.playToken) return
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /**
   * Take the audio graph over: silence whatever is playing now, and mark every
   * build still in flight as stale so it silences itself the moment it lands.
   *
   * ⛔ WITHOUT THIS HE COULD END UP HEARING HIS TIMELINE TWICE AT ONCE.
   * Building a graph means decoding, which takes time, and three separate paths
   * start one while the picture keeps rolling: a late audio join, a loop
   * wrapping round, and a mix change mid-play. All three used to guard on the
   * play token alone, and that token does not move when playback simply
   * CONTINUES. So two builds started close together both believed they were
   * current: the second overwrote the handle to the first, and the first went on
   * playing with nothing left that could ever stop it. Nudging a volume slider
   * during playback did exactly that, and every nudge added another voice, all
   * of them a few milliseconds apart. Nothing but a full stop cleared it.
   *
   * Every scheduler now claims first and hands over through adoptAudio, so the
   * newest build is the only one that survives, whatever order they finish in.
   */
  private claimAudio(): number {
    // The sound he was hearing stops here. The picture alone keeps going, so a
    // picture-only span runs on until the new sound opens its own.
    if (this.heard?.sound) this.endHeard()
    this.stopAudio?.()
    this.stopAudio = null
    return ++this.audioToken
  }

  /**
   * Keep a finished build only while it is still the newest one. A build that
   * lands mid-play (a late join, a loop wrap, a mix change) is a new stretch he
   * hears, from `fromS` at the time its sound was scheduled for.
   */
  private adoptAudio(claim: number, stop: StopAudio, fromS: number, rebuiltAt?: number): void {
    if (claim !== this.audioToken) {
      stop()
      return
    }
    this.stopAudio = stop
    if (!this.isPlaying || this.currentRate !== 1) return
    const ctx = this.contextOrNull()
    if (!ctx || !(ctx.currentTime > 0)) return
    const startsAt = stop.startsAtCtxS ?? ctx.currentTime + SCHEDULE_LATENCY_S
    const rebuilt = rebuiltAt !== undefined
    if (rebuilt) this.followSound(ctx, startsAt, fromS, rebuiltAt)
    this.openHeard({ timelineS: fromS, heardAtMs: heardAtMsOf(ctx, startsAt), sound: true, ctxS: startsAt, continues: rebuilt })
  }

  /**
   * A sound rebuilt mid-play lands, scheduled to sound `fromS` at `startsAt`:
   * put the picture exactly on it. The prediction in rescheduleAudio is off only
   * by how wrong the build-time guess was, a few ms, so that is all the picture
   * moves. A play that began before the context's clock had started (the picture
   * on the performance clock) moves onto the context clock here, where the sound
   * is. The build time is learned for the next prediction.
   */
  private followSound(ctx: AudioContext, startsAt: number, fromS: number, calledAt: number): void {
    if (this.readClock === perfClock) {
      this.readClock = () => ctx.currentTime
    } else {
      const took = startsAt - SCHEDULE_LATENCY_S - calledAt
      if (took >= 0 && took < 2) this.rebuildS = (this.rebuildS + took) / 2
    }
    this.anchor = startsAt - (fromS - this.startS) / this.currentRate
  }

  /** A new stretch he hears. One still open ends where this one begins. */
  private openHeard(span: HeardSpan & { sound: boolean; ctxS?: number }): void {
    if (this.heard) this.endHeard(span.heardAtMs)
    this.heard = span
    const { timelineS, heardAtMs } = span
    this.opts.onHeard?.(span.continues ? { timelineS, heardAtMs, continues: true } : { timelineS, heardAtMs })
  }

  /**
   * The stretch he was hearing ends. A sound ends at the sample the context is
   * rendering now, which still has the output latency to travel; the picture
   * alone ends now.
   *
   * ⛔ A SOUND'S LENGTH IS COUNTED ON THE CONTEXT CLOCK, the clock the playhead
   * runs on, not by a second getOutputTimestamp reading. Two readings seconds
   * apart disagree by a fraction of a millisecond (0.2 to 1.3 ms measured in
   * the real app), and that was enough for the next stretch of a dub to overlap
   * this one and be sent to a line of its own. Counted this way a stretch ends on
   * exactly the timeline spot the playhead stops at, and the next starts there.
   */
  private endHeard(atMs?: number): void {
    const span = this.heard
    if (!span) return
    this.heard = null
    let endedAtMs = atMs
    if (endedAtMs === undefined) {
      const ctx = span.sound ? this.contextOrNull() : null
      if (!ctx) endedAtMs = performance.now()
      else if (span.ctxS !== undefined) endedAtMs = span.heardAtMs + (ctx.currentTime - span.ctxS) * 1000
      else endedAtMs = heardAtMsOf(ctx, ctx.currentTime)
    }
    const why = this.stoppingAtEnd ? 'end' : undefined
    this.opts.onHeard?.(null, Math.max(span.heardAtMs, endedAtMs), why)
  }

  private contextOrNull(): AudioContext | null {
    try {
      return ensureAudioContext()
    } catch {
      return null
    }
  }

  /**
   * Rebuild the audio for the CURRENT position without touching the picture.
   *
   * Muting a track, or moving its volume, used to do nothing at all until
   * playback stopped or looped: the audio graph is built once at play() from the
   * track values as they were then, and those become fixed node settings. So he
   * would mute a track mid-play and keep hearing it, which reads as the mute
   * button being broken.
   *
   * This is the loop wrap's swap, without the wrap: tear the old sources down,
   * schedule new ones from where we are, and leave the rAF loop and the clock
   * completely alone. No-op when not playing, so a mix change while paused costs
   * nothing (the next play() reads the new values anyway).
   */
  rescheduleAudio(): void {
    if (!this.isPlaying || !this.intended || this.currentRate !== 1) return
    const claim = this.claimAudio()
    // ⛔ FROM WHERE THE PLAYHEAD WILL BE WHEN THE NEW SOUND STARTS, not from
    // where it is now (MIC-4, 2026-10-01). A rebuilt sound starts a scheduling
    // latency plus its build time after this call, so scheduling it from here
    // left the sound that far BEHIND the picture for the rest of the play: 50 ms
    // and up after every late first sound and every mix change, and a take
    // recorded across it came out split on two lines with 80 to 125 ms of his
    // voice twice, or 84 ms of it cut out. The prediction uses the learned build
    // time, and adoptAudio puts the picture exactly on the sound when it lands.
    const calledAt = this.readClock()
    const fromS = this.timeAt(calledAt + SCHEDULE_LATENCY_S + this.rebuildS)
    void this.opts
      .schedule(fromS)
      .then((stop) => this.adoptAudio(claim, stop, fromS, calledAt))
      .catch(() => undefined)
  }

  /** Stop the loop + audio. Returns the time playback stopped at. */
  pause(): number {
    this.playToken++
    // ⛔ WHERE IT REALLY STOPPED, NOT WHERE THE LAST FRAME WAS DRAWN (MIC-5,
    // 2026-09-30). lastT is the last animation frame's tick: up to a frame stale
    // on screen, and measured 151 to 792 ms stale in a throttled window. Resuming
    // from there replayed a stretch he had already heard, and every Space pause
    // while dubbing pushed the rest of his take later against the picture. The
    // live clock, read before the sound is torn down, is the truth.
    const wasPlaying = this.isPlaying
    if (wasPlaying) this.lastT = this.liveTime()
    this.teardown()
    this.stoppingAtEnd = false
    // Fire the state change if we were playing OR merely intending to (audio
    // still decoding), because the latter guarantees the video preview is
    // paused even when the user hits pause before playback visibly started.
    const wasActive = this.isPlaying || this.intended
    this.intended = false
    this.isPlaying = false
    this.currentRate = 0
    if (wasActive) this.opts.onStateChange?.(false, 0)
    // And the playhead is told, so the next play starts exactly there.
    if (wasPlaying) this.opts.onTick(this.lastT)
    return this.lastT
  }

  /** Current transport time from the chosen clock, clamped to [0, end]. */
  private liveTime(): number {
    return this.timeAt(this.readClock())
  }

  /** Transport time at a given reading of the chosen clock, clamped to [0, end]. */
  private timeAt(clock: number): number {
    const raw = this.startS + (clock - this.anchor) * this.currentRate
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
      // No AudioContext in this environment. The perf clock still works.
      return null
    }
  }

  private teardown(): void {
    this.endHeard()
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    // Bumped even when nothing is playing: a build still decoding has to know
    // its playback is over by the time it lands.
    this.audioToken++
    if (this.stopAudio) {
      this.stopAudio()
      this.stopAudio = null
    }
  }
}
