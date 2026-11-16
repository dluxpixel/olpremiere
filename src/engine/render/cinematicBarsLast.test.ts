// Cinematic Bars must be the LAST thing on a clip's layer. They used to run in the
// pointwise chain, ahead of every neighborhood pass, so RGB Split put red and blue
// fringes on the bar edges and a blur turned them soft grey (Gym edits use exactly
// that pair). Asserted against a recording stand-in for WebGL2, since there is no
// GPU under vitest: which programs draw, in what order, and into which framebuffer.

import { describe, expect, it } from 'vitest'
import { cinematicBarsKeepGlsl, getEffect, resolveStack } from '../effects/registry'
import { defaultTransform, type EffectInstance } from '../types'
import { createRenderer } from './glRenderer'
import type { RenderFrame, RenderLayer } from './types'

const C = {
  FRAGMENT_SHADER: 0x8b30,
  FRAMEBUFFER: 0x8d40,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
} as const

interface Prog {
  fs: string
}

interface Draw {
  /** The framebuffer drawn into: null is the canvas. */
  fb: unknown
  fs: string
  uniforms: Record<string, number | number[]>
  /** Blend factors in force: colour source, colour dest, alpha source, alpha dest. */
  blend: number[]
}

interface Recording {
  gl: WebGL2RenderingContext
  draws: Draw[]
}

function recordingGl(): Recording {
  const rec: Recording = { gl: null as unknown as WebGL2RenderingContext, draws: [] }
  let drawFb: unknown = null
  let current: Prog | null = null
  let blend: number[] = []
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
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({ fs: '' }),
    attachShader: (p: Prog, sh: { type: number; src: string }) => {
      if (sh.type === C.FRAGMENT_SHADER) p.fs = sh.src
    },
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: (prog: object, name: string) => ({ prog, name }),
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    isContextLost: () => false,
    useProgram: (p: Prog | null) => {
      current = p
    },
    uniform1f: (loc: { prog: object; name: string } | null, v: number) => set(loc, v),
    uniform2f: (loc: { prog: object; name: string } | null, x: number, y: number) => set(loc, [x, y]),
    blendFunc: (s: number, d: number) => {
      blend = [s, d, s, d]
    },
    blendFuncSeparate: (a: number, b: number, c: number, d: number) => {
      blend = [a, b, c, d]
    },
    bindFramebuffer: (target: number, fb: unknown) => {
      if (target === C.FRAMEBUFFER || target === C.DRAW_FRAMEBUFFER) drawFb = fb
    },
    drawArrays: () => {
      rec.draws.push({
        fb: drawFb,
        fs: current?.fs ?? '',
        uniforms: { ...(current ? uniforms.get(current) : {}) },
        blend: [...blend],
      })
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
      return () => (prop.startsWith('create') ? { kind: prop } : undefined)
    },
  }) as unknown as WebGL2RenderingContext
  return rec
}

const fx = (type: string, params: Record<string, number>): EffectInstance => ({ id: `fx_${type}`, type, enabled: true, params })
const bars = (size = 12): EffectInstance => fx('cinematicBars', { size })
const split = (): EffectInstance => fx('rgbSplit', { amount: 10, angleDeg: 0 })
const blur = (): EffectInstance => fx('gaussianBlur', { blur: 8 })

const layer = (effects: EffectInstance[], blendMode: RenderLayer['blendMode'] = 'normal'): RenderLayer => ({
  clipId: 'c1',
  assetId: 'a1',
  sourceTimeS: 0,
  isImage: false,
  speed: 1,
  frameSeed: 7,
  transform: { ...defaultTransform(), cropT: 0, cropR: 0, cropB: 0, cropL: 0 },
  opacity: 1,
  blendMode,
  effects: resolveStack(effects, 0),
})

const source = { width: 1080, height: 1920 } as unknown as TexImageSource

/** One full frame layer of footage carrying this stack, and every draw call it makes. */
function draw(effects: EffectInstance[], blendMode: RenderLayer['blendMode'] = 'normal'): { draws: Draw[]; gl: WebGL2RenderingContext } {
  const rec = recordingGl()
  const renderer = createRenderer(rec.gl)
  const frame: RenderFrame = { width: 1080, height: 1920, ops: [{ type: 'layer', layer: layer(effects, blendMode) }] }
  renderer.render(frame, () => source)
  renderer.dispose()
  return { draws: rec.draws, gl: rec.gl }
}

const isLayerDraw = (d: Draw): boolean => d.fs.includes('uOpacity')
const isBarsPass = (d: Draw): boolean => d.fs.includes('cbKeep') && !isLayerDraw(d)
const isSplitPass = (d: Draw): boolean => d.fs.includes('vec3(rr.r, cc.g, bb.b)')
const isBlurPass = (d: Draw): boolean => d.fs.includes('uniform vec2 uDir;') && d.fs.includes('uRadius')

describe('Cinematic Bars with a neighborhood effect on the same layer', () => {
  it("are drawn after RGB Split, in their own pass over the layer's own framebuffer, and not in the layer shader", () => {
    const { draws, gl } = draw([bars(12), split()])
    const iLayer = draws.findIndex(isLayerDraw)
    const iSplit = draws.findIndex(isSplitPass)
    const iBars = draws.findIndex(isBarsPass)
    expect(iLayer).toBeGreaterThanOrEqual(0)
    expect(iSplit).toBeGreaterThan(iLayer)
    expect(iBars).toBeGreaterThan(iSplit)
    expect(draws[iLayer].fs).not.toContain('cbKeep')
    // Over the layer's FBO, which is not the frame being built: only this layer is barred.
    expect(draws[iBars].fb).toBe(draws[iLayer].fb)
    expect(draws.slice(iBars + 1).every((d) => d.fb !== draws[iLayer].fb)).toBe(true)
    // Multiply the premultiplied colour by the bars' keep, leave alpha as it is.
    expect(draws[iBars].blend).toEqual([gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE])
    expect(draws[iBars].uniforms.uSize).toBe(12)
    expect(draws[iBars].uniforms.uFrame).toEqual([1080, 1920])
  })

  it('are drawn after a blur, however many rounds it takes', () => {
    const { draws } = draw([bars(12), blur()])
    const lastBlur = draws.map(isBlurPass).lastIndexOf(true)
    const iBars = draws.findIndex(isBarsPass)
    expect(lastBlur).toBeGreaterThanOrEqual(0)
    expect(iBars).toBeGreaterThan(lastBlur)
    expect(draws.find(isLayerDraw)!.fs).not.toContain('cbKeep')
  })

  it('are drawn after the last of several neighborhood effects, whatever order the stack is in', () => {
    const { draws } = draw([split(), bars(10), blur()])
    const iBars = draws.findIndex(isBarsPass)
    expect(iBars).toBeGreaterThan(draws.map(isSplitPass).lastIndexOf(true))
    expect(iBars).toBeGreaterThan(draws.map(isBlurPass).lastIndexOf(true))
    expect(draws.filter(isBarsPass)).toHaveLength(1)
  })

  it('draw at the exact size the layer shader draws (step(0.0001, bar)), and skip only a smaller one', () => {
    expect(0.01 / 100).toBe(0.0001)
    expect(draw([bars(0.01), split()]).draws.filter(isBarsPass)).toHaveLength(1)
    expect(draw([bars(0.005), split()]).draws.filter(isBarsPass)).toHaveLength(0)
  })

  it('size from the frame, with the same maths the layer shader uses', () => {
    const pass = draw([bars(12), split()]).draws.find(isBarsPass)!
    expect(pass.fs).toContain(cinematicBarsKeepGlsl('uSize'))
    expect(pass.fs).toContain('uniform vec2 uFrame;')
  })
})

describe('Cinematic Bars with no neighborhood effect', () => {
  it('stay in the layer shader: no extra pass, same program text', () => {
    const { draws } = draw([bars(12)])
    expect(draws.filter(isBarsPass)).toHaveLength(0)
    // The layer draw, then the one write of the frame onto the canvas.
    expect(draws).toHaveLength(2)
    const fs = draws.find(isLayerDraw)!.fs
    expect(fs).toContain(`  { // cinematicBars
${getEffect('cinematicBars')!.glsl!((k) => `u_fx0_${k}`)}
  }`)
    expect(fs).toContain('uniform float u_fx0_size;')
    expect(fs).toContain(`      float cbH = max(uFrame.y, 1.0);
      float cbY = vSeqPos.y / cbH;
      float cbBar = u_fx0_size / 100.0;
      float cbE = 0.75 / cbH;
      float cbKeep = smoothstep(cbBar - cbE, cbBar + cbE, cbY) * (1.0 - smoothstep(1.0 - cbBar - cbE, 1.0 - cbBar + cbE, cbY));
      c *= mix(1.0, cbKeep, step(0.0001, cbBar));`)
  })

  it('stay in the layer shader on a blend mode that needs the isolated framebuffer', () => {
    const { draws } = draw([bars(12)], 'overlay')
    expect(draws.filter(isBarsPass)).toHaveLength(0)
    expect(draws.find(isLayerDraw)!.fs).toContain('cbKeep')
  })
})

describe('a layer without Cinematic Bars', () => {
  it('draws RGB Split exactly as it did: layer shader, split, copy back, composite onto the frame, the frame onto the canvas, and no bars pass', () => {
    const { draws } = draw([split()])
    expect(draws.filter(isBarsPass)).toHaveLength(0)
    expect(draws.find(isLayerDraw)!.fs).not.toContain('cbKeep')
    expect(draws.map((d) => (isLayerDraw(d) ? 'layer' : isSplitPass(d) ? 'split' : 'copy'))).toEqual(['layer', 'split', 'copy', 'copy', 'copy'])
  })
})
