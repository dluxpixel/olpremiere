// What the GPU reads for a LUT: the shader text and the layout of the texture.
//
// Pure text and arithmetic: no GL, no DOM. The renderer (render/glRenderer.ts)
// uploads `lutTexture(cube)` and compiles `LUT_GLSL`; a test pins the layout and
// the shader's index maths against `sampleCube` (effects/cube.ts), the CPU twin.
//
// HOW IT IS SAMPLED, and why not the GPU's own filtering.
// The table is read with `texelFetch` and blended in the shader, in 32 bit float:
// trilinear for a 3D table, linear per channel for a 1D one. The GPU's own
// LINEAR filter would do the same sum, but with weights it rounds to about 8 bits
// on common hardware, which on a small table (a 17 step cube is 6% per step) is
// an error the eye never sees and a test cannot hold to "an identity LUT is an
// exact pass through". Done here, an identity table gives its input back to float
// precision on every GPU, and RGB32F needs no float-filter extension.
//
// ONE sampler3D carries both kinds, so a LUT costs one texture unit:
//   3D table: a size x size x size texture, red along x, green along y, blue along z
//             (the file's own order, red fastest).
//   1D table: a LUT_1D_ROW wide texture, entry k at (k % LUT_1D_ROW, floor(k / LUT_1D_ROW), 0).
//             Folded into rows because a texture is only guaranteed 256 wide in the
//             3D case, and a 1D table may have 4096 entries.

import type { ParsedCube } from './cube'

/** Entries per row of a 1D table's texture. A power of two, and the smallest 3D size WebGL2 promises. */
export const LUT_1D_ROW = 256

/** How many LUT effects one clip can carry at once: one texture unit each, after the picture's. */
export const MAX_LUTS_PER_CLIP = 8

export interface LutTexture {
  width: number
  height: number
  depth: number
  /** RGB floats, `width * height * depth * 3` of them, ready for texImage3D. */
  data: Float32Array
}

/** The texture a table uploads as. A 3D table is its own data; a 1D table is folded into rows. */
export function lutTexture(cube: ParsedCube): LutTexture {
  if (cube.kind === '3d') {
    return { width: cube.size, height: cube.size, depth: cube.size, data: cube.data }
  }
  const rows = Math.ceil(cube.size / LUT_1D_ROW)
  const data = new Float32Array(LUT_1D_ROW * rows * 3)
  data.set(cube.data)
  return { width: LUT_1D_ROW, height: rows, depth: 1, data }
}

/** What the shader is told about the table: kind (0 none, 1 = 1D, 2 = 3D) and size. */
export function lutInfo(cube: ParsedCube | undefined): [number, number] {
  if (!cube) return [0, 0]
  return [cube.kind === '3d' ? 2 : 1, cube.size]
}

/**
 * The GLSL for one LUT lookup, emitted once per shader at global scope. `c` goes
 * in as the encoded 0..1 picture the whole stack works on, the table's own input
 * range (`lo`..`hi`) maps it onto the table, and the table's colour comes back.
 * A table the renderer was not given (`info.x` is 0) returns `c` untouched.
 */
export const LUT_GLSL = `
vec3 olpLutTap1(highp sampler3D t, int k) {
  return texelFetch(t, ivec3(k & ${LUT_1D_ROW - 1}, k >> ${Math.log2(LUT_1D_ROW)}, 0), 0).rgb;
}
vec3 olpLut(highp sampler3D t, vec2 info, vec3 lo, vec3 hi, vec3 c) {
  if (info.x < 0.5) return c;
  float n = info.y;
  vec3 g = clamp((c - lo) / (hi - lo), 0.0, 1.0) * (n - 1.0);
  vec3 f = min(floor(g), vec3(n - 2.0));
  vec3 w = g - f;
  ivec3 i = ivec3(f);
  if (info.x < 1.5) {
    return vec3(
      mix(olpLutTap1(t, i.x).r, olpLutTap1(t, i.x + 1).r, w.x),
      mix(olpLutTap1(t, i.y).g, olpLutTap1(t, i.y + 1).g, w.y),
      mix(olpLutTap1(t, i.z).b, olpLutTap1(t, i.z + 1).b, w.z));
  }
  vec3 c000 = texelFetch(t, i, 0).rgb;
  vec3 c100 = texelFetch(t, i + ivec3(1, 0, 0), 0).rgb;
  vec3 c010 = texelFetch(t, i + ivec3(0, 1, 0), 0).rgb;
  vec3 c110 = texelFetch(t, i + ivec3(1, 1, 0), 0).rgb;
  vec3 c001 = texelFetch(t, i + ivec3(0, 0, 1), 0).rgb;
  vec3 c101 = texelFetch(t, i + ivec3(1, 0, 1), 0).rgb;
  vec3 c011 = texelFetch(t, i + ivec3(0, 1, 1), 0).rgb;
  vec3 c111 = texelFetch(t, i + ivec3(1, 1, 1), 0).rgb;
  return mix(mix(mix(c000, c100, w.x), mix(c010, c110, w.x), w.y),
             mix(mix(c001, c101, w.x), mix(c011, c111, w.x), w.y), w.z);
}`
