import { describe, expect, it } from 'vitest'
import { addSample, timeLeftS, timeLeftWords, type ProgressSample } from './timeLeft'

/** Points every half second, the way ffmpeg's -progress reports. */
function run(gapS: number, fps: number, untilS: number): ProgressSample[] {
  let samples: ProgressSample[] = []
  for (let t = 0; t <= untilS; t += 0.5) {
    const frames = t < gapS ? 0 : Math.floor((t - gapS) * fps)
    samples = addSample(samples, { t: t * 1000, frames })
  }
  return samples
}

describe('the time left', () => {
  it('⛔ is read from the recent rate, not from when Export was pressed', () => {
    // 20 s of save dialog, sound and ffmpeg warming up, then a steady 10 fps on 1350 frames.
    const samples = run(20, 10, 30)
    const done = samples[samples.length - 1].frames
    const truth = (1350 - done) / 10
    const left = timeLeftS(samples, 1350)
    expect(Math.abs(left - truth) / truth).toBeLessThan(0.1)
    // The old way: elapsed since the press over frames done. Three times too long here.
    const old = (30 / done) * (1350 - done)
    expect(old / truth).toBeGreaterThan(2.5)
  })

  it('right after the first frames too, before the window is full', () => {
    const samples = run(20, 10, 22)
    const done = samples[samples.length - 1].frames
    expect(Math.abs(timeLeftS(samples, 1350) - (1350 - done) / 10) / ((1350 - done) / 10)).toBeLessThan(0.1)
  })

  it('follows a change of pace within the window', () => {
    let samples: ProgressSample[] = []
    for (let t = 0; t <= 60; t += 0.5) samples = addSample(samples, { t: t * 1000, frames: Math.floor(t < 30 ? t * 20 : 600 + (t - 30) * 5) })
    // Now 5 fps with 1800 - 750 left.
    expect(timeLeftS(samples, 1800)).toBeCloseTo((1800 - 750) / 5, -1)
  })

  it('says nothing until there is a rate', () => {
    expect(timeLeftS([], 100)).toBeNaN()
    expect(timeLeftS(run(5, 10, 4), 100)).toBeNaN()
    expect(timeLeftS([{ t: 0, frames: 10 }, { t: 400, frames: 12 }], 100)).toBeNaN()
  })

  it('starts over when the count goes back to 0', () => {
    const samples = addSample(run(0, 10, 5), { t: 6000, frames: 0 })
    expect(samples).toEqual([{ t: 6000, frames: 0 }])
  })

  it('in plain words', () => {
    expect(timeLeftWords(NaN)).toBe('')
    expect(timeLeftWords(4)).toBe('Almost done')
    expect(timeLeftWords(37)).toBe('About 40 seconds left')
    expect(timeLeftWords(120)).toBe('About 2 min left')
    expect(timeLeftWords(100 * 60)).toBe('About 100 min left')
  })
})
