// Transport clock (spec §4.2 playback.ts). Audio is the MASTER clock: while
// the shared AudioContext is 'running' the playhead advances on
// AudioContext.currentTime, less the time that sound takes to reach his ears
// (pictureAt); otherwise (autoplay policy or headless Chrome can
// keep the context suspended) it falls back to performance.now()/1000 so
// playback still advances. No React, no store imports, no DOM beyond rAF.

import { ensureAudioContext, SCHEDULE_LATENCY_S } from './audio'
import type { Track } from './types'

/**
 * Stops one audio graph. `startsAtCtxS` is the context time its first sound was
 * scheduled for, when the scheduler knows it: that is what he actually hears,
 * which the transport's own clock only matches on a clean start. `stopAt` hands
 * over to a newer graph sounding from a context time, and `setMix` moves the
 * live graph's faders without a rebuild (see scheduleAudio's ScheduledAudio).
 */
export type StopAudio = (() => void) & {
  startsAtCtxS?: number
  /**
   * The timeline time it sounds at `startsAtCtxS`, when the scheduler placed the
   * sound itself (it was handed `follow`, see ScheduleFn).
   */
  fromS?: number
  stopAt?: (ctxS: number) => void
  setMix?: (tracks: readonly Track[]) => boolean
}

/**
 * Builds the sound from timeline `fromS`. `follow`, when given, says where the
 * picture is at a context time: the scheduler then starts the sound from where
 * the picture will be at the moment it really sounds, however long the build
 * took, and says where that was in `fromS` on what it hands back.
 */
export type ScheduleFn = (fromS: number, follow?: (ctxS: number) => number) => Promise<StopAudio>

/**
 * The most a rebuilt sound may land behind the picture and still have the
 * picture follow it: the build-time guess going wrong by about a scheduling
 * latency. Any later and the picture would visibly jump back and replay what
 * he just watched (SF-1), so that sound is not used.
 */
export const FOLLOW_BACK_MAX_S = 0.05

/**
 * The longest build that is learned as the time a rebuild takes. A rebuild that
 * waited on a decode or a noise pass is a one-off, not what the next one costs.
 */
const REBUILD_LEARN_MAX_S = 0.25

/** A sound rebuilt mid-play: when it was asked for, and how to ask once more if it lands too late. */
interface Rebuilt {
  calledAt: number
  retry?: () => void
  /**
   * The output lag a picture rolling alone takes on when this sound joins it
   * (followSound), which the sound was asked to start ahead by. 0 once a sound has joined.
   */
  joinLagS?: number
  /**
   * False for a loop wrap: the sound is rebuilt and the picture follows it like any
   * other rebuild, but it is a NEW pass for a take, not a continuation of the one before.
   */
  continues?: boolean
}

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
  /**
   * Where a pause really stopped (the live clock, MIC-5). Defaults to onTick.
   * The app puts the playhead on the frame that was on screen and keeps this
   * exact time to resume a take from. `ranOut` is true only for the pause that
   * is play running off the end of the edit: the sound reaches the end before
   * the picture does, so a pause in that last stretch has a stop time AT the
   * end and is still a pause (sweep review S2).
   */
  onPaused?: (tS: number, ranOut: boolean) => void
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

/** Longer than this is not an output latency (Bluetooth runs 0.15 to 0.3 s). */
const MAX_EAR_LAG_S = 0.5
/** A smoothed lag that moved less than this is jitter, and keeps the old one. */
const EAR_LAG_JITTER_S = 0.004
/**
 * How much of a new reading the lag estimate takes. The output timestamps move in
 * steps of the device's buffer, so one reading is off by up to about 10 ms either
 * way (sweep review N1): the raw reading against the 4 ms gate moved the picture
 * by that about once a second, doubling a frame or dropping one. Ten readings a
 * second, a twentieth of each: the scatter settles to about a millisecond in two
 * or three seconds, and a real drift of the lag is followed at that pace.
 */
const EAR_LAG_SMOOTHING = 0.05
/** A reading this far from the estimate is another output device, not scatter, and is taken whole. */
const EAR_LAG_STEP_S = 0.03
/** How often a playing picture re-measures the lag (a different output device, and the readings the estimate smooths). */
const EAR_LAG_EVERY_S = 0.1

/**
 * How far his ears are behind the audio clock: the context time rendering now,
 * less the one coming out of the speakers now. The same reading heardAtMsOf
 * places a take with, so the picture and a dub agree on when he heard a thing.
 */
function earLagOf(ctx: AudioContext): number {
  try {
    const ts = ctx.getOutputTimestamp()
    if (ts.contextTime !== undefined && ts.performanceTime) {
      const lag = ctx.currentTime - ts.contextTime - (performance.now() - ts.performanceTime) / 1000
      if (lag >= 0 && lag <= MAX_EAR_LAG_S) return lag
    }
  } catch {
    // An engine without output timestamps: the latencies it reports instead.
  }
  const reported = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
  return reported > 0 && reported <= MAX_EAR_LAG_S ? reported : 0
}

export class Transport {
  private readonly opts: TransportOpts
  private rafId: number | null = null
  private stopAudio: StopAudio | null = null
  /**
   * The graph still sounding while a seamless rebuild is built (AU-9). It plays
   * on until the new graph starts and hands over to it there.
   */
  private outgoing: StopAudio | null = null
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
  /** This play's clock tick, while its loop is live (see tickFrame). */
  private frameTick: ((now: number) => void) | null = null
  /** The timestamp of the animation frame the clock last ticked in. */
  private tickedAt: number | null = null
  /** The frame a draw ticked the clock in, ahead of the transport's own callback. */
  private aheadAt: number | null = null
  /**
   * How far his ears are behind the clock while the picture runs on the sound
   * (earLagOf), and 0 whenever it does not: a shuttle, or a picture rolling
   * alone because its first sound was late. See pictureAt.
   */
  private earLag = 0
  /** The smoothed measurement behind earLag (see measureEarLag), or null before the first reading. */
  private earLagEstimate: number | null = null
  /**
   * A sound has reached the picture this play. Until one has, there is nothing
   * to wait for, so a cold Space is not held back by the lag; the first sound
   * to join brings it (rescheduleAudio, followSound).
   */
  private soundHeard = false
  /** The clock reading the lag was last measured at. */
  private earLagAt = -Infinity
  /** A looped pass whose sound has wrapped and is still on its way to his ears. */
  private tail: { startS: number; anchor: number; endS: number; untilClock: number } | null = null
  /** The last picture time told this run, so a re-measured lag never steps it back. */
  private lastPicture = -Infinity

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

  /**
   * Tick the clock for the animation frame stamped `now`, unless it has
   * ticked in that frame already. The monitor calls this first thing in its
   * draw, so what it draws is where the clock is in THIS frame.
   *
   * ⛔ THE MONITOR DREW THE FRAME BEFORE (2026-10-07). Its loop is asked for at
   * mount, long before any play, and the browser runs a frame's callbacks in the
   * order they were asked for, so in every frame the monitor ran FIRST and drew
   * the playhead the transport had set one frame earlier. The picture sat a
   * display frame behind the clock, the sound and the readout, and a pause
   * between two frames found the playhead one frame past what he saw.
   * Remembering the drawn frame (preview.ts lastPlayedFrameS) put the pause
   * right; this puts the picture right. The transport's own callback, later in
   * the same frame, then only books the next one. Without a monitor it ticks on
   * its own, as before.
   */
  tickFrame(now: number): void {
    if (!this.frameTick || this.tickedAt === now) return
    this.aheadAt = now
    this.frameTick(now)
  }

  currentTime(): number {
    // Live while playing so JKL re-anchors (play(t.currentTime(), newRate))
    // never jump back to a stale tick. And the PICTURE, the frame on screen:
    // the sound still on its way to his ears is the lag ahead of it, and a
    // shuttle started from there jumped the picture forward first (PB-8).
    return this.isPlaying ? this.livePicture() : this.lastT
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
    this.tail = null
    this.lastPicture = -Infinity
    this.earLag = 0
    this.earLagEstimate = null
    this.earLagAt = -Infinity
    this.soundHeard = audioScheduled && useAudioClock
    this.measureEarLag(this.readClock())
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

    // One tick of the clock. False when it stopped play (the end, J back at 0)
    // or a new play took over (onTick may call pause()/play()).
    const tick = (now: number): boolean => {
      this.tickedAt = now
      if (realignAudio && ctx !== null && ctx.currentTime > 0) {
        realignAudio = false
        this.rescheduleAudio()
      }
      const endS = Math.max(0, this.opts.getEndS())
      const clock = this.readClock()
      this.measureEarLag(clock)
      // `t` is where the SOUND is (the sample rendering now), which wraps a
      // loop and is where a pause stops; the picture is what reaches his ears.
      const t = this.timeAt(clock)
      const loopRange = rate > 0 ? (this.opts.getLoopRange?.() ?? null) : null
      const stopAt = loopRange
        ? Math.min(Math.max(loopRange.endS, loopRange.startS + 0.05), endS)
        : endS
      if (rate > 0 && loopRange && t >= stopAt) {
        // Re-anchor and swap the audio in place (no pause/play state churn,
        // the rAF loop never dies).
        //
        // ⛔ ON THE SOUND, NOT ON THIS FRAME (PB-9, 2026-10-06). The new
        // sound starts a scheduling latency plus its build time from now, and
        // the picture used to restart on this very frame, so every pass after
        // the first ran 50 ms and more AHEAD of the sound: the error MIC-4
        // removed from every other rebuild, left in the one place the loop
        // exists for, timing captions to the beat. So the picture holds the
        // first loop frame until the predicted start, and adoptAudio puts it
        // exactly on the sound when it lands.
        const fromS = Math.max(0, Math.min(loopRange.startS, stopAt))
        const calledAt = clock
        // The pass's last stretch of sound is still on its way to his ears,
        // so its picture plays on until it has arrived (PB-8).
        this.tail =
          this.earLag > 0
            ? { startS: this.startS, anchor: this.anchor, endS: stopAt, untilClock: calledAt + this.earLag }
            : null
        this.lastPicture = -Infinity
        this.lastT = fromS
        this.startS = fromS
        this.anchor = rate === 1 ? calledAt + SCHEDULE_LATENCY_S + this.rebuildS : calledAt
        // The pass he was hearing ends at the wrap, sound or picture alone.
        this.endHeard()
        const claim = this.claimAudio()
        // A shuttle is silent, looped or not: a sound at normal speed under a
        // 2x picture is not his edit.
        if (rate === 1) {
          void this.opts
            .schedule(fromS)
            .then((stop) => this.adoptAudio(claim, stop, fromS, { calledAt, continues: false }))
            .catch(() => undefined)
        }
        this.opts.onTick(this.pictureAt(calledAt))
        return token === this.playToken
      }
      const picture = this.pictureAt(clock)
      // The end is where he SEES it: its last frames are shown while their
      // sound plays out, and nothing sounds past the end.
      if (rate > 0 && !loopRange && picture >= endS) {
        this.lastT = endS
        this.stoppingAtEnd = true
        // pause() tells the playhead where play stopped (onPaused, else onTick).
        // A second onTick(endS) here put it back ON the end, where nothing
        // resolves, so every play that ran out left the monitor black (PB-17).
        this.pause()
        return false
      }
      if (rate < 0 && t <= 0) {
        this.lastT = 0
        // Told once, by pause(), like the end above.
        this.pause()
        return false
      }
      this.lastT = t
      this.opts.onTick(picture)
      // onTick may have called pause()/play(), so never double-schedule.
      return token === this.playToken
    }
    const loop = (now: number): void => {
      // A draw already ticked the clock in this frame (tickFrame): book the next.
      if (this.aheadAt === now) this.aheadAt = null
      else if (!tick(now)) return
      if (token !== this.playToken) return
      this.rafId = requestAnimationFrame(loop)
    }
    this.frameTick = (now) => {
      tick(now)
    }
    this.tickedAt = null
    this.aheadAt = null
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
  private claimAudio(seamless = false): number {
    // ⛔ A SEAMLESS REBUILD KEEPS THE OLD SOUND PLAYING UNTIL THE NEW ONE STARTS
    // (AU-9). Stopping it here left 50 ms and more of nothing, with a click at
    // each end, on every mix change mid-play. It is still taken out of the
    // running at once (the token moves), so the newest build alone survives, and
    // the stretch he is hearing simply runs on until the new sound opens its own.
    if (seamless) {
      if (this.stopAudio) {
        this.outgoing?.()
        this.outgoing = this.stopAudio
        this.stopAudio = null
      }
      return ++this.audioToken
    }
    // The sound he was hearing stops here. The picture alone keeps going, so a
    // picture-only span runs on until the new sound opens its own.
    if (this.heard?.sound) this.endHeard()
    this.stopOutgoing()
    this.stopAudio?.()
    this.stopAudio = null
    return ++this.audioToken
  }

  /** The old graph of a seamless rebuild goes now: the rebuild failed, or play stopped. */
  private stopOutgoing(): void {
    this.outgoing?.()
    this.outgoing = null
  }

  /** The new graph sounds from `ctxS`: the old one fades out across that moment. */
  private handOver(ctxS: number): void {
    const old = this.outgoing
    this.outgoing = null
    if (!old) return
    if (old.stopAt) old.stopAt(ctxS)
    else old()
  }

  /**
   * Keep a finished build only while it is still the newest one. A build that
   * lands mid-play (a late join, a loop wrap, a mix change) is a new stretch he
   * hears, from `fromS` at the time its sound was scheduled for.
   */
  private adoptAudio(claim: number, stop: StopAudio, fromS: number, rebuilt?: Rebuilt): void {
    if (claim !== this.audioToken) {
      stop()
      return
    }
    const ctx = this.isPlaying && this.currentRate === 1 ? this.contextOrNull() : null
    if (!ctx || !(ctx.currentTime > 0)) {
      this.stopAudio = stop
      if (this.outgoing && this.heard?.sound) this.endHeard()
      this.stopOutgoing()
      return
    }
    const startsAt = stop.startsAtCtxS ?? ctx.currentTime + SCHEDULE_LATENCY_S
    // Where the new sound starts on the timeline: where the scheduler placed it,
    // or else where it was asked to start.
    const soundS = stop.fromS ?? fromS
    // ⛔ NEVER FOLLOW A LATE SOUND BACK (SF-1, review 2026-10-08). A rebuild that
    // waited seconds on a decode or a noise pass used to start from where the
    // playhead was when it was ASKED for, and the picture was then moved onto
    // it: both jumped back by the build time and replayed it. scheduleAudio now
    // places the sound where the picture is when it starts, so this only catches
    // a scheduler that could not: its sound goes unheard, the old sound plays on,
    // and one more is built from the live time (warm by now, so quick). Only if
    // that one is late too does the picture follow, rather than run on with the
    // sound behind it.
    //
    // A sound joining a picture that rolled alone was asked to start `joinLag`
    // ahead (see rebuild), so it is judged against where the picture will be when
    // the sound reaches his ears, not where it is when the sound starts.
    if (rebuilt?.retry && soundS < this.timelineAtCtx(ctx, startsAt + (rebuilt.joinLagS ?? 0)) - FOLLOW_BACK_MAX_S) {
      stop()
      rebuilt.retry()
      return
    }
    this.stopAudio = stop
    this.handOver(startsAt)
    // Asked for mid-play: put the picture on the sound. A loop wrap does this
    // too, but is a NEW pass for a take, not a continuation (`continues: false`).
    if (rebuilt) this.followSound(ctx, startsAt, soundS, rebuilt.calledAt, stop.fromS === undefined)
    this.openHeard({
      timelineS: soundS,
      heardAtMs: heardAtMsOf(ctx, startsAt),
      sound: true,
      ctxS: startsAt,
      continues: rebuilt !== undefined && rebuilt.continues !== false,
    })
  }

  /**
   * A sound rebuilt mid-play lands, scheduled to sound `fromS` at `startsAt`:
   * put the picture exactly on it. A sound the scheduler placed itself is
   * already where the picture is, so nothing moves; a predicted one is off only
   * by how wrong the build-time guess was, a few ms (see FOLLOW_BACK_MAX_S). A
   * play that began before the context's clock had started (the picture on the
   * performance clock) moves onto the context clock here, where the sound is.
   *
   * ⛔ ONLY A PREDICTED BUILD, AND ONLY A QUICK ONE, IS LEARNED. A build that
   * waited 1.5 s on a decode used to be learned too, and the next quick rebuild
   * (a mute, a clip moved) then asked for the sound 0.75 s ahead of the picture
   * and both skipped forward to it.
   */
  private followSound(ctx: AudioContext, startsAt: number, fromS: number, calledAt: number, predicted: boolean): void {
    if (this.readClock === perfClock) {
      this.readClock = () => ctx.currentTime
    } else if (predicted) {
      const took = startsAt - SCHEDULE_LATENCY_S - calledAt
      if (took >= 0 && took < REBUILD_LEARN_MAX_S) this.rebuildS = (this.rebuildS + took) / 2
    }
    // The first sound of this play: the picture takes on the lag here, and the
    // sound was scheduled from where the picture will be when he hears it.
    if (!this.soundHeard) {
      this.soundHeard = true
      this.earLagAt = -Infinity
      this.earLagEstimate = null
      this.measureEarLag(ctx.currentTime)
    }
    this.anchor = startsAt - (fromS - this.startS) / this.currentRate
  }

  /**
   * The timeline time the picture shows at context time `ctxS`, on whichever
   * clock it runs: the context's own, or the performance clock before the
   * context's had started.
   */
  private timelineAtCtx(ctx: AudioContext | null, ctxS: number): number {
    if (!ctx) return this.liveTime()
    if (this.readClock !== perfClock) return this.timeAt(ctxS)
    return this.timeAt(this.readClock() + (ctxS - ctx.currentTime))
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
  rescheduleAudio(opts: { seamless?: boolean } = {}): void {
    this.rebuild(opts.seamless === true, true)
  }

  /** One rebuild. `mayRetry`: a sound that lands too late to use may be built once more. */
  private rebuild(seamless: boolean, mayRetry: boolean): void {
    if (!this.isPlaying || !this.intended || this.currentRate !== 1) return
    // Seamless for a change he made to the mix or the clips, where the sound
    // playing now is right up to the moment the new one starts. Not for the
    // late join or the clock that started late: there the old sound is the
    // fault being replaced.
    const claim = this.claimAudio(seamless)
    // ⛔ FROM WHERE THE PLAYHEAD WILL BE WHEN THE NEW SOUND STARTS, not from
    // where it is now (MIC-4, 2026-10-01). A rebuilt sound starts a scheduling
    // latency plus its build time after this call, so scheduling it from here
    // left the sound that far BEHIND the picture for the rest of the play: 50 ms
    // and up after every late first sound and every mix change, and a take
    // recorded across it came out split on two lines with 80 to 125 ms of his
    // voice twice, or 84 ms of it cut out. The prediction uses the learned build
    // time, and adoptAudio puts the picture exactly on the sound when it lands.
    // `follow` lets the scheduler do better than predict: it starts the sound
    // from where the picture is at the moment the sound really starts (SF-1).
    const calledAt = this.readClock()
    // A picture still rolling alone has no lag, and takes it on when this sound
    // joins it (followSound): so this sound starts from where the picture will
    // be when it reaches his ears, and the picture never steps back. `follow`
    // says the same to a scheduler that places the sound itself.
    const ctx = this.soundHeard ? null : this.contextOrNull()
    const joinLagS = ctx ? earLagOf(ctx) : 0
    const fromS = this.timeAt(calledAt + SCHEDULE_LATENCY_S + this.rebuildS + joinLagS)
    const follow = (ctxS: number): number => this.timelineAtCtx(this.contextOrNull(), ctxS + joinLagS)
    const retry = mayRetry ? () => this.rebuild(seamless, false) : undefined
    void this.opts
      .schedule(fromS, follow)
      .then((stop) => this.adoptAudio(claim, stop, fromS, { calledAt, retry, joinLagS }))
      .catch(() => {
        // Nothing to hand over to: the old sound of a seamless rebuild stops.
        if (claim !== this.audioToken || !this.outgoing) return
        if (this.heard?.sound) this.endHeard()
        this.stopOutgoing()
      })
  }

  /**
   * A fader, pan, mute or solo moved mid-play: move the live graph's own gains
   * (AU-9). True when it could; false when the change needs a rebuild, or there
   * is no live graph to move (not playing, or a build still in the air, which
   * reads the store when it starts and so has to be built again anyway).
   */
  setMix(tracks: readonly Track[]): boolean {
    if (!this.isPlaying || !this.intended || this.currentRate !== 1) return false
    const live = this.stopAudio
    if (!live?.setMix || this.outgoing) return false
    return live.setMix(tracks)
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
    const ranOut = this.stoppingAtEnd
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
    if (wasPlaying) {
      if (this.opts.onPaused) this.opts.onPaused(this.lastT, ranOut)
      else this.opts.onTick(this.lastT)
    }
    return this.lastT
  }

  /**
   * ⛔ THE PICTURE RAN AHEAD OF THE SOUND BY THE OUTPUT LATENCY (PB-8,
   * 2026-10-07). The clock is the sample the audio graph is rendering, and his
   * ears get that sample the output latency later: measured on his default
   * output, 41 ms (two and a half frames of a 60 fps edit), and 150 to 250 ms on
   * Bluetooth. A cut he saw landed before the beat he heard, so cuts set by eye
   * to the beat went into the export late.
   *
   * So the picture is what is reaching his ears: the clock less the lag. Only
   * the picture. Where a pause stops, where a loop wraps and where a rebuilt
   * sound starts stay on the rendered sample, because that is what the device
   * plays out and what a dub resumes from (MIC-4, MIC-5). Two consequences
   * follow from it, and both are what he hears: the last frames of the edit are
   * shown while their sound plays out (the end is where he SEES it), and a
   * looped pass is shown to its end while its last sound arrives (the tail).
   */
  private pictureAt(clock: number): number {
    if (this.tail && clock >= this.tail.untilClock) {
      // The wrapped pass has played out; the next starts from its own first frame.
      this.tail = null
      this.lastPicture = -Infinity
    }
    let p = this.rawPicture(clock)
    // A re-measured lag moves the picture by a few ms, and never backward.
    if (this.currentRate > 0) {
      p = Math.max(p, this.lastPicture)
      this.lastPicture = p
    }
    return p
  }

  /** The picture at a clock reading, before the never-backward hold. */
  private rawPicture(clock: number): number {
    const tail = this.tail
    if (tail && clock < tail.untilClock) {
      // Never below the pass's own first frame: for a loop shorter than the lag
      // the clock wraps before the pass's first sound has reached him, and the
      // sum is negative (N2). A tail is only ever made at a forward rate.
      return Math.min(tail.endS, Math.max(tail.startS, tail.startS + (clock - this.earLag - tail.anchor) * this.currentRate))
    }
    return this.timeAt(clock - this.earLag)
  }

  /** The picture now, as pictureAt would draw it, without moving anything. */
  private livePicture(): number {
    const clock = this.readClock()
    const p = this.rawPicture(clock)
    const tailOver = this.tail !== null && clock >= this.tail.untilClock
    return this.currentRate > 0 && !tailOver ? Math.max(p, this.lastPicture) : p
  }

  /**
   * Measure the lag, at most once a second, while the picture runs on the sound:
   * normal speed, on the audio clock, once a sound has joined. A shuttle is
   * silent and a picture rolling alone has nothing to wait for, so there it is 0.
   */
  private measureEarLag(clock: number): void {
    if (this.currentRate !== 1 || this.readClock === perfClock || !this.soundHeard) {
      this.earLag = 0
      this.earLagEstimate = null
      return
    }
    if (clock - this.earLagAt < EAR_LAG_EVERY_S) return
    this.earLagAt = clock
    const ctx = this.contextOrNull()
    if (!ctx) return
    const lag = earLagOf(ctx)
    // The estimate is smoothed, and the gate is on the estimate: a reading is
    // off by ~10 ms either way, which moved the picture across a frame boundary
    // about once a second (N1). It is the measurement that is smoothed and not the
    // sync: the picture is still the clock less the lag, and a different device
    // is a step far past the scatter, followed at once.
    const prev = this.earLagEstimate
    const estimate = prev === null || Math.abs(lag - prev) > EAR_LAG_STEP_S ? lag : prev + (lag - prev) * EAR_LAG_SMOOTHING
    this.earLagEstimate = estimate
    if (Math.abs(estimate - this.earLag) > EAR_LAG_JITTER_S) this.earLag = estimate
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
    this.frameTick = null
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    // Bumped even when nothing is playing: a build still decoding has to know
    // its playback is over by the time it lands.
    this.audioToken++
    this.stopOutgoing()
    if (this.stopAudio) {
      this.stopAudio()
      this.stopAudio = null
    }
  }
}
