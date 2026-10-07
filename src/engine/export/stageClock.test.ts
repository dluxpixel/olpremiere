// Where a desktop export's time goes (stageClock.ts): the worker's split of each frame, and the
// line the usage log keeps.

import { describe, expect, it } from 'vitest'
import { exportSpeed, stageClock, stageLine } from './stageClock'

describe('the stage clock', () => {
  it('gives each stage the time since the mark before it, summed over the frames', () => {
    let t = 1000
    const clock = stageClock(() => t)
    for (let f = 0; f < 3; f++) {
      t += 20 // decode
      clock.mark('read')
      t += 2 // composite handed over
      clock.mark('draw')
      t += 5 // GPU done and read back
      clock.mark('pixels')
      t += 13 // ffmpeg took it
      clock.mark('wait')
      clock.frame()
    }
    expect(clock.times()).toEqual({ frames: 3, read: 60, draw: 6, pixels: 15, wait: 39 })
  })

  it('hands out a copy, so the worker can keep counting after it has posted one', () => {
    let t = 0
    const clock = stageClock(() => t)
    t = 10
    clock.mark('read')
    const first = clock.times()
    t = 30
    clock.mark('read')
    expect(first.read).toBe(10)
    expect(clock.times().read).toBe(30)
  })
})

describe('what the usage log keeps', () => {
  it('frames per second over the whole run, and each stage as a share of the video', () => {
    // 1,350 frames, a 45 s Short at 30 fps, made in 150 s from first frame to finished file.
    const speed = exportSpeed({ frames: 1350, read: 41_000, draw: 9_000, pixels: 12_000, wait: 38_000 }, 150_000)
    expect(speed).toEqual({ fps: 9, read: 41, draw: 9, pixels: 12, wait: 38 })
    expect(stageLine(speed!)).toBe('read 41 draw 9 pixels 12 wait 38')
  })

  it('says nothing rather than something made up: no frames, no time', () => {
    expect(exportSpeed({ frames: 0, read: 0, draw: 0, pixels: 0, wait: 0 }, 1000)).toBeNull()
    expect(exportSpeed({ frames: 10, read: 5, draw: 1, pixels: 1, wait: 1 }, 0)).toBeNull()
    expect(exportSpeed({ frames: 10, read: 0, draw: 0, pixels: 0, wait: 0 }, 1000)).toBeNull()
  })
})
