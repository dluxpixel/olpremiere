import { describe, expect, it } from 'vitest'
import { newProject, newTitleClip, defaultTitleDef, type Clip, type Keyframe, type Project } from '../types'
import { evalChannel } from '../keyframes'
import { resolveChannel, withChannelKeyframes } from '../effects/channels'
import {
  APPEARANCE_CHANNELS,
  applyAppearanceToClip,
  buildAppearanceKeyframes,
  DEFAULT_APPEARANCE_DUR,
  ENTRANCE_PRESETS,
  EXIT_PRESETS,
  isEmptyAppearance,
  isEntranceId,
  isExitId,
  migrateProjectAppearance,
  POP_FROM,
  POP_PEAK_AT,
  retimeAppearance,
  splitAppearanceSpec,
  upgradeLegacyAppearance,
} from './appearance'

const W = 1920
const H = 1080

/** Every keyframe list an appearance emits must be strictly time-ordered. */
function assertSortedUnique(kfs: { t: number }[]): void {
  for (let i = 1; i < kfs.length; i++) {
    expect(kfs[i].t).toBeGreaterThan(kfs[i - 1].t)
  }
}

describe('appearance presets', () => {
  it('exposes stable ids for every preset', () => {
    expect(ENTRANCE_PRESETS.map((p) => p.id)).toEqual([
      'fadeIn',
      'pop',
      'slideIn',
      'zoomIn',
      'riseUp',
      // Spin in and Bounce were CUT 2026-07-29 as casual. If either comes back,
      // it comes back because he asked, not by accident.
    ])
    expect(EXIT_PRESETS.map((p) => p.id)).toEqual([
      'fadeOut',
      'popOut',
      'slideOut',
      'zoomOut',
      'dropDown',
      // Spin out was CUT 2026-07-29. It is the one he named.
    ])
  })

  it('an entrance settles to base at the window end', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.5 }, 5, W, H)
    expect(kfs.scale).toBeDefined()
    assertSortedUnique(kfs.scale!)
    // Starts a touch small, ends at base scale (1) exactly at t=d.
    expect(evalChannel(kfs.scale, 0, 1)).toBeCloseTo(POP_FROM, 5)
    expect(evalChannel(kfs.scale, 0.5, 1)).toBeCloseTo(1, 5)
    // And holds base afterwards.
    expect(evalChannel(kfs.scale, 4, 1)).toBeCloseTo(1, 5)
    // An entrance that fades ramps opacity 0 -> 1 and holds.
    const fade = buildAppearanceKeyframes({ in: 'fadeIn', durS: 0.5 }, 5, W, H)
    expect(evalChannel(fade.opacity, 0, 1)).toBeCloseTo(0, 5)
    expect(evalChannel(fade.opacity, 4, 1)).toBeCloseTo(1, 5)
  })

  it('an exit starts from base and leaves at 0 opacity', () => {
    const D = 5
    const kfs = buildAppearanceKeyframes({ out: 'fadeOut', durS: 0.5 }, D, W, H)
    expect(kfs.opacity).toBeDefined()
    // Holds base (1) until the window, then falls to 0 at the very end.
    expect(evalChannel(kfs.opacity, 0, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D - 0.5, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('merges entrance + exit on a shared channel without colliding keyframes', () => {
    // pop (scale) + zoomOut (scale, opacity) share the scale channel.
    const D = 5
    const kfs = buildAppearanceKeyframes({ in: 'pop', out: 'zoomOut', durS: 0.5 }, D, W, H)
    assertSortedUnique(kfs.scale!)
    assertSortedUnique(kfs.opacity!)
    // Base held in the middle, animates at both ends.
    expect(evalChannel(kfs.scale, 0, 1)).toBeCloseTo(POP_FROM, 5) // pop start
    expect(evalChannel(kfs.scale, 2.5, 1)).toBeCloseTo(1, 5) // settled middle
    expect(evalChannel(kfs.scale, D, 1)).toBeCloseTo(0, 5) // zoomed out
    expect(evalChannel(kfs.opacity, 2.5, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('clamps the window so in and out never overlap on a short clip', () => {
    // D = 0.4, requested 0.5 -> d clamps to 0.2; in ends at 0.2, out starts at 0.2.
    const D = 0.4
    const kfs = buildAppearanceKeyframes({ in: 'fadeIn', out: 'fadeOut', durS: 0.5 }, D, W, H)
    assertSortedUnique(kfs.opacity!)
    // No duplicate keyframe at the shared boundary t=0.2.
    const atBoundary = kfs.opacity!.filter((k) => Math.abs(k.t - 0.2) < 1e-4)
    expect(atBoundary.length).toBe(1)
    // Fully visible at the seam, invisible at both ends.
    expect(evalChannel(kfs.opacity, 0, 1)).toBeCloseTo(0, 5)
    expect(evalChannel(kfs.opacity, 0.2, 1)).toBeCloseTo(1, 5)
    expect(evalChannel(kfs.opacity, D, 1)).toBeCloseTo(0, 5)
  })

  it('is base-relative: settled values track the clip base', () => {
    const base = { opacity: 1, scale: 1.5, posX: 100, posY: -40, rotation: 0 }
    const kfs = buildAppearanceKeyframes({ in: 'pop' }, 5, W, H, base)
    // pop settles to base.scale, not neutral 1.
    expect(evalChannel(kfs.scale, 4, base.scale)).toBeCloseTo(1.5, 5)
  })

  it('slide/rise offsets scale to the frame size', () => {
    const kfs = buildAppearanceKeyframes({ in: 'slideIn' }, 5, W, H)
    // starts off to the left by half the frame width, settles at 0.
    expect(evalChannel(kfs.posX, 0, 0)).toBeCloseTo(-W * 0.5, 3)
    expect(evalChannel(kfs.posX, 4, 0)).toBeCloseTo(0, 5)
  })

  it('only emits keyframes for the appearance-owned channels', () => {
    const kfs = buildAppearanceKeyframes({ in: 'riseUp', out: 'dropDown' }, 5, W, H)
    for (const ch of Object.keys(kfs)) {
      expect(APPEARANCE_CHANNELS).toContain(ch)
    }
  })

  it('pop overshoots past base by a few percent, then settles', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.5 }, 5, W, H)
    // A snap, not a bounce: a few percent past base, never the old 12%.
    const peak = Math.max(...Array.from({ length: 51 }, (_, i) => evalChannel(kfs.scale, (0.5 * i) / 50, 1)))
    expect(peak).toBeGreaterThan(1.02)
    expect(peak).toBeLessThan(1.05)
    expect(evalChannel(kfs.scale, 4, 1)).toBeCloseTo(1, 5)
  })

  it('pop matches the reference he picked, frame by frame', () => {
    // Six clean word entrances from youtube.com/shorts/dq0fNTU-Nto, 60 fps,
    // averaged, width measured off the caption's outline. See POP_FROM.
    const reference = [0.907, 0.943, 0.986, 1.023, 1.028, 1.008, 1.001]
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.1 }, 2, W, H)
    reference.forEach((want, frame) => {
      expect(Math.abs(evalChannel(kfs.scale, frame / 60, 1) - want)).toBeLessThan(0.008)
    })
  })

  it('pop never fades: the word is fully there on its first frame', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.1 }, 2, W, H)
    expect(kfs.opacity).toBeUndefined()
  })

  it('a CUT verb is no longer offered, and reads as no appearance at all', () => {
    for (const gone of ['spinIn', 'bounce']) expect(isEntranceId(gone)).toBe(false)
    expect(isExitId('spinOut')).toBe(false)
    expect(isEmptyAppearance({ in: 'spinIn' })).toBe(true)
  })

  it('id guards and emptiness', () => {
    expect(isEntranceId('pop')).toBe(true)
    expect(isEntranceId('riseUp')).toBe(true)
    expect(isEntranceId('fadeOut')).toBe(false)
    expect(isExitId('fadeOut')).toBe(true)
    expect(isExitId('nope')).toBe(false)
    expect(isEmptyAppearance(undefined)).toBe(true)
    expect(isEmptyAppearance({})).toBe(true)
    expect(isEmptyAppearance({ in: 'bogus' })).toBe(true)
    expect(isEmptyAppearance({ in: 'pop' })).toBe(false)
    expect(buildAppearanceKeyframes({}, 5, W, H)).toEqual({})
  })
})

describe('applyAppearanceToClip', () => {
  const titleClip = (): Clip => newTitleClip(defaultTitleDef('Hi'), 0, 5)

  it('writes appearance-owned keyframes and stamps the spec', () => {
    const out = applyAppearanceToClip(titleClip(), { in: 'pop' }, W, H)
    expect(out.appearance).toEqual({ in: 'pop' })
    expect(out.keyframes?.scale?.length).toBeGreaterThan(0)
    // Fully visible and a touch small on the first frame, base by the settle point.
    expect(resolveChannel(out, 'opacity', 0)).toBeCloseTo(1, 5)
    expect(resolveChannel(out, 'scale', 0)).toBeCloseTo(POP_FROM, 5)
    expect(resolveChannel(out, 'scale', 4)).toBeCloseTo(1, 5)
    // A fading entrance does write opacity.
    const faded = applyAppearanceToClip(titleClip(), { in: 'fadeIn' }, W, H)
    expect(faded.keyframes?.opacity?.length).toBeGreaterThan(0)
  })

  it('an empty spec clears the keyframes and drops the field', () => {
    const withAnim = applyAppearanceToClip(titleClip(), { in: 'pop', out: 'fadeOut' }, W, H)
    const cleared = applyAppearanceToClip(withAnim, {}, W, H)
    expect(cleared.appearance).toBeUndefined()
    expect(cleared.keyframes?.scale).toBeUndefined()
    expect(cleared.keyframes?.opacity).toBeUndefined()
  })

  it('is base-relative: re-applying after a scale change re-derives from the new base', () => {
    const base = { ...titleClip(), transform: { ...titleClip().transform, scale: 2 } }
    const out = applyAppearanceToClip(base, { in: 'pop' }, W, H)
    // pop settles to the clip's (new) base scale of 2, not neutral 1.
    expect(resolveChannel(out, 'scale', 4)).toBeCloseTo(2, 5)
  })
})

describe('preset curves settle instead of slamming', () => {
  const D = 5
  const d = 0.5
  /** |dv/dt| of a channel at t, by central difference. */
  const speedAt = (kfs: { t: number; value: number; ease?: string }[], t: number, base = 1): number => {
    const h = 1e-4
    return Math.abs(evalChannel(kfs as never, t + h, base) - evalChannel(kfs as never, t - h, base)) / (2 * h)
  }
  const peakSpeed = (kfs: { t: number; value: number }[], from: number, to: number, base = 1): number => {
    let max = 0
    for (let i = 0; i <= 100; i++) max = Math.max(max, speedAt(kfs as never, from + ((to - from) * i) / 100, base))
    return max
  }

  it('an entrance arrives at its resting size at rest, not at full speed', () => {
    // The bug this caught: a final easeIn segment made the fastest moment of the
    // whole animation the instant it stopped. Checked on every surviving verb,
    // since the one it was originally written against (bounce) has been cut.
    for (const verb of ['pop', 'zoomIn', 'slideIn', 'riseUp']) {
      const kfs = buildAppearanceKeyframes({ in: verb, durS: d }, D, W, H).scale
      if (!kfs) continue
      expect(speedAt(kfs, d - 1e-3)).toBeLessThan(0.25 * peakSpeed(kfs, 0, d))
    }
  })

  it('pop leaves its overshoot from rest, so the scale does not kink there', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: d }, D, W, H).scale!
    const peak = d * POP_PEAK_AT
    // Both sides of the turning point are slow; a kink shows up as one side fast.
    expect(speedAt(kfs, peak + 1e-3)).toBeLessThan(0.4 * peakSpeed(kfs, 0, d))
  })

  it('pop out swells to its peak at rest, then accelerates away', () => {
    const kfs = buildAppearanceKeyframes({ out: 'popOut', durS: d }, D, W, H).scale!
    const peak = D - d * 0.6
    expect(speedAt(kfs, peak - 1e-3)).toBeLessThan(speedAt(kfs, D - 1e-3))
  })

  it('every entrance still ends exactly on the base value', () => {
    for (const p of ENTRANCE_PRESETS) {
      const kfs = buildAppearanceKeyframes({ in: p.id, durS: d }, D, W, H)
      for (const ch of Object.keys(kfs) as (keyof typeof kfs)[]) {
        const base = ch === 'scale' || ch === 'opacity' ? 1 : 0
        expect(evalChannel(kfs[ch], d, base)).toBeCloseTo(base, 5)
      }
    }
  })

  it('the default window is short enough to read as an accent', () => {
    // The app's own caption/text paths use 0.13-0.20s; the default must live in
    // that world, not in the half-second motion-graphics one it came from.
    expect(DEFAULT_APPEARANCE_DUR).toBeLessThanOrEqual(0.3)
    expect(DEFAULT_APPEARANCE_DUR).toBeGreaterThanOrEqual(0.12)
  })
})

describe('retimeAppearance', () => {
  // 5s title carrying a 0.5s fade out: the window sits at [4.5, 5].
  const faded = (): Clip =>
    applyAppearanceToClip(newTitleClip(defaultTitleDef('Hi'), 0, 5), { out: 'fadeOut', durS: 0.5 }, W, H)

  it('follows a LONGER clip (the stranded-exit bug)', () => {
    const clip = faded()
    const longer: Clip = { ...clip, outS: 8 } // out edge dragged 5s -> 8s

    // Without a recompile the fade still fires at the OLD end: the title is
    // invisible for the entire 3s tail. This is the bug, asserted.
    expect(resolveChannel(longer, 'opacity', 6)).toBeCloseTo(0, 5)

    const fixed = retimeAppearance(clip, longer, W, H)
    expect(resolveChannel(fixed, 'opacity', 6)).toBeCloseTo(1, 5) // visible
    expect(resolveChannel(fixed, 'opacity', 7.5)).toBeCloseTo(1, 5) // still visible at the new window start
    expect(resolveChannel(fixed, 'opacity', 8)).toBeCloseTo(0, 5) // gone at the new end
  })

  it('follows a SHORTER clip', () => {
    const clip = faded()
    const shorter = retimeAppearance(clip, { ...clip, outS: 2 }, W, H)
    expect(resolveChannel(shorter, 'opacity', 1)).toBeCloseTo(1, 5)
    expect(resolveChannel(shorter, 'opacity', 2)).toBeCloseTo(0, 5)
  })

  it('follows an IN-edge trim, which moves local zero as well as the duration', () => {
    const clip = applyAppearanceToClip(
      newTitleClip(defaultTitleDef('Hi'), 0, 5),
      { in: 'fadeIn', out: 'fadeOut', durS: 0.5 },
      W,
      H,
    )
    // Head pulled in by 1s: startS 0 -> 1, inS 0 -> 1, duration 5 -> 4.
    const trimmed = retimeAppearance(clip, { ...clip, startS: 1, inS: 1 }, W, H)
    expect(resolveChannel(trimmed, 'opacity', 0)).toBeCloseTo(0, 5) // entrance restarts at the new head
    expect(resolveChannel(trimmed, 'opacity', 0.5)).toBeCloseTo(1, 5)
    expect(resolveChannel(trimmed, 'opacity', 2)).toBeCloseTo(1, 5)
    expect(resolveChannel(trimmed, 'opacity', 4)).toBeCloseTo(0, 5) // exit lands on the new end
  })

  it('follows a SPEED change (duration changes without either edge moving)', () => {
    const clip = faded()
    const doubled = retimeAppearance(clip, { ...clip, speed: 2 }, W, H) // 5s -> 2.5s
    expect(resolveChannel(doubled, 'opacity', 1.5)).toBeCloseTo(1, 5)
    expect(resolveChannel(doubled, 'opacity', 2.5)).toBeCloseTo(0, 5)
  })

  it('never overwrites hand-edited keyframes', () => {
    const clip = withChannelKeyframes(faded(), 'opacity', [
      { t: 0, value: 1, ease: 'linear' },
      { t: 3, value: 0.25, ease: 'linear' },
    ])
    const longer: Clip = { ...clip, outS: 8 }
    // The compiled keyframes are no longer ours, so the trim leaves them alone.
    expect(retimeAppearance(clip, longer, W, H)).toBe(longer)
  })

  it('is a no-op without an appearance, and when the duration is unchanged', () => {
    const plain = newTitleClip(defaultTitleDef('Hi'), 0, 5)
    const longer: Clip = { ...plain, outS: 8 }
    expect(retimeAppearance(plain, longer, W, H)).toBe(longer)

    const clip = faded()
    const moved: Clip = { ...clip, startS: 3 } // same length, different place
    expect(retimeAppearance(clip, moved, W, H)).toBe(moved)
  })
})

describe('splitAppearanceSpec', () => {
  it('gives the entrance to the left half and the exit to the right', () => {
    const spec = { in: 'pop', out: 'fadeOut', durS: 0.3 }
    expect(splitAppearanceSpec(spec, 'left')).toEqual({ in: 'pop', durS: 0.3 })
    expect(splitAppearanceSpec(spec, 'right')).toEqual({ out: 'fadeOut', durS: 0.3 })
  })

  it('drops the spec entirely from the half that animates nothing', () => {
    expect(splitAppearanceSpec({ out: 'fadeOut' }, 'left')).toBeUndefined()
    expect(splitAppearanceSpec({ in: 'pop' }, 'right')).toBeUndefined()
    expect(splitAppearanceSpec(undefined, 'left')).toBeUndefined()
  })
})

describe('saved pops are brought onto the new pop on load', () => {
  // What the pop compiled to until 2026-09-23, written out by hand so the test
  // does not trust the module to remember its own past.
  const legacyPop = (d: number): { scale: Keyframe[]; opacity: Keyframe[] } => ({
    scale: [
      { t: 0, value: 0.3, ease: 'easeOut' },
      { t: d * 0.6, value: 1.12, ease: 'easeInOut' },
      { t: d, value: 1, ease: 'linear' },
    ],
    opacity: [
      { t: 0, value: 0, ease: 'easeOut' },
      { t: d * 0.45, value: 1, ease: 'linear' },
    ],
  })

  /** A 5 s title carrying the OLD pop (and, optionally, the current pop out). */
  const oldPopTitle = (d: number, withOut = false): Clip => {
    let c = newTitleClip(defaultTitleDef('Hi'), 0, 5)
    const old = legacyPop(d)
    const exit = withOut ? buildAppearanceKeyframes({ out: 'popOut', durS: d }, 5, W, H) : {}
    c = withChannelKeyframes(c, 'scale', [...old.scale, ...(exit.scale ?? [])])
    c = withChannelKeyframes(c, 'opacity', [...old.opacity, ...(exit.opacity ?? [])])
    return { ...c, appearance: withOut ? { in: 'pop', out: 'popOut', durS: d } : { in: 'pop', durS: d } }
  }

  it('an untouched old caption pop becomes the new pop, with its spec kept', () => {
    const up = upgradeLegacyAppearance(oldPopTitle(0.13), W, H)
    expect(up.appearance).toEqual({ in: 'pop', durS: 0.13 })
    expect(resolveChannel(up, 'scale', 0)).toBeCloseTo(POP_FROM, 5)
    expect(resolveChannel(up, 'opacity', 0)).toBeCloseTo(1, 5)
    expect(up.keyframes?.scale).toEqual(buildAppearanceKeyframes({ in: 'pop', durS: 0.13 }, 5, W, H).scale)
  })

  it('an old pop with a pop out keeps its exit exactly', () => {
    const up = upgradeLegacyAppearance(oldPopTitle(0.16, true), W, H)
    const want = buildAppearanceKeyframes({ in: 'pop', out: 'popOut', durS: 0.16 }, 5, W, H)
    expect(up.keyframes?.scale).toEqual(want.scale)
    expect(up.keyframes?.opacity).toEqual(want.opacity)
  })

  it('a pop he tuned by hand is his, and is left alone', () => {
    const tuned = oldPopTitle(0.13)
    const scale = [...tuned.keyframes!.scale!]
    scale[1] = { ...scale[1], value: 1.2 }
    const hand = withChannelKeyframes(tuned, 'scale', scale)
    expect(upgradeLegacyAppearance(hand, W, H)).toBe(hand)
  })

  it('a clip already on the new pop is the same object', () => {
    const fresh = applyAppearanceToClip(newTitleClip(defaultTitleDef('Hi'), 0, 5), { in: 'pop', durS: 0.1 }, W, H)
    expect(upgradeLegacyAppearance(fresh, W, H)).toBe(fresh)
  })

  it('the project pass upgrades inside tracks and is free when there is nothing to do', () => {
    const p: Project = newProject()
    const seq = p.sequences[p.activeSequenceId]
    const withOld: Project = {
      ...p,
      sequences: {
        [seq.id]: { ...seq, tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [oldPopTitle(0.13)] } : t)) },
      },
    }
    const once = migrateProjectAppearance(withOld)
    expect(once).not.toBe(withOld)
    const clip = once.sequences[seq.id].tracks[0].clips[0]
    expect(resolveChannel(clip, 'scale', 0)).toBeCloseTo(POP_FROM, 5)
    // Idempotent: a second load changes nothing and allocates nothing.
    expect(migrateProjectAppearance(once)).toBe(once)
    expect(migrateProjectAppearance(p)).toBe(p)
  })
})

describe('a one-sided animation may use the whole clip (2026-09-23)', () => {
  // "why should the normal animation still be very slow just because the text
  // is long?" A speed is now the same seconds on every clip, and the half-clip
  // ceiling was the last thing tying a word's pop to its length.
  const word = (D: number, durS: number): Clip =>
    applyAppearanceToClip(newTitleClip(defaultTitleDef('Hi'), 0, D), { in: 'pop', durS }, W, H)

  it('a word caption pops at its full speed even when shorter than twice the pop', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.25 }, 0.3, W, H).scale!
    expect(kfs.at(-1)!.t).toBeCloseTo(0.25, 9)
  })

  it('with an exit as well, the half-clip ceiling still keeps the two apart', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', out: 'popOut', durS: 0.25 }, 0.3, W, H).scale!
    const entranceEnd = kfs.find((k) => Math.abs(k.value - 1) < 1e-9)!.t
    expect(entranceEnd).toBeCloseTo(0.15, 9)
  })

  it('never longer than the clip itself', () => {
    const kfs = buildAppearanceKeyframes({ in: 'pop', durS: 0.6 }, 0.2, W, H).scale!
    expect(kfs.at(-1)!.t).toBeCloseTo(0.2, 9)
  })

  it('a saved word squeezed by the old half-clip rule is given its full pop on load', () => {
    // Compiled the old way: the window was min(0.25, 0.3 / 2) = 0.15.
    const fresh = word(0.3, 0.25)
    const old = withChannelKeyframes(fresh, 'scale', buildAppearanceKeyframes({ in: 'pop', durS: 0.15 }, 0.3, W, H).scale!)
    const up = upgradeLegacyAppearance(old, W, H)
    expect(up).not.toBe(old)
    expect(up.appearance).toEqual({ in: 'pop', durS: 0.25 })
    expect(up.keyframes?.scale).toEqual(fresh.keyframes?.scale)
  })

  it('a pre-2026-09-23 pop under the half-clip rule is brought onto both changes at once', () => {
    const fresh = word(0.3, 0.25)
    let old = withChannelKeyframes(fresh, 'scale', [
      { t: 0, value: 0.3, ease: 'easeOut' },
      { t: 0.15 * 0.6, value: 1.12, ease: 'easeInOut' },
      { t: 0.15, value: 1, ease: 'linear' },
    ])
    old = withChannelKeyframes(old, 'opacity', [
      { t: 0, value: 0, ease: 'easeOut' },
      { t: 0.15 * 0.45, value: 1, ease: 'linear' },
    ])
    const up = upgradeLegacyAppearance(old, W, H)
    expect(up.keyframes?.scale).toEqual(fresh.keyframes?.scale)
    expect(resolveChannel(up, 'opacity', 0)).toBeCloseTo(1, 5)
  })

  it('a word the old rule never squeezed is the same object', () => {
    const fits = word(0.6, 0.25)
    expect(upgradeLegacyAppearance(fits, W, H)).toBe(fits)
  })

  it('a squeezed pop he reshaped by hand is his, and is left alone', () => {
    const fresh = word(0.3, 0.25)
    const scale = buildAppearanceKeyframes({ in: 'pop', durS: 0.15 }, 0.3, W, H).scale!.map((k, i) =>
      i === 1 ? { ...k, value: 1.2 } : k,
    )
    const hand = withChannelKeyframes(fresh, 'scale', scale)
    expect(upgradeLegacyAppearance(hand, W, H)).toBe(hand)
  })
})
