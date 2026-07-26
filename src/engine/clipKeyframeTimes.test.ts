import { describe, expect, it } from 'vitest'
import { clipKeyframeTimes, moveKeyframeMoment } from './keyframes'

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

describe('moveKeyframeMoment', () => {
  const clip = () => ({
    keyframes: {
      scale: [{ t: 0, value: 1, ease: 'linear' as const }, { t: 0.5, value: 1.3, ease: 'linear' as const }],
      posX: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 0.5, value: 10, ease: 'linear' as const }],
    },
    effects: [
      {
        params: {
          blur: 4,
          brightness: { value: 0, keyframes: [{ t: 0.5, value: 1, ease: 'linear' as const }] },
        },
      },
    ],
  })

  it('moves EVERY channel at that moment, together', () => {
    const out = moveKeyframeMoment(clip(), 0.5, 1.2, 3)
    expect(out.keyframes.scale.map((k) => k.t)).toEqual([0, 1.2])
    expect(out.keyframes.posX.map((k) => k.t)).toEqual([0, 1.2])
    // ...including a keyframed effect param at the same instant.
    const b = out.effects[0].params.brightness as { keyframes: { t: number }[] }
    expect(b.keyframes.map((k) => k.t)).toEqual([1.2])
    // Values ride along untouched.
    expect(out.keyframes.scale[1].value).toBe(1.3)
    expect((out.effects[0].params.blur as number)).toBe(4)
  })

  it('cannot pass its neighbour, so a drag can never reorder anything', () => {
    const out = moveKeyframeMoment(clip(), 0.5, -5, 3)
    expect(out.keyframes.scale[1].t).toBeGreaterThan(0)
    expect(out.keyframes.scale.map((k) => k.t)).toEqual([...out.keyframes.scale.map((k) => k.t)].sort((a, b) => a - b))
  })

  it('stays inside the clip', () => {
    const out = moveKeyframeMoment(clip(), 0.5, 99, 3)
    expect(out.keyframes.scale[1].t).toBeLessThanOrEqual(3)
  })

  // A trim can leave a keyframe beyond the out point (a recompile only happens
  // while the keyframes still match the preset, so hand-authored animation is
  // left alone). That stale moment used to be the ONLY ceiling for the ones
  // before it, which let them be dragged past the end of the clip.
  it('stays inside the clip even when a later moment is already past the end', () => {
    const stranded = {
      keyframes: {
        scale: [
          { t: 1, value: 1, ease: 'linear' as const },
          { t: 8, value: 2, ease: 'linear' as const },
        ],
      },
    }
    const out = moveKeyframeMoment(stranded, 1, 7, 5)
    expect(out.keyframes.scale[0].t).toBeLessThanOrEqual(5)
  })

  it('is a no-op for a moment that is not there, or a move that changes nothing', () => {
    const c = clip()
    expect(moveKeyframeMoment(c, 2.5, 1, 3)).toBe(c)
    expect(moveKeyframeMoment(c, 0.5, 0.5, 3)).toBe(c)
  })

  it('leaves the clip animating the same way at the times it did not touch', () => {
    const out = moveKeyframeMoment(clip(), 0.5, 1.2, 3)
    expect(out.keyframes.scale[0]).toEqual({ t: 0, value: 1, ease: 'linear' })
  })
})

describe('a clamped drag is a no-op, not an undo entry', () => {
  it('returns the identical clip when the clamp lands it back where it started', () => {
    const c = {
      keyframes: { scale: [{ t: 0, value: 1, ease: 'linear' as const }, { t: 0.5, value: 2, ease: 'linear' as const }] },
    }
    // Dragging the second moment left, past its neighbour: the clamp pins it just
    // clear of t=0, which IS a move. Dragging it to where it already is is not.
    expect(moveKeyframeMoment(c, 0.5, 0.5, 3)).toBe(c)
    expect(moveKeyframeMoment(c, 0.5, 0.5 + 1e-6, 3)).toBe(c)
  })
})
