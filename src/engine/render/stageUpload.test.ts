import { describe, expect, it } from 'vitest'
import { NO_STAGE, stageUpload, type StageState } from './glRenderer'

// Found 2026-10-01 measuring every source shape through the real app, after his
// report that a 16:9 video "looked fine" in the app and "wrongly stretched on
// YouTube". A 1440x1080 clip with 4:3 pixels (it shows 16:9) came out of the
// EXPORT the right shape, and on the MONITOR as the picture unscaled in the left
// three quarters with black beside it: SIFT measured it 24.9% narrower, paused
// and playing. The staging upload wrote the element's 1440 stored columns into
// a stage it believed was 1920 wide and then copied that texel for texel.
//
// These pin the CPU half: when the stage may be written in place. The shader
// half (a stage of another size is sampled across the target) is proven on the
// GPU by the hidden app run, which a node test cannot reach.

// A canvas, a bitmap or an image: uploads exactly the size it reports.
const canvas = (w: number, h: number) => ({ width: w, height: h }) as unknown as TexImageSource
// A video element: reports its DISPLAY size, uploads whatever it was stored at.
const video = (w: number, h: number) => ({ videoWidth: w, videoHeight: h }) as unknown as TexImageSource

function run(steps: [TexImageSource, number, number][]): boolean[] {
  let s: StageState = NO_STAGE
  return steps.map(([src, w, h]) => {
    const plan = stageUpload(s, src, w, h)
    s = plan.next
    return plan.reuse
  })
}

describe('the staging upload writes in place only when it is safe', () => {
  it('a run of decoded frames of one size is written in place, the fast road it was built for', () => {
    expect(run([[canvas(1920, 1080), 1920, 1080], [canvas(1920, 1080), 1920, 1080], [canvas(1920, 1080), 1920, 1080]])).toEqual([
      false,
      true,
      true,
    ])
  })

  it('THE BUG: a 16:9 clip stored at 1440x1080 after a real 1920x1080 frame allocates its own stage', () => {
    // Both report 1920x1080. Before, the second was written in place into the
    // first's stage, and only its left 1440 columns changed.
    const anamorphic = video(1920, 1080)
    expect(run([[canvas(1920, 1080), 1920, 1080], [anamorphic, 1920, 1080]])).toEqual([false, false])
  })

  it('the same element frame after frame is written in place again', () => {
    const el = video(1920, 1080)
    expect(run([[el, 1920, 1080], [el, 1920, 1080], [el, 1920, 1080]])).toEqual([false, true, true])
  })

  it('a different element, or the same one at a new size, allocates', () => {
    const a = video(1920, 1080)
    const b = video(1920, 1080)
    expect(run([[a, 1920, 1080], [b, 1920, 1080], [b, 1280, 720]])).toEqual([false, false, false])
  })

  it('a canvas after an element allocates, because the element left the stage at a size nobody knows', () => {
    const el = video(1920, 1080)
    expect(run([[el, 1920, 1080], [canvas(1920, 1080), 1920, 1080], [canvas(1920, 1080), 1920, 1080]])).toEqual([
      false,
      false,
      true,
    ])
  })

  it('a WebCodecs frame is a source of unknown size too: it reports its coded size', () => {
    const frame = { displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1088 } as unknown as TexImageSource
    expect(run([[canvas(1920, 1088), 1920, 1088], [frame, 1920, 1088]])).toEqual([false, false])
  })
})
