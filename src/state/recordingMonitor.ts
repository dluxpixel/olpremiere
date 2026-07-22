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
  /** 0..1 input level right now (peak), for the meter. Cheap to poll each frame. */
  level(): number
  /** Hear yourself: 1 routes the mic to the output, 0 mutes the monitor (meter still works). */
  setMonitoring(on: boolean): void
  /** Route the monitor to an output device ('' / null = system default). */
  setOutput(deviceId: string | null): Promise<void>
  /** Release the mic, the graph, and the monitor element. Safe to call twice. */
  dispose(): void
}

/**
 * Acquire the mic for `deviceId` and build the shared graph. Throws on a
 * blocked/absent mic (the caller shows the message); a pinned device that has
 * vanished is retried on the default so a missing mic never means silence.
 */
export async function createMonitorGraph(
  deviceId: string | null,
  constraintFor: (id: string | null) => MediaTrackConstraints,
): Promise<MonitorGraph> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraintFor(deviceId) })
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraintFor(null) })
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
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser) // the meter taps BEFORE the monitor gain, so it reads even when muted

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

  const buf = new Float32Array(analyser.fftSize)

  return {
    stream,
    level() {
      analyser.getFloatTimeDomainData(buf)
      let peak = 0
      for (const v of buf) {
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
      return Math.min(1, peak)
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
