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
import { defaultTransform, type EffectInstance } from '../types'
import { createRenderer } from './glRenderer'
import type { LayerShape } from './glRenderer'
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
}

/** A WebGL2 context that draws nothing, remembers what it was asked, and refuses to build the passes named. */
function recordingGl(broken: readonly PassName[] = []): Recording {
  const rec: Recording = { gl: null as unknown as WebGL2RenderingContext, programs: [], draws: [] }
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
    isContextLost: () => false,
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
})
