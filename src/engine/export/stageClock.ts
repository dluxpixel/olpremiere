// Where a desktop export's time goes, so the next speed fix is aimed by data.
//
// Export audit, 2026-10-06: x264 alone ran 26 fps on his Minecraft frames while
// the whole export ran about 8 on similar footage, so on easy footage the
// encoder is not what he waits for, and nothing said what was. Now every desktop
// export's line in the usage log says how fast it made frames and where the time
// went. The worker splits each frame's time four ways:
//
//   read    getting the source frames (the decode), and the frame's set up
//   draw    the composite, as far as handing it to the GPU
//   pixels  the GPU finishing it and the frame read back
//   wait    the page and ffmpeg taking the frame: when this is most of it, the
//           encoder is the limit
//
// and the page adds the frames per second of the whole run, from the first frame
// to the finished file, the encoder's tail included.

export type StageName = 'read' | 'draw' | 'pixels' | 'wait'

/** Milliseconds per stage, summed over the video, and the frames they cover. */
export interface StageTimes extends Record<StageName, number> {
  frames: number
}

export interface StageClock {
  /** The time since the last mark (or since the clock was made) went to `stage`. */
  mark: (stage: StageName) => void
  /** One more frame made. */
  frame: () => void
  times: () => StageTimes
}

export function stageClock(now: () => number = () => performance.now()): StageClock {
  const times: StageTimes = { frames: 0, read: 0, draw: 0, pixels: 0, wait: 0 }
  let last = now()
  return {
    mark(stage) {
      const t = now()
      times[stage] += t - last
      last = t
    },
    frame() {
      times.frames++
    },
    times: () => ({ ...times }),
  }
}

/** What the usage log keeps: frames per second over the whole run, and each stage's share in percent. */
export interface ExportSpeed extends Record<StageName, number> {
  fps: number
}

/** Null when there is nothing honest to say: no frames, or no time. */
export function exportSpeed(times: StageTimes, wallMs: number): ExportSpeed | null {
  const sum = times.read + times.draw + times.pixels + times.wait
  if (!(times.frames > 0) || !(wallMs > 0) || !(sum > 0)) return null
  const share = (ms: number): number => Math.round((ms / sum) * 100)
  return {
    fps: Math.round((times.frames / (wallMs / 1000)) * 10) / 10,
    read: share(times.read),
    draw: share(times.draw),
    pixels: share(times.pixels),
    wait: share(times.wait),
  }
}

/** One short line for the log, one number per stage: "read 41 draw 9 pixels 12 wait 38". */
export const stageLine = (s: ExportSpeed): string => `read ${s.read} draw ${s.draw} pixels ${s.pixels} wait ${s.wait}`
