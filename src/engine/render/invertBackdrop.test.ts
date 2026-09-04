// The inverted-backdrop title, end to end through the parts that can be tested
// without a GPU.
//
// His ask, 2026-08-31, from a reel he sent. The frames were pulled and read at 3x
// before any of this was written: over a tan shirt the word comes out pale blue,
// over a silver chain it shows the chain with its brightness flipped. It is
// `255 - backdrop` clipped to the glyphs, not a colour and not a gradient.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveFrame } from './resolve'
import { defaultTitleDef, newTitleClip, newProject, activeSequence, type Sequence } from '../types'
import type { RenderLayer } from './types'
import { recomputeDuration } from '../timeline'

function seqWithTitle(invert: boolean): Sequence {
  const clip = newTitleClip({ ...defaultTitleDef('WORD'), ...(invert ? { invertBackdrop: true } : {}) }, 0, 4)
  const p = newProject()
  const seq = activeSequence(p)
  return recomputeDuration({
    ...seq,
    tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)),
  })
}

/**
 * The one layer a single-clip sequence resolves to.
 *
 * RenderOp is a union and the transition arm has no `layer`, so the narrowing
 * is real work rather than ceremony: it also asserts that a lone title did not
 * somehow resolve to a transition.
 */
function soleLayer(seq: Sequence, t: number): RenderLayer {
  const ops = resolveFrame(seq, t).ops
  expect(ops).toHaveLength(1)
  const op = ops[0]
  if (op.type !== 'layer') throw new Error(`expected a layer op, got ${op.type}`)
  return op.layer
}

describe('the invert is decided once, in the pure resolver', () => {
  it('promotes an inverted title to the invert blend mode', () => {
    expect(soleLayer(seqWithTitle(true), 1).blendMode).toBe('invert')
  })

  it('leaves an ordinary title exactly as it was', () => {
    expect(soleLayer(seqWithTitle(false), 1).blendMode).toBe('normal')
  })

  it('overrides the clip blend rather than writing to it', () => {
    // The Inspector's blend dropdown must still show what he set: the promotion
    // happens at resolve time and nothing writes clip.blendMode.
    const seq = seqWithTitle(true)
    const withBlend = {
      ...seq,
      tracks: seq.tracks.map((t, i) =>
        i === 0 ? { ...t, clips: t.clips.map((c) => ({ ...c, blendMode: 'multiply' as const })) } : t,
      ),
    }
    expect(soleLayer(withBlend, 1).blendMode).toBe('invert')
    expect(withBlend.tracks[0].clips[0].blendMode).toBe('multiply')
  })

  it('is decided in ONE place, so preview and export cannot disagree', () => {
    const src = readFileSync(fileURLToPath(new URL('./resolve.ts', import.meta.url)), 'utf8')
    expect(src.match(/invertBackdrop/g) ?? []).toHaveLength(1)
  })
})

describe('the renderer', () => {
  const gl = readFileSync(fileURLToPath(new URL('./glRenderer.ts', import.meta.url)), 'utf8')

  it('sends mode 2 for invert, not soft light', () => {
    // ⛔ THE ONE LINE THAT MISCOMPILES IN SILENCE. Left as `? 0 : 1` every
    // inverted title renders as SOFT LIGHT, in preview and export alike, with no
    // type error, no runtime error, and nothing in the golden e2e to catch it.
    // So this asserts the NUMBER, not merely that something changed.
    expect(gl).toContain("mode === 'overlay' ? 0 : mode === 'softLight' ? 1 : 2")
  })

  it('reads the destination for invert, like the other two dest-sampling modes', () => {
    expect(gl).toContain("mode === 'overlay' || mode === 'softLight' || mode === 'invert'")
  })

  it('computes one minus the backdrop and ignores the source colour', () => {
    // `s` must not appear in the invert branch: the raster is a coverage stencil
    // and only its ALPHA may reach the frame, or the edges fringe.
    const branch = gl.slice(gl.indexOf('} else {', gl.indexOf('uMode == 1')), gl.indexOf('vec3 outRgb'))
    expect(branch).toContain('b = vec3(1.0) - d;')
    expect(branch).not.toMatch(/\bb\s*=\s*[^;]*\bs\b/)
  })
})

describe('the rasterizer draws a stencil, not a picture', () => {
  const src = readFileSync(fileURLToPath(new URL('./titleRaster.ts', import.meta.url)), 'utf8')

  it('suppresses every decoration that writes alpha', () => {
    // Shadow, outline and box are ALPHA, and the invert keys on alpha, so an
    // inverted shadow is a halo of inverse-backdrop around every letter.
    expect(src).toContain('if (def.box && !def.invertBackdrop)')
    expect(src).toContain('if (def.shadow && !def.invertBackdrop)')
    expect(src).toContain('!def.invertBackdrop && def.outline')
  })

  it('fills white, which is the graceful value if a transition flattens the blend', () => {
    const branch = src.slice(src.indexOf('if (hasText && def.invertBackdrop)'))
    expect(branch.slice(0, 1400)).toContain('#ffffff')
  })

  it('does not grow the click target for decorations it never draws', () => {
    const measure = src.slice(src.indexOf('const grow ='), src.indexOf('const grow =') + 300)
    expect(measure).toContain('!def.invertBackdrop')
  })
})
