// A look's own passes (the bright pass and glow combine of its halation and
// bloom, and its clarity) against a recording stand-in for WebGL2, since there is
// no GPU under vitest.
//
// They used to link with the renderer itself. So every preview and every export
// paid three blocking links for a project with no look in it, and a driver that
// refused any one of them made createRenderer throw: no preview and no export at
// all, for projects that never touch a look. These hold the renderer to building
// a pass only when a look needs it, and to losing only that pass when it fails.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStack } from '../effects/registry'
import { layerShapesOf } from '../preview'
import { defaultTransform, newAdjustmentClip, newSequence, type Clip, type EffectInstance, type Sequence } from '../types'
import { beforeView, dropIdleAdjustments } from './beforeView'
import { createRenderer } from './glRenderer'
import type { LayerShape } from './glRenderer'
import { resolveFrame } from './resolve'
import type { RenderFrame, RenderLayer } from './types'

const C = {
  FRAGMENT_SHADER: 0x8b30,
  FRAMEBUFFER: 0x8d40,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
} as const

type PassName = 'bright' | 'glow' | 'clarity'

/** Which of a look's passes a fragment shader is, by a line only that one has. */
function passOf(fs: string): PassName | null {
  if (fs.includes('uniform float uSoftness;')) return 'bright'
  if (fs.includes('uniform float uLumaTint;')) return 'glow'
  if (fs.includes('-0.12, 0.12')) return 'clarity'
  return null
}

interface Prog {
  fs: string
  /** Whether anything asked if it linked (the blocking question warm() never asks). */
  asked: boolean
}

interface Draw {
  /** The framebuffer drawn into: null is the canvas. */
  fb: unknown
  fs: string
  uniforms: Record<string, number | number[]>
}

interface Recording {
  gl: WebGL2RenderingContext
  /** Every program created, in order. */
  programs: Prog[]
  draws: Draw[]
  /** What isContextLost() answers: a context the browser has taken away. */
  lost: boolean
}

/** A WebGL2 context that draws nothing, remembers what it was asked, and refuses to build the passes named. */
function recordingGl(broken: readonly PassName[] = []): Recording {
  const rec: Recording = { gl: null as unknown as WebGL2RenderingContext, programs: [], draws: [], lost: false }
  const fails = (src: string): boolean => {
    const pass = passOf(src)
    return pass !== null && broken.includes(pass)
  }
  let drawFb: unknown = null
  let current: Prog | null = null
  const uniforms = new Map<object, Record<string, number | number[]>>()
  const set = (loc: { prog: object; name: string } | null, v: number | number[]): void => {
    if (!loc) return
    const s = uniforms.get(loc.prog) ?? {}
    s[loc.name] = v
    uniforms.set(loc.prog, s)
  }
  let nextConst = 0x10000
  const consts = new Map<string, number>(Object.entries(C))
  const impl: Record<string, unknown> = {
    canvas: { width: 1080, height: 1920 },
    getExtension: () => null,
    createShader: (type: number) => ({ type, src: '' }),
    shaderSource: (sh: { src: string }, src: string) => {
      sh.src = src
    },
    getShaderParameter: (sh: { src: string }) => !fails(sh.src),
    getShaderInfoLog: () => 'ERROR: 0:1: this driver refuses it',
    createProgram: () => {
      const p: Prog = { fs: '', asked: false }
      rec.programs.push(p)
      return p
    },
    attachShader: (p: Prog, sh: { type: number; src: string }) => {
      if (sh.type === C.FRAGMENT_SHADER) p.fs = sh.src
    },
    getProgramParameter: (p: Prog) => {
      p.asked = true
      return !fails(p.fs)
    },
    getProgramInfoLog: () => 'link failed',
    getAttribLocation: () => 0,
    getUniformLocation: (prog: object, name: string) => ({ prog, name }),
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    isContextLost: () => rec.lost,
    useProgram: (p: Prog | null) => {
      current = p
    },
    uniform1f: (loc: { prog: object; name: string } | null, v: number) => set(loc, v),
    uniform2f: (loc: { prog: object; name: string } | null, x: number, y: number) => set(loc, [x, y]),
    bindFramebuffer: (target: number, fb: unknown) => {
      if (target === C.FRAMEBUFFER || target === C.DRAW_FRAMEBUFFER) drawFb = fb
    },
    drawArrays: () => {
      rec.draws.push({ fb: drawFb, fs: current?.fs ?? '', uniforms: { ...(current ? uniforms.get(current) : {}) } })
    },
  }
  rec.gl = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in target) return target[prop]
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
        if (!consts.has(prop)) consts.set(prop, nextConst++)
        return consts.get(prop)
      }
      // Every other call creates a handle or does nothing; both are fine here.
      return () => (prop.startsWith('create') ? { kind: prop } : undefined)
    },
  }) as unknown as WebGL2RenderingContext
  return rec
}

const look = (type: string, amount = 1): EffectInstance => ({ id: `fx_${type}`, type, enabled: true, params: { amount } })

/** One full frame layer of footage carrying this stack, resolved the way preview and export resolve it. */
const layer = (effects: EffectInstance[]): RenderLayer => ({
  clipId: 'c1',
  assetId: 'a1',
  sourceTimeS: 0,
  isImage: false,
  speed: 1,
  frameSeed: 7,
  transform: { ...defaultTransform(), cropT: 0, cropR: 0, cropB: 0, cropL: 0 },
  opacity: 1,
  blendMode: 'normal',
  effects: resolveStack(effects, 0),
})

const frameOf = (l: RenderLayer): RenderFrame => ({ width: 1080, height: 1920, ops: [{ type: 'layer', layer: l }] })
const source = { width: 1080, height: 1920 } as unknown as TexImageSource

const passesBuilt = (rec: Recording): PassName[] =>
  rec.programs.map((p) => passOf(p.fs)).filter((p): p is PassName => p !== null)
const passesDrawn = (rec: Recording): PassName[] =>
  rec.draws.map((d) => passOf(d.fs)).filter((p): p is PassName => p !== null)
const canvasWrites = (rec: Recording): number => rec.draws.filter((d) => d.fb === null).length

/**
 * Four seconds of footage on V1 carrying `footage`, and, when given, an
 * adjustment layer over it on V2 carrying `adjustment`.
 */
function sequenceOf(footage: EffectInstance[], adjustment?: EffectInstance[]): Sequence {
  const sq = newSequence()
  const [v1, v2] = sq.tracks.filter((t) => t.kind === 'video')
  const clip: Clip = { ...newAdjustmentClip(0, 4), adjustment: undefined, assetId: 'a1', effects: footage }
  const over: Clip[] = adjustment ? [{ ...newAdjustmentClip(0, 4), effects: adjustment }] : []
  return {
    ...sq,
    durationS: 4,
    tracks: sq.tracks.map((t) => (t.id === v1!.id ? { ...t, clips: [clip] } : t.id === v2!.id ? { ...t, clips: over } : t)),
  }
}

/** Programs started in the background and never asked whether they linked. */
const startedOnly = (rec: Recording, fsHas: (fs: string) => boolean): Prog[] =>
  rec.programs.filter((p) => fsHas(p.fs) && !p.asked)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a look's own passes are built only when a look needs them", () => {
  it('builds none of them for a project with no look, at startup or on any frame', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    expect(passesBuilt(rec)).toEqual([])
    renderer.render(frameOf(layer([])), () => source)
    renderer.render(frameOf(layer([{ id: 's', type: 'saturation', enabled: true, params: { saturation: 0.3 } }])), () => source)
    expect(passesBuilt(rec)).toEqual([])
    expect(canvasWrites(rec)).toBe(2)
    renderer.dispose()
  })

  it('builds a pass on the first frame that needs it, once, and draws it', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    expect(passesBuilt(rec).sort()).toEqual(['bright', 'glow'])
    // Halation then bloom, each a bright pass and a combine, on both frames.
    expect(passesDrawn(rec)).toEqual(['bright', 'glow', 'bright', 'glow', 'bright', 'glow', 'bright', 'glow'])
    renderer.render(frameOf(layer([look('lookMoodyGym')])), () => source)
    expect(passesBuilt(rec).sort()).toEqual(['bright', 'clarity', 'glow'])
    renderer.dispose()
  })

  it('starts a pass in the background when warm() sees a look that needs it, and the first frame uses that one', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    const shape: LayerShape = { effects: layer([look('lookMoodyGym')]).effects, mask: false }
    renderer.warm([{ effects: layer([]).effects, mask: false }])
    expect(passesBuilt(rec)).toEqual([])
    renderer.warm([shape])
    const started = rec.programs.filter((p) => passOf(p.fs) === 'clarity')
    expect(started).toHaveLength(1)
    // Started, never waited on: asking whether it linked is what blocks.
    expect(started[0].asked).toBe(false)
    renderer.render(frameOf(layer([look('lookMoodyGym')])), () => source)
    expect(rec.programs.filter((p) => passOf(p.fs) === 'clarity')).toHaveLength(1)
    expect(passesDrawn(rec)).toEqual(['clarity'])
    renderer.dispose()
  })

  // warm() reads one frame in the middle of every clip. A look keyframed to fade
  // in after that frame is at Amount 0 there and has no passes, so a pass was
  // only linked on the first frame that had one: a hitch in the middle of playback.
  it('starts the passes of a look keyframed to fade in after the middle of its clip', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    const lateFade: EffectInstance = {
      id: 'fx_late',
      type: 'lookFilm800T',
      enabled: true,
      params: { amount: { value: 0, keyframes: [{ t: 3, value: 0, ease: 'linear' }, { t: 4, value: 1, ease: 'linear' }] } },
    }
    const seq = sequenceOf([lateFade])
    // In the middle of the clip the look has no passes at all.
    expect(resolveStack([lateFade], 2).map((e) => e.type)).toEqual(['lookFilm800T'])
    renderer.warm(layerShapesOf(seq))
    expect(passesBuilt(rec).sort()).toEqual(['bright', 'glow'])
    expect(startedOnly(rec, (fs) => passOf(fs) !== null)).toHaveLength(2)
    // The frame that first has them uses the ones started, and builds no other.
    renderer.render(resolveFrame(seq, 3.9), () => source)
    expect(passesBuilt(rec).sort()).toEqual(['bright', 'glow'])
    expect(passesDrawn(rec)).toContain('glow')
    renderer.dispose()
  })

  it('starts the passes, and the colour program, of a look on an adjustment layer', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    const seq = sequenceOf([], [look('lookMoodyGym')])
    renderer.warm(layerShapesOf(seq))
    expect(passesBuilt(rec)).toEqual(['clarity'])
    expect(startedOnly(rec, (fs) => passOf(fs) === 'clarity')).toHaveLength(1)
    expect(startedOnly(rec, (fs) => fs.includes('olkCurve_moodyGym')).length).toBeGreaterThan(0)
    // The frame uses what was started, and builds no second copy of either.
    const colourBefore = rec.programs.filter((p) => p.fs.includes('olkCurve_moodyGym')).length
    renderer.render(resolveFrame(seq, 2), () => source)
    expect(passesBuilt(rec)).toEqual(['clarity'])
    expect(rec.programs.filter((p) => p.fs.includes('olkCurve_moodyGym'))).toHaveLength(colourBefore)
    expect(passesDrawn(rec)).toEqual(['clarity'])
    renderer.dispose()
  })
})

// Clarity sharpened a grain laid down before it (lookMath.ts, grainAfterClarity),
// so a look with clarity lays its grain down in its clarity pass, after the detail.
describe('the grain of a look with clarity', () => {
  it('is drawn by the clarity pass after the detail, at the frame the colour pass would have used, and not by the colour pass', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    renderer.render(frameOf(layer([look('lookMoodyGym', 0.5)])), () => source)
    const colour = rec.draws.find((d) => d.fs.includes('olkCurve_moodyGym'))!
    expect(colour.fs).not.toContain('olkGrain(vSeqPos')
    const clarity = rec.draws.find((d) => passOf(d.fs) === 'clarity')!
    expect(clarity.uniforms.uAmount).toBeCloseTo(0.175, 6)
    expect(clarity.uniforms.uGrain).toBeCloseTo(0.035, 6)
    expect(clarity.uniforms.uGrainSize).toBe(1.6)
    expect(clarity.uniforms.uSeed).toBe(7)
    expect(clarity.uniforms.uFrame).toEqual([1080, 1920])
    // In the shader the grain comes after the detail (the first olkGrain is the helper's own definition).
    expect(clarity.fs.lastIndexOf('olkGrain(')).toBeGreaterThan(clarity.fs.indexOf('d * uAmount'))
    renderer.dispose()
  })

  it('takes an adjustment layer\'s own frame, as its colour pass does', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    const frame: RenderFrame = {
      width: 1080,
      height: 1920,
      ops: [
        { type: 'layer', layer: layer([]) },
        { type: 'adjustment', effects: resolveStack([look('lookGritty')], 0), opacity: 1, frameSeed: 11 },
      ],
    }
    renderer.render(frame, () => source)
    const clarity = rec.draws.find((d) => passOf(d.fs) === 'clarity')!
    expect(clarity.uniforms.uSeed).toBe(11)
    expect(clarity.uniforms.uGrain).toBeCloseTo(0.16, 6)
    renderer.dispose()
  })

  it('stays in the colour pass of a look without clarity, where nothing after it reads neighbours', () => {
    const rec = recordingGl()
    const renderer = createRenderer(rec.gl)
    renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    expect(rec.draws.find((d) => d.fs.includes('olkCurve_film800T'))!.fs).toContain('olkGrain(vSeqPos')
    renderer.dispose()
  })
})

describe('a look pass this GPU will not build', () => {
  it('never stops the renderer starting, or a project with no look from drawing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rec = recordingGl(['bright', 'glow', 'clarity'])
    const renderer = createRenderer(rec.gl)
    renderer.render(frameOf(layer([])), () => source)
    expect(canvasWrites(rec)).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    renderer.dispose()
  })

  it('loses only that pass, says so once, and the look still draws its colour on every frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rec = recordingGl(['glow'])
    const renderer = createRenderer(rec.gl)
    // Warmed first, so the failure is found the background way as well.
    renderer.warm([{ effects: layer([look('lookFilm800T')]).effects, mask: false }])
    for (let i = 0; i < 3; i++) renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    expect(canvasWrites(rec)).toBe(3)
    expect(passesDrawn(rec)).toEqual([])
    // The look's colour pass is the layer program, and it drew on all three frames.
    expect(rec.draws.filter((d) => d.fs.includes('olkCurve_film800T'))).toHaveLength(3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('glow')
    // A look whose passes DID build keeps them.
    renderer.render(frameOf(layer([look('lookMoodyGym')])), () => source)
    expect(passesDrawn(rec)).toEqual(['clarity'])
    expect(warn).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })

  // On a context that is lost but not reported yet, every build fails. That is
  // the loss, not this GPU refusing the pass, so it is neither said nor kept.
  it('is not what a lost context is: no warning, and nothing kept as failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken: PassName[] = ['bright', 'glow']
    const rec = recordingGl(broken)
    const renderer = createRenderer(rec.gl)
    rec.lost = true
    renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    expect(warn).not.toHaveBeenCalled()
    expect(passesDrawn(rec)).toEqual([])
    // Back, the pass builds and draws: the loss was never taken for a failure.
    rec.lost = false
    broken.length = 0
    renderer.render(frameOf(layer([look('lookFilm800T')])), () => source)
    expect(passesDrawn(rec)).toEqual(['bright', 'glow', 'bright', 'glow'])
    expect(warn).not.toHaveBeenCalled()
    renderer.dispose()
  })
})

// The Before picture (render/beforeView.ts): the same footage through no effect passes at all.
describe('the Before picture', () => {
  const colour = (rec: Recording) => rec.draws.filter((d) => d.fs.includes('olkCurve_film800T'))

  it('draws the footage plain, with no look colour and no bright or glow pass, where the real frame has them', () => {
    const seq = sequenceOf([look('lookFilm800T')])

    const real = recordingGl()
    const realRenderer = createRenderer(real.gl)
    realRenderer.render(resolveFrame(seq, 1), () => source)
    expect(colour(real).length).toBeGreaterThan(0)
    expect(passesDrawn(real)).toEqual(['bright', 'glow', 'bright', 'glow'])
    realRenderer.dispose()

    const plain = recordingGl()
    const plainRenderer = createRenderer(plain.gl)
    plainRenderer.render(dropIdleAdjustments(resolveFrame(beforeView(seq, 'all'), 1)), () => source)
    expect(colour(plain)).toHaveLength(0)
    expect(passesDrawn(plain)).toEqual([])
    expect(canvasWrites(plain)).toBe(1)
    plainRenderer.dispose()
  })

  it('draws an adjustment layer carrying a look as nothing at all', () => {
    const seq = sequenceOf([], [look('lookMoodyGym')])
    const plain = recordingGl()
    const renderer = createRenderer(plain.gl)
    renderer.render(dropIdleAdjustments(resolveFrame(beforeView(seq, 'all'), 1)), () => source)
    expect(plain.draws.filter((d) => d.fs.includes('olkCurve_moodyGym'))).toHaveLength(0)
    expect(passesDrawn(plain)).toEqual([])
    renderer.dispose()
  })
})
