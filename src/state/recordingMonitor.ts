// The live side of the recording studio: one persistent mic stream that the
// meter, the "hear myself" monitor path, and the MediaRecorder capture all tap
// at once. Kept apart from voiceRecorder's capture logic because this is Web
// Audio graph plumbing (source -> gain -> destination -> <audio sinkId>) and
// device routing, none of which the capture path needs to know about.
//
// Monitoring routes the mic to a chosen OUTPUT. On modern engines that is a
// DIRECT AudioContext.setSinkId path (low latency); older engines fall back to
// an <audio> element sink. Echo cancellation stays off for recording quality,
// so monitoring on SPEAKERS feeds back; the panel warns and headphones are the
// intended path.

export interface MonitorGraph {
  /** The live mic stream MediaRecorder records from. */
  readonly stream: MediaStream
  /** The name of the input really recording, as the system calls it ('' before permission). */
  readonly inputLabel: string
  /** The chosen mic was not there, so the system default was opened instead. */
  readonly fellBack: boolean
  /** The capture's own delay, seconds, as the track reports it. 0 when it does not say. */
  readonly inputLatencyS: number
  /**
   * The input's PEAK since the previous call (linear, 1 = full scale), for the
   * meter. Every sample counts: see freshSamples. Cheap to poll each frame.
   */
  level(): number
  /** Hear yourself: 1 routes the mic to the output, 0 mutes the monitor (meter still works). */
  setMonitoring(on: boolean): void
  /** Route the monitor to an output device ('' / null = system default). */
  setOutput(deviceId: string | null): Promise<void>
  /** Release the mic, the graph, and the monitor element. Safe to call twice. */
  dispose(): void
}

/**
 * How many samples arrived since the meter last looked, so a peak between two
 * polls is never missed. The context renders `(nowS - prevS) * sampleRate` new
 * samples between two reads of its clock; a margin of a few render quanta
 * covers the analyser and the clock being read a quantum apart, and a peak
 * counted twice costs nothing. Capped at the analyser's window: a stall longer
 * than that (a hidden window) is the one gap left, and the take itself is
 * checked for clipping when it stops (voiceRecorder, finalize).
 */
export function freshSamples(prevS: number | null, nowS: number, sampleRate: number, windowSize: number): number {
  if (prevS === null || !(nowS >= prevS)) return windowSize
  return Math.min(windowSize, Math.ceil((nowS - prevS) * sampleRate) + FRESH_MARGIN)
}
const FRESH_MARGIN = 512

/** Absolute peak of the newest `count` samples of a time-ordered window. */
export function peakOfNewest(buf: Float32Array, count: number): number {
  let peak = 0
  for (let i = Math.max(0, buf.length - count); i < buf.length; i++) {
    const a = Math.abs(buf[i]!)
    if (a > peak) peak = a
  }
  return peak
}

/**
 * Acquire the mic for `deviceId` and build the shared graph. Throws on a
 * blocked/absent mic (the caller shows the message); a pinned device that has
 * vanished is retried on the default so a missing mic never means silence, and
 * `fellBack` says so, because recording from the wrong mic without a word is
 * its own kind of broken (MIC-8).
 */
export async function createMonitorGraph(
  deviceId: string | null,
  constraintFor: (id: string | null) => MediaTrackConstraints,
): Promise<MonitorGraph> {
  let stream: MediaStream
  let fellBack = false
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraintFor(deviceId) })
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraintFor(null) })
      fellBack = true
    } else {
      throw err
    }
  }

  type SinkableCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> }

  // Interactive latency hint: the monitor is a live "hear yourself" path, so ask
  // the engine for the smallest output buffer it will give us.
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  // Resume in case the tab has no prior gesture; the studio opens from a click,
  // so this is gesture-blessed, but resume() is harmless if already running.
  void ctx.resume().catch(() => {})

  const source = ctx.createMediaStreamSource(stream)
  // ⛔ ONE ANALYSER PER CHANNEL (MIC-3, 2026-10-01). An AnalyserNode mixes its
  // input down to mono before it hands anything out, so one analyser on a
  // stereo input reads (L + R) / 2. His inputs are the same voice on both sides,
  // where that is harmless, but a mic on one input of an interface with the other
  // side empty reads 6 dB LOW, and a take clipped in the real app without the
  // light ever coming on. The meter shows the hotter side, which is the one that
  // clips.
  //
  // ⛔ 16384 SAMPLES, NOT 1024 (MIC-3, 2026-09-30). The meter used to look at
  // the last 21 ms each frame, so a peak between two frames that ran long was
  // never seen. This window covers a third of a second of polling gap, and
  // freshSamples reads only what is new in it.
  const splitter = ctx.createChannelSplitter(2)
  source.connect(splitter) // the meter taps BEFORE the monitor gain, so it reads even when muted
  const analysers = [0, 1].map((ch) => {
    const a = ctx.createAnalyser()
    a.fftSize = 16384
    splitter.connect(a, ch)
    return a
  })

  const monitorGain = ctx.createGain()
  monitorGain.gain.value = 0 // start muted: never surprise the user with feedback
  source.connect(monitorGain)

  // Prefer routing the CONTEXT itself to the chosen output (AudioContext.setSinkId,
  // Chromium 110+/Electron): monitorGain -> ctx.destination is a DIRECT path at
  // interactive latency. The old MediaStreamDestination -> <audio> element route
  // added a whole jitter buffer of delay (the "hear myself is delayed" complaint),
  // so it survives only as the FALLBACK for engines without ctx.setSinkId (Firefox).
  const ctxSinkable = typeof (ctx as SinkableCtx).setSinkId === 'function'
  let el: HTMLAudioElement | null = null
  if (ctxSinkable) {
    monitorGain.connect(ctx.destination)
  } else {
    const dest = ctx.createMediaStreamDestination()
    monitorGain.connect(dest)
    el = new Audio()
    el.srcObject = dest.stream
    el.autoplay = true
    void el.play().catch(() => {})
  }

  const buf = new Float32Array(analysers[0]!.fftSize)
  let polledAtS: number | null = null
  const track = stream.getAudioTracks()[0]
  const settings: MediaTrackSettings & { latency?: number } = track?.getSettings?.() ?? {}

  return {
    stream,
    inputLabel: track?.label ?? '',
    fellBack,
    inputLatencyS: typeof settings.latency === 'number' && settings.latency > 0 ? settings.latency : 0,
    level() {
      const now = ctx.currentTime
      const fresh = freshSamples(polledAtS, now, ctx.sampleRate, buf.length)
      polledAtS = now
      let peak = 0
      for (const a of analysers) {
        a.getFloatTimeDomainData(buf)
        peak = Math.max(peak, peakOfNewest(buf, fresh))
      }
      return peak
    },
    setMonitoring(on) {
      // A short ramp instead of a hard step so toggling never clicks.
      const t = ctx.currentTime
      monitorGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01)
    },
    async setOutput(id) {
      // Fast path: route the context. Fallback: the <audio> element's sink.
      if (ctxSinkable) {
        try {
          await (ctx as SinkableCtx).setSinkId!(id ?? '')
        } catch {
          // Device gone / denied: stay on the current sink rather than throw.
        }
        return
      }
      const sinkable = el as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
      if (!sinkable || typeof sinkable.setSinkId !== 'function') return
      try {
        await sinkable.setSinkId(id ?? '')
      } catch {
        // Device gone / denied: stay on the current sink.
      }
    },
    dispose() {
      if (el) {
        el.pause()
        el.srcObject = null
      }
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => {})
    },
  }
}

/** Output (speaker/headphone) devices. Labels need one prior mic grant, same as inputs. */
export async function listAudioOutputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
}

/** Whether this browser can route to a chosen output device at all. */
export const canPickOutput = (): boolean =>
  typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype
