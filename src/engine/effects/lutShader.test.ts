// The layout of the texture a LUT uploads as, and the shader's index maths.
//
// There is no GPU under vitest, so `shaderLut` below is the GLSL of lutShader.ts
// written out again by hand in TypeScript, line for line, reading the very
// texture `lutTexture` produces through the same `texelFetch` addressing. It is
// held against `sampleCube` (the CPU twin the parser's tests already pin). A slip
// in the folding of a 1D table or in the corner order of the trilinear sum
// shows here; that the GLSL itself says the same thing is the e2e's job
// (e2e/lut.spec.ts reads real pixels off a real GPU).

import { describe, expect, it } from 'vitest'

import { identityCube, sampleCube, type ParsedCube } from './cube'
import { LUT_1D_ROW, LUT_GLSL, lutInfo, lutTexture, MAX_LUTS_PER_CLIP, type LutTexture } from './lutShader'

type V3 = [number, number, number]

const texel = (t: LutTexture, x: number, y: number, z: number): V3 => {
  const at = ((z * t.height + y) * t.width + x) * 3
  return [t.data[at], t.data[at + 1], t.data[at + 2]]
}

const mix = (a: number, b: number, w: number): number => a * (1 - w) + b * w

/** olpLut() of lutShader.ts, written out: same steps, same clamps, same texel order. */
function shaderLut(t: LutTexture, info: [number, number], lo: V3, hi: V3, c: V3): V3 {
  if (info[0] < 0.5) return c
  const n = info[1]
  const g = c.map((v, k) => Math.min(1, Math.max(0, (v - lo[k]) / (hi[k] - lo[k]))) * (n - 1)) as V3
  const f = g.map((v) => Math.min(Math.floor(v), n - 2)) as V3
  const w = g.map((v, k) => v - f[k]) as V3
  const tap1 = (k: number): V3 => texel(t, k & (LUT_1D_ROW - 1), k >> Math.log2(LUT_1D_ROW), 0)
  if (info[0] < 1.5) {
    return [
      mix(tap1(f[0])[0], tap1(f[0] + 1)[0], w[0]),
      mix(tap1(f[1])[1], tap1(f[1] + 1)[1], w[1]),
      mix(tap1(f[2])[2], tap1(f[2] + 1)[2], w[2]),
    ]
  }
  const at = (dx: number, dy: number, dz: number): V3 => texel(t, f[0] + dx, f[1] + dy, f[2] + dz)
  const lerp3 = (a: V3, b: V3, s: number): V3 => [mix(a[0], b[0], s), mix(a[1], b[1], s), mix(a[2], b[2], s)]
  const z0 = lerp3(lerp3(at(0, 0, 0), at(1, 0, 0), w[0]), lerp3(at(0, 1, 0), at(1, 1, 0), w[0]), w[1])
  const z1 = lerp3(lerp3(at(0, 0, 1), at(1, 0, 1), w[0]), lerp3(at(0, 1, 1), at(1, 1, 1), w[0]), w[1])
  return lerp3(z0, z1, w[2])
}

const run = (cube: ParsedCube, c: V3): V3 => shaderLut(lutTexture(cube), lutInfo(cube), cube.domainMin, cube.domainMax, c)

/** A 3D table that swaps red and blue and dims green: nothing in it is symmetric. */
const swapped = (size: number): ParsedCube => {
  const cube = identityCube('3d', size)
  for (let i = 0; i < cube.data.length; i += 3) {
    const r = cube.data[i]
    const g = cube.data[i + 1]
    const b = cube.data[i + 2]
    cube.data[i] = b
    cube.data[i + 1] = g * 0.5
    cube.data[i + 2] = r
  }
  return cube
}

/** A 1D table that is a different curve on each channel. */
const curved = (size: number): ParsedCube => {
  const cube = identityCube('1d', size)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    cube.data[i * 3] = x * x
    cube.data[i * 3 + 1] = Math.sqrt(x)
    cube.data[i * 3 + 2] = 1 - x
  }
  return cube
}

const SAMPLES: V3[] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [0.13, 0.77, 0.41],
  [0.999, 0.001, 0.5],
  [0.25, 0.25, 0.9],
  [1, 0, 0.3333],
  [0.07, 0.93, 0.62],
]

const closeTo = (a: V3, b: V3, tol = 1e-5): void => {
  for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(tol)
}

describe('lutTexture', () => {
  it('uploads a 3D table as it is, red along x, green along y, blue along z', () => {
    const cube = swapped(4)
    const t = lutTexture(cube)
    expect([t.width, t.height, t.depth]).toEqual([4, 4, 4])
    expect(t.data.length).toBe(4 * 4 * 4 * 3)
    // The row for red 3, green 1, blue 2 sits where the file puts it.
    const row = (2 * 4 + 1) * 4 + 3
    expect(texel(t, 3, 1, 2)).toEqual([cube.data[row * 3], cube.data[row * 3 + 1], cube.data[row * 3 + 2]])
  })

  it('folds a short 1D table into one row, padded with zeros', () => {
    const t = lutTexture(identityCube('1d', 10))
    expect([t.width, t.height, t.depth]).toEqual([LUT_1D_ROW, 1, 1])
    expect(texel(t, 9, 0, 0)).toEqual([1, 1, 1])
    expect(texel(t, 10, 0, 0)).toEqual([0, 0, 0])
  })

  it('folds a long 1D table into rows of 256, entry k at (k % 256, k / 256)', () => {
    const cube = curved(4096)
    const t = lutTexture(cube)
    expect([t.width, t.height, t.depth]).toEqual([256, 16, 1])
    for (const k of [0, 255, 256, 1000, 4095]) {
      expect(texel(t, k % 256, Math.floor(k / 256), 0)).toEqual([cube.data[k * 3], cube.data[k * 3 + 1], cube.data[k * 3 + 2]])
    }
  })

  it('stays inside what every WebGL2 device promises for a 3D texture', () => {
    // The smallest MAX_3D_TEXTURE_SIZE WebGL2 allows is 256.
    const t = lutTexture(identityCube('3d', 65))
    expect(Math.max(t.width, t.height, t.depth)).toBeLessThanOrEqual(256)
    const long = lutTexture(identityCube('1d', 4096))
    expect(Math.max(long.width, long.height, long.depth)).toBeLessThanOrEqual(256)
  })
})

describe('lutInfo', () => {
  it('says none, 1D or 3D, and the size', () => {
    expect(lutInfo(undefined)).toEqual([0, 0])
    expect(lutInfo(identityCube('1d', 17))).toEqual([1, 17])
    expect(lutInfo(identityCube('3d', 33))).toEqual([2, 33])
  })
})

describe('the shader\'s lookup', () => {
  it('an identity table gives its input back, 1D and 3D, at every size', () => {
    for (const kind of ['1d', '3d'] as const) {
      for (const size of [2, 3, 17, 33, 65]) {
        const cube = identityCube(kind, size)
        for (const c of SAMPLES) closeTo(run(cube, c), c, 2e-7)
      }
    }
  })

  it('a long identity 1D table, folded over many rows, still gives its input back', () => {
    const cube = identityCube('1d', 4096)
    for (const c of SAMPLES) closeTo(run(cube, c), c, 2e-7)
  })

  it('agrees with the CPU twin on a table that swaps and dims channels (3D)', () => {
    for (const size of [2, 5, 17]) {
      const cube = swapped(size)
      for (const c of SAMPLES) closeTo(run(cube, c), sampleCube(cube, c))
    }
  })

  it('agrees with the CPU twin on a different curve per channel (1D)', () => {
    for (const size of [2, 9, 256, 257, 1000]) {
      const cube = curved(size)
      for (const c of SAMPLES) closeTo(run(cube, c), sampleCube(cube, c))
    }
  })

  it('maps the input across a table\'s own domain, and clamps outside it', () => {
    const cube = { ...swapped(5), domainMin: [0.2, 0.2, 0.2] as V3, domainMax: [0.8, 0.9, 0.7] as V3 }
    for (const c of [...SAMPLES, [0.1, 0.95, 0.75] as V3]) closeTo(run(cube, c), sampleCube(cube, c))
    closeTo(run(cube, [0, 0, 0]), run(cube, [0.2, 0.2, 0.2]))
    closeTo(run(cube, [1, 1, 1]), run(cube, [0.8, 0.9, 0.7]))
  })

  it('the last step of the table does not read past its edge', () => {
    const cube = swapped(5)
    expect(() => run(cube, [1, 1, 1])).not.toThrow()
    closeTo(run(cube, [1, 1, 1]), [1, 0.5, 1])
  })

  it('a table the renderer was not given returns the picture untouched', () => {
    const t = lutTexture(identityCube('3d', 2))
    expect(shaderLut(t, [0, 0], [0, 0, 0], [1, 1, 1], [0.3, 0.6, 0.9])).toEqual([0.3, 0.6, 0.9])
  })
})

describe('the shader text', () => {
  it('defines the lookup the effect calls, with a highp sampler', () => {
    expect(LUT_GLSL).toContain('vec3 olpLut(highp sampler3D t, vec2 info, vec3 lo, vec3 hi, vec3 c)')
    expect(LUT_GLSL).toContain('texelFetch')
  })

  it('folds a 1D table with the same row width the texture uses', () => {
    expect(LUT_GLSL).toContain(`k & ${LUT_1D_ROW - 1}`)
    expect(LUT_GLSL).toContain(`k >> ${Math.log2(LUT_1D_ROW)}`)
  })

  it('leaves room for the cap of LUTs per clip inside the 16 fragment units every device has', () => {
    // Unit 0 is the picture, the LUTs start at 4 (render/glRenderer.ts).
    expect(4 + MAX_LUTS_PER_CLIP).toBeLessThanOrEqual(16)
  })
})
