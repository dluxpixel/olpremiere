// The Frame button, and the one thing folding controls away can break.
//
// The bar under the picture is a three-column grid whose right cell is
// `min-w-0 overflow-hidden`, and it held eleven controls. Past a certain
// inspector width it simply clipped, so controls vanished off the end with
// nothing to say they had. Four of them moved behind one labelled button on
// 2026-09-13.
//
// ⛔ AND NOTHING ELSE MOVED. His call the same day, looking at a proposal that
// rearranged the panels: *"What we have now is not inherently bad. It's just not
// the best. We can improve it. We don't have to change the entirety. The base is
// basically good."*

import { describe, expect, it } from 'vitest'
import { contentAspectKeyFor, frameSettingsActive } from './FrameSettingsMenu'
import { DEFAULT_SHUTTER_ANGLE } from '../engine/render/motionBlur'
import { activeSequence, newProject, type Sequence } from '../engine/types'

const seq = (over: Partial<Sequence> = {}): Sequence => ({ ...activeSequence(newProject()), ...over })

describe('the button says whether anything inside is on', () => {
  it('⛔ is quiet only when every setting is at its default', () => {
    // THE ONE THAT MATTERS. The whole risk of folding controls into a drawer is
    // that he cannot tell a setting is on without opening it. If this ever
    // returns false for a sequence that has an inner frame or a blurred
    // background, the drawer becomes a place where settings hide from him.
    expect(frameSettingsActive(seq(), false)).toBe(false)
  })

  it('lights for each of the four, one at a time', () => {
    expect(frameSettingsActive(seq({ contentAspect: 1 }), false)).toBe(true)
    expect(frameSettingsActive(seq({ blurBackground: true }), false)).toBe(true)
    expect(frameSettingsActive(seq(), true)).toBe(true)
  })

  it('counts motion blur being switched OFF as a change, because it defaults ON', () => {
    // Backwards from the others on purpose. A move with perfectly sharp edges is
    // the one thing that reads as made by a computer, so the default is the film
    // standard and the notable state is somebody having turned it off.
    expect(frameSettingsActive(seq({ shutterAngle: 0 }), false)).toBe(true)
    expect(frameSettingsActive(seq({ shutterAngle: DEFAULT_SHUTTER_ANGLE }), false)).toBe(false)
    expect(frameSettingsActive(seq({ shutterAngle: undefined }), false)).toBe(false)
  })
})

describe('the inner frame reads back as what it is', () => {
  it('⛔ never shows "Fill the frame" over a frame that is not filled', () => {
    // A set ratio reading back as 'full' would show him the wrong thing in the
    // control that tells him what he is exporting, and the next thing he touched
    // in the row would have thrown his ratio away.
    expect(contentAspectKeyFor(seq({ contentAspect: 1 }), false)).toBe('1:1')
    expect(contentAspectKeyFor(seq({ contentAspect: 0.8 }), false)).toBe('4:5')
    expect(contentAspectKeyFor(seq({ contentAspect: 1.234 }), false)).toBe('__customContent')
  })

  it('is "full" only when nothing is set', () => {
    expect(contentAspectKeyFor(seq(), false)).toBe('full')
  })

  it('treats Custom as a MODE, so picking it while a preset is set still opens the field', () => {
    // Derived purely from the value, picking "Custom..." on a 1:1 sequence did
    // nothing at all: 1:1 is still 1:1, so the entry snapped straight back and
    // the field never appeared.
    expect(contentAspectKeyFor(seq({ contentAspect: 1 }), true)).toBe('__customContent')
    expect(contentAspectKeyFor(seq(), true)).toBe('__customContent')
  })
})
