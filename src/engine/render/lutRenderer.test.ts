// What the renderer does for a LUT effect, against a recording stand-in for
// WebGL2 (there is no GPU under vitest): the shader declares a 3D sampler for
// it, the table is uploaded once as an RGB32F 3D texture and bound to its own
// unit, a table that is not there binds a dummy and draws as a pass through, and
// a stack with no LUT compiles exactly the text it always did.
//
// The pixels themselves, on a real GPU, are proven by e2e/lut.spec.ts. The index
// maths of the shader is pinned against the CPU twin in effects/lutShader.test.ts.

import { afterEach, describe, expect, it } from 'vitest'
import { identityCube } from '../effects/cube'
import { clearLutBank, registerCube } from '../effects/lutBank'
import { resolveStack } from '../effects/registry'
import { defaultTransform, type EffectInstance } from '../types'
import { createRenderer } from './glRenderer'
import type { RenderFrame, RenderLayer } from './types'

const C = {
  FRAGMENT_SHADER: 0x8b30,
  FRAMEBUFFER: 0x8d40,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  TEXTURE0: 0x84c0,
  TEXTURE_3D: 0x806f,
  TEXTURE_2D: 0x0de1,
} as const

interface Tex {
  id: number
}

interface Upload {
  unit: number
  w: number
  h: number
  d: number
  format: number
  data: Float32Array | null
}

interface Draw {
  fs: string
  uniforms: Record<string, number | number[]>
  /** The 3D texture on each unit at the moment of the draw. */
  bound3D: Record<number, Tex | null>
}

interface Recording {
  gl: WebGL2RenderingContext
  uploads3D: Upload[]
  draws: Draw[]
  deleted: Tex[]
  /** The unit that is active now. */
  active: () => number
}

function recordingGl(): Recording {
  const rec = {
    gl: null as unknown as WebGL2RenderingContext,
    uploads3D: [] as Upload[],
    draws: [] as Draw[],
    deleted: [] as Tex[],
    active: () => unit,
  }
  let unit = 0
  let nextTex = 1
  const bound = new Map<string, Tex | null>() // `${unit}:${target}` -> texture
  let current: { fs: string } | null = null
  const uniforms = new Map<object, Record<string, number | number[]>>()
  const set = (loc: { prog: object; name: string } | null, v: number | number[]): void => {
    if (!loc) return
    const s = uniforms.get(loc.prog) ?? {}
    s[loc.name] = v
    uniforms.set(loc.prog, s)
  }
  let nextConst = 0x10000
  const consts = new Map<string, number>(Object.entries(C))
  type Loc = { prog: object; name: string } | null
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
    attachShader: (p: { fs: string }, sh: { type: number; src: string }) => {
      if (sh.type === C.FRAGMENT_SHADER) p.fs = sh.src
    },
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: (prog: object, name: string) => ({ prog, name }),
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    isContextLost: () => false,
    useProgram: (p: { fs: string } | null) => {
      current = p
    },
    createTexture: (): Tex => ({ id: nextTex++ }),
    deleteTexture: (t: Tex | null) => {
      if (t) rec.deleted.push(t)
    },
    activeTexture: (u: number) => {
      unit = u - C.TEXTURE0
    },
    bindTexture: (target: number, t: Tex | null) => {
      bound.set(`${unit}:${target}`, t)
    },
    texImage3D: (
      _target: number,
      _level: number,
      _internal: number,
      w: number,
      h: number,
      d: number,
      _border: number,
      format: number,
      _type: number,
      data: Float32Array | null,
    ) => {
      rec.uploads3D.push({ unit, w, h, d, format, data })
    },
    uniform1f: (loc: Loc, v: number) => set(loc, v),
    uniform1i: (loc: Loc, v: number) => set(loc, v),
    uniform2f: (loc: Loc, x: number, y: number) => set(loc, [x, y]),
    uniform3f: (loc: Loc, x: number, y: number, z: number) => set(loc, [x, y, z]),
    drawArrays: () => {
      const b: Record<number, Tex | null> = {}
      for (const [k, t] of bound) {
        const [u, target] = k.split(':').map(Number)
        if (target === C.TEXTURE_3D) b[u] = t
      }
      rec.draws.push({ fs: current?.fs ?? '', uniforms: { ...(current ? uniforms.get(current) : {}) }, bound3D: b })
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

const lutFx = (lut: string, amount = 1, id = `fx_${lut}`): EffectInstance => ({
  id,
  type: 'lut',
  enabled: true,
  params: { amount },
  lut,
})

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

/** Draw one frame of this stack and hand back what the GL saw. */
function drawStack(effects: EffectInstance[], rec = recordingGl()) {
  const renderer = createRenderer(rec.gl)
  renderer.render(frameOf(layer(effects)), () => source)
  return { rec, renderer }
}

const lutDraws = (rec: Recording): Draw[] => rec.draws.filter((d) => d.fs.includes('sampler3D'))

afterEach(() => clearLutBank())

describe('the renderer and a LUT effect', () => {
  it('compiles a 3D sampler, the table info and the domain into the layer shader', () => {
    registerCube('lut_a', identityCube('3d', 5))
    const { rec } = drawStack([lutFx('lut_a')])
    const fs = lutDraws(rec)[0]?.fs ?? ''
    expect(fs).toContain('uniform highp sampler3D u_fx0_lut;')
    expect(fs).toContain('uniform vec2 u_fx0_lutInfo;')
    expect(fs).toContain('uniform vec3 u_fx0_lutMin;')
    expect(fs).toContain('uniform vec3 u_fx0_lutMax;')
    expect(fs).toContain('olpLut(u_fx0_lut, u_fx0_lutInfo, u_fx0_lutMin, u_fx0_lutMax, c)')
  })

  it('a stack with no LUT compiles none of it', () => {
    const { rec } = drawStack([{ id: 'e', type: 'exposure', enabled: true, params: { exposure: 0.5 } }])
    for (const d of rec.draws) {
      expect(d.fs).not.toContain('sampler3D')
      expect(d.fs).not.toContain('olpLut')
    }
    expect(rec.uploads3D).toHaveLength(0)
  })

  it('uploads a 3D table once, as RGB32F texels, and binds it to unit 4', () => {
    const cube = identityCube('3d', 5)
    registerCube('lut_a', cube)
    const { rec, renderer } = drawStack([lutFx('lut_a')])
    expect(rec.uploads3D).toHaveLength(1)
    const up = rec.uploads3D[0]
    expect([up.w, up.h, up.d]).toEqual([5, 5, 5])
    expect(up.format).toBe((rec.gl as unknown as Record<string, number>).RGB)
    expect(Array.from(up.data ?? [])).toEqual(Array.from(cube.data))
    const draw = lutDraws(rec)[0]
    expect(draw.uniforms.u_fx0_lut).toBe(4)
    expect(draw.bound3D[4]).toBeTruthy()
    expect(draw.uniforms.u_fx0_lutInfo).toEqual([2, 5])
    expect(draw.uniforms.u_fx0_lutMin).toEqual([0, 0, 0])
    expect(draw.uniforms.u_fx0_lutMax).toEqual([1, 1, 1])
    expect(draw.uniforms.u_fx0_amount).toBe(1)

    // A second frame reads the table it already holds.
    renderer.render(frameOf(layer([lutFx('lut_a')])), () => source)
    expect(rec.uploads3D).toHaveLength(1)
    expect(lutDraws(rec)).toHaveLength(2)
  })

  it('folds a 1D table into rows and says it is 1D', () => {
    registerCube('lut_1', identityCube('1d', 300))
    const { rec } = drawStack([lutFx('lut_1')])
    const up = rec.uploads3D[0]
    expect([up.w, up.h, up.d]).toEqual([256, 2, 1])
    expect(lutDraws(rec)[0].uniforms.u_fx0_lutInfo).toEqual([1, 300])
  })

  it('hands the shader the table\'s own input range', () => {
    const cube = { ...identityCube('3d', 3), domainMin: [0.1, 0.2, 0.3] as [number, number, number], domainMax: [0.9, 0.8, 0.7] as [number, number, number] }
    registerCube('lut_d', cube)
    const { rec } = drawStack([lutFx('lut_d')])
    const u = lutDraws(rec)[0].uniforms
    expect((u.u_fx0_lutMin as number[]).map((n) => Math.fround(n))).toEqual([0.1, 0.2, 0.3].map(Math.fround))
    expect((u.u_fx0_lutMax as number[]).map((n) => Math.fround(n))).toEqual([0.9, 0.8, 0.7].map(Math.fround))
  })

  it('a table the bank does not hold binds the 1x1 dummy and tells the shader there is none', () => {
    const { rec } = drawStack([lutFx('lut_missing')])
    const draw = lutDraws(rec)[0]
    expect(draw.uniforms.u_fx0_lutInfo).toEqual([0, 0])
    expect(rec.uploads3D).toHaveLength(1)
    expect([rec.uploads3D[0].w, rec.uploads3D[0].h, rec.uploads3D[0].d]).toEqual([1, 1, 1])
    expect(draw.bound3D[4]).toBeTruthy()
  })

  it('a table that arrives later uploads on the next frame', () => {
    const { rec, renderer } = drawStack([lutFx('lut_late')])
    expect(lutDraws(rec)[0].uniforms.u_fx0_lutInfo).toEqual([0, 0])
    registerCube('lut_late', identityCube('3d', 4))
    renderer.render(frameOf(layer([lutFx('lut_late')])), () => source)
    expect(lutDraws(rec)[1].uniforms.u_fx0_lutInfo).toEqual([2, 4])
    expect(rec.uploads3D.at(-1)?.w).toBe(4)
  })

  it('Amount 0 leaves the effect out: no program, no table, no upload', () => {
    registerCube('lut_a', identityCube('3d', 5))
    const { rec } = drawStack([lutFx('lut_a', 0)])
    expect(lutDraws(rec)).toHaveLength(0)
    expect(rec.uploads3D).toHaveLength(0)
  })

  it('two LUTs on one clip each get a unit of their own', () => {
    registerCube('lut_a', identityCube('3d', 3))
    registerCube('lut_b', identityCube('3d', 4))
    const { rec } = drawStack([lutFx('lut_a', 1, 'fx_a'), lutFx('lut_b', 0.5, 'fx_b')])
    const draw = lutDraws(rec)[0]
    expect(draw.uniforms.u_fx0_lut).toBe(4)
    expect(draw.uniforms.u_fx1_lut).toBe(5)
    expect(draw.bound3D[4]).not.toBe(draw.bound3D[5])
    expect(draw.uniforms.u_fx0_lutInfo).toEqual([2, 3])
    expect(draw.uniforms.u_fx1_lutInfo).toEqual([2, 4])
    // The shader holds the lookup function once, not once per LUT.
    expect(draw.fs.split('vec3 olpLut(').length - 1).toBe(1)
  })

  it('leaves texture unit 0 active, where the rest of the renderer expects it', () => {
    registerCube('lut_a', identityCube('3d', 3))
    const { rec } = drawStack([lutFx('lut_a')])
    expect(rec.active()).toBe(0)
  })

  it('frees its tables when it is disposed', () => {
    registerCube('lut_a', identityCube('3d', 3))
    const { rec, renderer } = drawStack([lutFx('lut_a')])
    const held = lutDraws(rec)[0].bound3D[4]
    renderer.dispose()
    expect(rec.deleted).toContain(held)
  })
})
