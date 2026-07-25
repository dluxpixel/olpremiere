import { describe, expect, it } from 'vitest'
import { clipKeyframeTimes } from './keyframes'

const kf = (t: number) => ({ t, value: 0, ease: 'linear' as const })

describe('clipKeyframeTimes', () => {
  it('is empty for a clip that animates nothing', () => {
    expect(clipKeyframeTimes({})).toEqual([])
    expect(clipKeyframeTimes({ keyframes: {}, effects: [] })).toEqual([])
  })

  it('collects every animated channel, sorted', () => {
    expect(
      clipKeyframeTimes({
        keyframes: { scale: [kf(1), kf(0)], opacity: [kf(2)] },
      }),
    ).toEqual([0, 1, 2])
  })

  it('collapses one MOMENT that animates several channels into one mark', () => {
    // A punch-in animates scale AND position at the same instant; that is one
    // keyframe to the person looking at the clip.
    expect(
      clipKeyframeTimes({
        keyframes: { scale: [kf(0), kf(0.5)], posX: [kf(0), kf(0.5)], posY: [kf(0), kf(0.5)] },
      }),
    ).toEqual([0, 0.5])
  })

  it('includes keyframed EFFECT params, and ignores static ones', () => {
    expect(
      clipKeyframeTimes({
        keyframes: { opacity: [kf(0)] },
        effects: [{ params: { blur: 4, brightness: { keyframes: [kf(3)] } } }],
      }),
    ).toEqual([0, 3])
  })

  it('does not merge moments that are genuinely apart', () => {
    expect(clipKeyframeTimes({ keyframes: { scale: [kf(0), kf(0.001)] } })).toEqual([0, 0.001])
  })
})
