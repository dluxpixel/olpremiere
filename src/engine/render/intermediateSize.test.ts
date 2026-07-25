import { describe, expect, it } from 'vitest'
import { intermediateSize } from './glRenderer'

// The buffers a transition, a blur, an overlay blend or an adjustment layer is
// drawn into were pinned to the SEQUENCE raster, so on an upscaled export every
// one of them was rendered small and blown up — the picture softened for the
// length of each transition and snapped back after it.
describe('intermediate buffers follow the biggest of sequence and target', () => {
  it('matches the OUTPUT when the export is bigger than the timeline', () => {
    // The one-button export raises an HD timeline to 1440p, so this is now the
    // default path for every 1080p project.
    expect(intermediateSize(1920, 1080, 2560, 1440)).toEqual({ width: 2560, height: 1440 })
    expect(intermediateSize(1080, 1920, 1440, 2560)).toEqual({ width: 1440, height: 2560 })
  })

  it('does not move when the target IS the sequence — the SD golden cannot shift', () => {
    expect(intermediateSize(640, 360, 640, 360)).toEqual({ width: 640, height: 360 })
    expect(intermediateSize(1920, 1080, 1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('does not shrink below the sequence when the target is smaller (the preview)', () => {
    // A small preview canvas must not quietly reduce the quality of a
    // transition relative to what it shows for an ordinary layer.
    expect(intermediateSize(1920, 1080, 640, 360)).toEqual({ width: 1920, height: 1080 })
  })

  it('never returns a zero dimension', () => {
    expect(intermediateSize(0, 0, 0, 0)).toEqual({ width: 1, height: 1 })
  })
})
