// The ONE shared WebGL2 renderer. Runs unchanged in a main-thread <canvas>
// context (preview) and a worker OffscreenCanvas context (export) — so it never
// touches document/window and takes the GL context from the caller. Given a
// RenderFrame (pure, from resolve.ts) and a TextureSource, it draws pixel-
// identical output in both places. This file is the sole engine exception that
// touches GL; all transform math lives in the pure, unit-tested mat.ts.

import { getEffect, stackSignature } from '../effects/registry'
import { computeQuad, cropUV } from './mat'
import type { RenderFrame, RenderLayer, RenderOp, ResolvedEffect, TextureSource, TransitionKind } from './types'

export interface Renderer {
  render(frame: RenderFrame, tex: TextureSource): void
  dispose(): void
}

// Blur radius is bounded so a wild keyframe can't request thousands of taps.
const MAX_BLUR_PX = 64

// --- Shaders ---------------------------------------------------------------

// Positions arrive already in seq-space px; the vertex shader projects them to
// clip space with origin top-left, y DOWN, matching the 2D-canvas convention.
const LAYER_VS = `#version 300 es
precision highp float;
in vec2 aPos;   // seq-space pixels
in vec2 aUV;
uniform vec2 uFrame; // frame width,height in px
out vec2 vUV;
void main() {
  vec2 clip = vec2(aPos.x / uFrame.x * 2.0 - 1.0, 1.0 - aPos.y / uFrame.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV;
}`

/** Uniform name for one param of the effect sitting at stack index `i`. */
const uniformName = (i: number, key: string): string => `u_fx${i}_${key}`

/**
 * Build the per-layer fragment shader for one POINTWISE effect stack. Each
 * effect's GLSL body is concatenated in stack order inside its own block scope,
 * so two instances of the same effect cannot collide on a local name; their
 * uniforms are indexed, so they cannot collide either.
 *
 * An empty stack yields the identity shader — which is exactly what the old
 * monolithic LAYER_FS computed when every filter sat at 0. Output is
 * PREMULTIPLIED alpha so the alpha-OVER blend (ONE, ONE_MINUS_SRC_ALPHA)
 * composites correctly.
 */
function buildLayerFs(pointwise: readonly ResolvedEffect[], withMask: boolean): string {
  const decls: string[] = []
  const bodies: string[] = []
  pointwise.forEach((fx, i) => {
    const def = getEffect(fx.type)
    if (!def?.glsl) return
    for (const param of def.params) decls.push(`uniform float ${uniformName(i, param.key)};`)
    bodies.push(`  { // ${def.type}\n${def.glsl((key) => uniformName(i, key))}\n  }`)
  })
  // Shape mask (source-UV space) modulates alpha before the effect chain, so
  // keys/grades see the masked layer. Compiled in only when the layer HAS a
  // mask — unmasked layers keep the identity shader.
  const maskDecls = withMask
    ? `uniform vec2 uMaskCenter;
uniform vec2 uMaskRadius;
uniform float uMaskFeather;
uniform int uMaskKind;   // 0 = rect, 1 = ellipse
uniform float uMaskInvert;`
    : ''
  const maskBody = withMask
    ? `  { // shape mask
    float mkCov;
    if (uMaskKind == 0) {
      vec2 mkD = abs(vUV - uMaskCenter) - uMaskRadius;
      float mkOut = length(max(mkD, vec2(0.0))) + min(max(mkD.x, mkD.y), 0.0);
      mkCov = 1.0 - smoothstep(0.0, max(uMaskFeather, 1e-4), mkOut);
    } else {
      vec2 mkN = (vUV - uMaskCenter) / max(uMaskRadius, vec2(1e-4));
      float mkF = max(uMaskFeather, 1e-4) / max(min(uMaskRadius.x, uMaskRadius.y), 1e-4);
      mkCov = 1.0 - smoothstep(1.0 - mkF * 0.5, 1.0 + mkF * 0.5, length(mkN));
    }
    a *= mix(mkCov, 1.0 - mkCov, uMaskInvert);
  }`
    : ''
  return `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec4 uUVRect; // u0,v0,u1,v1 — reject samples outside the crop window
uniform vec2 uFrame;  // frame width,height in px (shared with the VS)
uniform float uSeed;  // resolver frame index — animates stochastic effects (grain)
${maskDecls}
${decls.join('\n')}
out vec4 outColor;
void main() {
  if (vUV.x < uUVRect.x || vUV.x > uUVRect.z || vUV.y < uUVRect.y || vUV.y > uUVRect.w) {
    outColor = vec4(0.0);
    return;
  }
  vec4 src = texture(uTex, vUV);
  vec3 c = src.rgb;
  float a = src.a * uOpacity;
${maskBody}
${bodies.join('\n')}
  c = clamp(c, 0.0, 1.0);
  outColor = vec4(c * a, a); // premultiplied
}`
}

// Full-screen pass shared by blur + combine + blit.
const FULL_VS = `#version 300 es
precision highp float;
in vec2 aPos; // clip-space [-1,1]
out vec2 vUV;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUV = aPos * 0.5 + 0.5; // 0..1, y up (FBO textures are bottom-row-first here)
}`

// Separable gaussian; uDir is (1/w,0) or (0,1/h). Premultiplied in, premult out.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;    // texel step along the blur axis
uniform float uRadius; // in texels
out vec4 outColor;
void main() {
  float r = max(uRadius, 0.0);
  if (r < 0.5) { outColor = texture(uTex, vUV); return; }
  float sigma = r * 0.5;
  float twoSigma2 = 2.0 * sigma * sigma;
  vec4 sum = texture(uTex, vUV);
  float wsum = 1.0;
  int ir = int(min(r, ${MAX_BLUR_PX}.0));
  for (int i = 1; i <= ${MAX_BLUR_PX}; i++) {
    if (i > ir) break;
    float w = exp(-float(i * i) / twoSigma2);
    sum += texture(uTex, vUV + uDir * float(i)) * w;
    sum += texture(uTex, vUV - uDir * float(i)) * w;
    wsum += 2.0 * w;
  }
  outColor = sum / wsum;
}`

// Blit a premultiplied FBO texture straight through (used to compose onto target).
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV); }`

// Unsharp mask: centre minus a 4-tap cross average = high-pass, scaled back in.
// Premultiplied in/out; rgb clamped to alpha so the result stays valid premult.
const SHARPEN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;   // 1/w, 1/h
uniform float uAmount;
uniform float uRadius; // tap offset in texels
out vec4 outColor;
void main() {
  vec4 cC = texture(uTex, vUV);
  vec2 o = uTexel * uRadius;
  vec4 nb = texture(uTex, vUV + vec2(o.x, 0.0)) + texture(uTex, vUV - vec2(o.x, 0.0))
          + texture(uTex, vUV + vec2(0.0, o.y)) + texture(uTex, vUV - vec2(0.0, o.y));
  vec3 hp = cC.rgb - nb.rgb * 0.25;
  outColor = vec4(clamp(cC.rgb + hp * uAmount, vec3(0.0), vec3(cC.a)), cC.a);
}`

// Dest-sampling blend modes (overlay / soft light): fixed-function blending
// cannot read the destination, so the target is captured to a texture and the
// blend computed in a full-screen pass. Both inputs premultiplied; math runs
// on straight colour (W3C compositing formulas) and re-premultiplies.
const BLENDMODE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform int uMode; // 0 = overlay, 1 = soft light
out vec4 outColor;
void main() {
  vec4 dst = texture(uDst, vUV);
  vec4 src = texture(uSrc, vUV);
  vec3 d = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 b;
  if (uMode == 0) {
    b = mix(2.0 * d * s, 1.0 - 2.0 * (1.0 - d) * (1.0 - s), step(0.5, d));
  } else {
    vec3 dd = mix(((16.0 * d - 12.0) * d + 4.0) * d, sqrt(d), step(0.25, d));
    b = mix(d - (1.0 - 2.0 * s) * d * (1.0 - d), d + (2.0 * s - 1.0) * (dd - d), step(0.5, s));
  }
  vec3 outRgb = mix(d, b, src.a);
  float outA = clamp(dst.a + src.a * (1.0 - dst.a), 0.0, 1.0);
  outColor = vec4(outRgb * outA, outA);
}`

// Glow combine: base + bright-passed blurred copy as additive light. The glow's
// luma feeds alpha so bloom escaping the layer's silhouette still composites
// over lower tracks. Premultiplied in/out.
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uBase;
uniform sampler2D uBlur;
uniform float uIntensity;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec4 base = texture(uBase, vUV);
  vec4 blurc = texture(uBlur, vUV);
  vec3 glow = max(blurc.rgb - uThreshold * blurc.a, vec3(0.0)) * uIntensity;
  float glowLuma = dot(glow, vec3(0.2126, 0.7152, 0.0722));
  float a = clamp(base.a + glowLuma, 0.0, 1.0);
  outColor = vec4(min(base.rgb + glow, vec3(a)), a);
}`

// Transition combine: both inputs are premultiplied composited layers on black.
const COMBINE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform int uKind;   // index into TransitionKind order
uniform float uSoft; // edge softness in UV for wipes
uniform float uSeed; // resolver frame index — animates the glitch slices
out vec4 outColor;

vec4 dip(vec4 from, vec4 to, float p, vec3 col) {
  vec4 solid = vec4(col, 1.0);
  if (p < 0.5) return mix(from, solid, clamp(p * 2.0, 0.0, 1.0));
  return mix(solid, to, clamp((p - 0.5) * 2.0, 0.0, 1.0));
}

void main() {
  vec4 from = texture(uFrom, vUV);
  vec4 to = texture(uTo, vUV);
  float p = uProgress;
  vec4 col;
  if (uKind == 0) {            // crossDissolve
    col = mix(from, to, p);
  } else if (uKind == 1) {     // dipToBlack
    col = dip(from, to, p, vec3(0.0));
  } else if (uKind == 2) {     // dipToWhite
    col = dip(from, to, p, vec3(1.0));
  } else if (uKind == 3) {     // wipeLeft: edge sweeps from right to left, TO from the left
    float edge = 1.0 - p;
    float m = smoothstep(edge - uSoft, edge + uSoft, 1.0 - vUV.x);
    col = mix(from, to, m);
  } else if (uKind == 4) {     // wipeRight: edge sweeps left to right, TO from the right
    float m = smoothstep(p - uSoft, p + uSoft, vUV.x);
    col = mix(from, to, m);
  } else if (uKind == 5) {     // slideLeft: TO slides in from the right, over from
    vec2 fromUV = vec2(vUV.x + p, vUV.y);
    vec2 toUV = vec2(vUV.x - (1.0 - p), vUV.y);
    vec4 f = (fromUV.x <= 1.0) ? texture(uFrom, fromUV) : vec4(0.0);
    vec4 t = (toUV.x >= 0.0) ? texture(uTo, toUV) : vec4(0.0);
    col = (toUV.x >= 0.0) ? t : f;
  } else if (uKind == 6) {     // slideRight: TO slides in from the left, over from
    vec2 fromUV = vec2(vUV.x - p, vUV.y);
    vec2 toUV = vec2(vUV.x + (1.0 - p), vUV.y);
    vec4 f = (fromUV.x >= 0.0) ? texture(uFrom, fromUV) : vec4(0.0);
    vec4 t = (toUV.x <= 1.0) ? texture(uTo, toUV) : vec4(0.0);
    col = (toUV.x <= 1.0) ? t : f;
  } else if (uKind == 7) {     // zoom: FROM punches in while TO settles from a deeper punch
    float zp = smoothstep(0.0, 1.0, p);
    vec2 ctr = vec2(0.5);
    vec2 fromUV = ctr + (vUV - ctr) / (1.0 + 0.6 * zp);
    vec2 toUV = ctr + (vUV - ctr) * (1.0 + 0.4 * (1.0 - zp));
    vec4 f = texture(uFrom, fromUV);
    bool tin = toUV.x >= 0.0 && toUV.x <= 1.0 && toUV.y >= 0.0 && toUV.y <= 1.0;
    vec4 t = tin ? texture(uTo, toUV) : vec4(0.0);
    col = mix(f, t, zp);
  } else if (uKind == 8) {     // spin: whip-rotate FROM out while TO rotates in, both punched
    float sp = smoothstep(0.0, 1.0, p);
    vec2 ctr = vec2(0.5);
    float angF = sp * 0.5;
    float angT = (sp - 1.0) * 0.5;
    vec2 dF = vUV - ctr;
    vec2 rF = vec2(dF.x * cos(angF) - dF.y * sin(angF), dF.x * sin(angF) + dF.y * cos(angF));
    vec2 rT = vec2(dF.x * cos(angT) - dF.y * sin(angT), dF.x * sin(angT) + dF.y * cos(angT));
    vec4 f = texture(uFrom, ctr + rF / (1.0 + 0.3 * sp));
    vec4 t = texture(uTo, ctr + rT / (1.0 + 0.3 * (1.0 - sp)));
    col = mix(f, t, sp);
  } else if (uKind == 9) {     // glitch: sliced displacement + RGB split, peaking mid-cut
    float gi = p * (1.0 - p) * 4.0;
    float band = floor(vUV.y * 24.0);
    float rnd = fract(sin(band * 91.17 + uSeed * 13.7) * 43758.5453);
    float rnd2 = fract(sin(band * 41.3 + uSeed * 7.3) * 22578.145);
    float shift = (rnd - 0.5) * 0.2 * gi * step(0.6, rnd2);
    vec2 gUV = vec2(clamp(vUV.x + shift, 0.0, 1.0), vUV.y);
    vec2 split = vec2(0.008 * gi, 0.0);
    if (p < 0.5) {
      col = vec4(texture(uFrom, clamp(gUV + split, 0.0, 1.0)).r, texture(uFrom, gUV).g,
                 texture(uFrom, clamp(gUV - split, 0.0, 1.0)).b, texture(uFrom, gUV).a);
    } else {
      col = vec4(texture(uTo, clamp(gUV + split, 0.0, 1.0)).r, texture(uTo, gUV).g,
                 texture(uTo, clamp(gUV - split, 0.0, 1.0)).b, texture(uTo, gUV).a);
    }
  } else {                     // lumaWipe: TO reveals through FROM's darks first
    float soft = 0.08;
    float luma = dot(from.rgb, vec3(0.2126, 0.7152, 0.0722));
    float pp = p * (1.0 + 2.0 * soft) - soft;
    float m = smoothstep(luma - soft, luma + soft, pp);
    col = mix(from, to, m);
  }
  outColor = col;
}`

const KIND_INDEX: Record<TransitionKind, number> = {
  crossDissolve: 0,
  dipToBlack: 1,
  dipToWhite: 2,
  wipeLeft: 3,
  wipeRight: 4,
  slideLeft: 5,
  slideRight: 6,
  zoom: 7,
  spin: 8,
  glitch: 9,
  lumaWipe: 10,
}

// --- GL helpers ------------------------------------------------------------

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`shader compile failed: ${log}`)
  }
  return sh
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const prog = gl.createProgram()
  if (!prog) throw new Error('createProgram failed')
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error(`program link failed: ${log}`)
  }
  return prog
}

interface Fbo {
  fb: WebGLFramebuffer
  tex: WebGLTexture
}

/** One compiled layer program, specialised to a single pointwise stack shape. */
interface LayerProgram {
  prog: WebGLProgram
  aPos: number
  aUV: number
  uFrame: WebGLUniformLocation | null
  uTex: WebGLUniformLocation | null
  uOpacity: WebGLUniformLocation | null
  uUVRect: WebGLUniformLocation | null
  uSeed: WebGLUniformLocation | null
  /** Mask uniforms — present only on the masked variant of a stack program. */
  mask?: {
    center: WebGLUniformLocation | null
    radius: WebGLUniformLocation | null
    feather: WebGLUniformLocation | null
    kind: WebGLUniformLocation | null
    invert: WebGLUniformLocation | null
  }
  /** fx[stackIndex][paramKey] -> location */
  fx: Record<string, WebGLUniformLocation | null>[]
}

const isPointwise = (fx: ResolvedEffect): boolean => getEffect(fx.type)?.pass === 'pointwise'
const isNeighborhood = (fx: ResolvedEffect): boolean => getEffect(fx.type)?.pass === 'neighborhood'

// --- Renderer --------------------------------------------------------------

export function createRenderer(gl: WebGL2RenderingContext): Renderer {
  // Programs (thrown from here on failure so the caller can fall back).
  const blurProg = link(gl, FULL_VS, BLUR_FS)
  const combineProg = link(gl, FULL_VS, COMBINE_FS)
  const blitProg = link(gl, FULL_VS, BLIT_FS)
  const sharpenProg = link(gl, FULL_VS, SHARPEN_FS)
  const glowProg = link(gl, FULL_VS, GLOW_FS)
  const blendModeProg = link(gl, FULL_VS, BLENDMODE_FS)

  // One layer program per distinct pointwise stack SHAPE (types + order, not
  // values), compiled on first sight and reused thereafter. A project with no
  // effects compiles exactly one identity program; adding a saturation to one
  // clip compiles a second. Bounded by the number of distinct stacks in use.
  const layerPrograms = new Map<string, LayerProgram>()

  function getLayerProgram(pointwise: readonly ResolvedEffect[], withMask: boolean): LayerProgram {
    // Masked layers compile their own variant of the stack program — an
    // unmasked identity clip must never pay for mask uniforms it doesn't have.
    const key = stackSignature(pointwise) + (withMask ? '#mask' : '')
    const hit = layerPrograms.get(key)
    if (hit) return hit
    const prog = link(gl, LAYER_VS, buildLayerFs(pointwise, withMask))
    const entry: LayerProgram = {
      prog,
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      uFrame: gl.getUniformLocation(prog, 'uFrame'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uOpacity: gl.getUniformLocation(prog, 'uOpacity'),
      uUVRect: gl.getUniformLocation(prog, 'uUVRect'),
      uSeed: gl.getUniformLocation(prog, 'uSeed'),
      ...(withMask
        ? {
            mask: {
              center: gl.getUniformLocation(prog, 'uMaskCenter'),
              radius: gl.getUniformLocation(prog, 'uMaskRadius'),
              feather: gl.getUniformLocation(prog, 'uMaskFeather'),
              kind: gl.getUniformLocation(prog, 'uMaskKind'),
              invert: gl.getUniformLocation(prog, 'uMaskInvert'),
            },
          }
        : {}),
      fx: pointwise.map((fx, i) => {
        const def = getEffect(fx.type)
        const locs: Record<string, WebGLUniformLocation | null> = {}
        for (const param of def?.params ?? []) locs[param.key] = gl.getUniformLocation(prog, uniformName(i, param.key))
        return locs
      }),
    }
    layerPrograms.set(key, entry)
    return entry
  }

  const blurLoc = {
    aPos: gl.getAttribLocation(blurProg, 'aPos'),
    uTex: gl.getUniformLocation(blurProg, 'uTex'),
    uDir: gl.getUniformLocation(blurProg, 'uDir'),
    uRadius: gl.getUniformLocation(blurProg, 'uRadius'),
  }
  const combineLoc = {
    aPos: gl.getAttribLocation(combineProg, 'aPos'),
    uFrom: gl.getUniformLocation(combineProg, 'uFrom'),
    uTo: gl.getUniformLocation(combineProg, 'uTo'),
    uProgress: gl.getUniformLocation(combineProg, 'uProgress'),
    uKind: gl.getUniformLocation(combineProg, 'uKind'),
    uSoft: gl.getUniformLocation(combineProg, 'uSoft'),
    uSeed: gl.getUniformLocation(combineProg, 'uSeed'),
  }
  const blitLoc = {
    aPos: gl.getAttribLocation(blitProg, 'aPos'),
    uTex: gl.getUniformLocation(blitProg, 'uTex'),
  }
  const sharpenLoc = {
    aPos: gl.getAttribLocation(sharpenProg, 'aPos'),
    uTex: gl.getUniformLocation(sharpenProg, 'uTex'),
    uTexel: gl.getUniformLocation(sharpenProg, 'uTexel'),
    uAmount: gl.getUniformLocation(sharpenProg, 'uAmount'),
    uRadius: gl.getUniformLocation(sharpenProg, 'uRadius'),
  }
  const glowLoc = {
    aPos: gl.getAttribLocation(glowProg, 'aPos'),
    uBase: gl.getUniformLocation(glowProg, 'uBase'),
    uBlur: gl.getUniformLocation(glowProg, 'uBlur'),
    uIntensity: gl.getUniformLocation(glowProg, 'uIntensity'),
    uThreshold: gl.getUniformLocation(glowProg, 'uThreshold'),
  }
  const blendModeLoc = {
    aPos: gl.getAttribLocation(blendModeProg, 'aPos'),
    uDst: gl.getUniformLocation(blendModeProg, 'uDst'),
    uSrc: gl.getUniformLocation(blendModeProg, 'uSrc'),
    uMode: gl.getUniformLocation(blendModeProg, 'uMode'),
  }

  // Reusable buffers: a per-layer quad (positions+UVs, rewritten each draw) and
  // a static full-screen triangle-pair for the post passes.
  const layerVbo = gl.createBuffer()
  const fullVbo = gl.createBuffer()
  if (!layerVbo || !fullVbo) throw new Error('createBuffer failed')
  gl.bindBuffer(gl.ARRAY_BUFFER, fullVbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  // Allocate the per-layer quad store ONCE (6 verts × 4 floats) and rewrite it
  // each draw with bufferSubData + a reused array — avoids a per-layer per-frame
  // Float32Array allocation and VBO storage reallocation in the hot draw loop.
  gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
  gl.bufferData(gl.ARRAY_BUFFER, 24 * 4, gl.DYNAMIC_DRAW)
  const layerVerts = new Float32Array(24)

  const layerVao = gl.createVertexArray()
  const fullVao = gl.createVertexArray()
  if (!layerVao || !fullVao) throw new Error('createVertexArray failed')

  // Shared texture for CHANGING sources (video frames): re-uploaded each draw,
  // but with texSubImage2D into stable storage so it doesn't reallocate.
  const srcTex = gl.createTexture()
  if (!srcTex) throw new Error('createTexture failed')
  const setTexParams = (): void => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }
  gl.bindTexture(gl.TEXTURE_2D, srcTex)
  setTexParams()
  let srcTexW = -1
  let srcTexH = -1

  // Per-source texture cache for STABLE sources — stills (<img>) and the cached
  // title/caption rasters (OffscreenCanvas). Their pixels never change between
  // frames, so once uploaded they're just re-BOUND, never re-uploaded. This is
  // the big playback win on caption-heavy timelines, where 10+ static title
  // layers were each re-uploading their whole texture every frame. Bounded LRU;
  // GL textures freed on eviction. VideoFrames/ImageBitmaps stay on srcTex.
  const STABLE_TEX_CAP = 48
  const texCache = new Map<TexImageSource, { tex: WebGLTexture; w: number; h: number }>()

  /** Upload if needed, return the texture to bind. Skips upload for unchanged
   *  stills/titles. `cacheable` MUST be false for video frames: mediabunny decodes
   *  each frame into a FRESH OffscreenCanvas, so type-sniffing can't tell a reused
   *  title raster from a one-shot video frame — the caller signals it from the layer. */
  function acquireTexture(source: TexImageSource, texW: number, texH: number, cacheable: boolean): WebGLTexture {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    if (cacheable) {
      const hit = texCache.get(source)
      if (hit && hit.w === texW && hit.h === texH) {
        texCache.delete(source)
        texCache.set(source, hit) // LRU touch
        return hit.tex
      }
      const tex = hit?.tex ?? gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      if (!hit) setTexParams()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      texCache.delete(source)
      texCache.set(source, { tex, w: texW, h: texH })
      if (texCache.size > STABLE_TEX_CAP) {
        const oldest = texCache.keys().next().value as TexImageSource
        const e = texCache.get(oldest)
        if (e) gl.deleteTexture(e.tex)
        texCache.delete(oldest)
      }
      return tex
    }
    // CHANGING source: reuse srcTex; texSubImage2D avoids reallocating storage
    // when the frame size is unchanged (the common case across a clip).
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    if (srcTexW === texW && srcTexH === texH) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      srcTexW = texW
      srcTexH = texH
    }
    return srcTex
  }

  // FBO pool, recreated when frame dims change. Sized to seq resolution.
  let fboW = 0
  let fboH = 0
  const pool: Fbo[] = []

  // Destination capture for the dest-sampling blend modes (overlay/soft light).
  // Sized to whatever target it last captured (canvas or seq-sized FBO).
  let destCapTex: WebGLTexture | null = null
  let destCapW = -1
  let destCapH = -1

  function captureTarget(targetFb: WebGLFramebuffer | null, w: number, h: number): void {
    if (!destCapTex) {
      destCapTex = gl.createTexture()
      if (!destCapTex) throw new Error('createTexture failed')
      gl.bindTexture(gl.TEXTURE_2D, destCapTex)
      setTexParams()
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, destCapTex)
    if (w !== destCapW || h !== destCapH) {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0)
      destCapW = w
      destCapH = h
    } else {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h)
    }
  }

  // Fixed-function blend for the modes that don't need to read the destination.
  // All inputs are premultiplied: multiply = dst*(src + 1 - srcA), screen =
  // src + dst*(1 - src), add = src + dst — each is exact for opaque sources and
  // degrades gracefully with alpha.
  function setBlendForMode(mode: RenderLayer['blendMode']): void {
    if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA)
    else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR)
    else if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE)
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  function makeFbo(w: number, h: number): Fbo {
    const tex = gl.createTexture()
    const fb = gl.createFramebuffer()
    if (!tex || !fb) throw new Error('FBO alloc failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { fb, tex }
  }

  // Grow the pool to hold at least `n` FBOs at the current dims.
  function ensurePool(w: number, h: number, n: number): void {
    if (w !== fboW || h !== fboH) {
      for (const f of pool) {
        gl.deleteFramebuffer(f.fb)
        gl.deleteTexture(f.tex)
      }
      pool.length = 0
      fboW = w
      fboH = h
    }
    while (pool.length < n) pool.push(makeFbo(w, h))
  }

  function bindFull(loc: number): void {
    gl.bindVertexArray(fullVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, fullVbo)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }

  function clear(r: number, g: number, b: number, a: number): void {
    gl.clearColor(r, g, b, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  // Draw one layer (transform + crop + filters, premultiplied) into the CURRENT
  // framebuffer. Alpha-over blend must already be set by the caller.
  function drawLayer(layer: RenderLayer, source: TexImageSource, frameW: number, frameH: number): void {
    const texW = sourceW(source)
    const texH = sourceH(source)
    if (texW <= 0 || texH <= 0) return

    // Only genuinely-reused sources are cacheable: a title/caption raster (a
    // stable OffscreenCanvas) or a still <img>. VIDEO frames are a fresh
    // OffscreenCanvas each frame — never cache them, or the LRU floods with
    // one-shot full-res textures (VRAM blowup on 4K export). Signalled from the
    // layer, not the source type (both are OffscreenCanvas).
    const cacheable =
      layer.title !== undefined || (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement)
    const tex = acquireTexture(source, texW, texH, cacheable)

    const { corners } = computeQuad({ frameW, frameH, texW, texH, transform: layer.transform })
    const uv = cropUV(layer.transform.cropT, layer.transform.cropR, layer.transform.cropB, layer.transform.cropL)
    // Interleaved pos(x,y) + uv(u,v) for TL,TR,BR then TL,BR,BL (two triangles).
    const [tl, tr, br, bl] = corners
    const v = layerVerts
    v[0] = tl[0]; v[1] = tl[1]; v[2] = uv.u0; v[3] = uv.v0
    v[4] = tr[0]; v[5] = tr[1]; v[6] = uv.u1; v[7] = uv.v0
    v[8] = br[0]; v[9] = br[1]; v[10] = uv.u1; v[11] = uv.v1
    v[12] = tl[0]; v[13] = tl[1]; v[14] = uv.u0; v[15] = uv.v0
    v[16] = br[0]; v[17] = br[1]; v[18] = uv.u1; v[19] = uv.v1
    v[20] = bl[0]; v[21] = bl[1]; v[22] = uv.u0; v[23] = uv.v1

    const pointwise = layer.effects.filter(isPointwise)
    const lp = getLayerProgram(pointwise, !!layer.mask)

    gl.useProgram(lp.prog)
    gl.bindVertexArray(layerVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, v)
    gl.enableVertexAttribArray(lp.aPos)
    gl.vertexAttribPointer(lp.aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(lp.aUV)
    gl.vertexAttribPointer(lp.aUV, 2, gl.FLOAT, false, 16, 8)

    gl.uniform2f(lp.uFrame, frameW, frameH)
    gl.uniform1i(lp.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1f(lp.uOpacity, clamp01(layer.opacity))
    gl.uniform4f(lp.uUVRect, uv.u0, uv.v0, uv.u1, uv.v1)
    if (lp.uSeed) gl.uniform1f(lp.uSeed, layer.frameSeed)
    if (layer.mask && lp.mask) {
      const m = layer.mask
      gl.uniform2f(lp.mask.center, m.cx, m.cy)
      gl.uniform2f(lp.mask.radius, Math.max(m.rx, 1e-4), Math.max(m.ry, 1e-4))
      gl.uniform1f(lp.mask.feather, m.feather)
      gl.uniform1i(lp.mask.kind, m.kind === 'ellipse' ? 1 : 0)
      gl.uniform1f(lp.mask.invert, m.invert ? 1 : 0)
    }
    // Bind this draw's effect params. Locations were resolved against THIS
    // program, so index i lines up with pointwise[i] by construction.
    pointwise.forEach((fx, i) => {
      const locs = lp.fx[i]
      if (!locs) return
      for (const key of Object.keys(locs)) {
        const loc = locs[key]
        if (loc) gl.uniform1f(loc, fx.params[key] ?? 0)
      }
    })
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // Separable gaussian on `srcFbo` into a scratch and back; result left in
  // srcFbo. radiusPx is in OUTPUT px (== seq px since FBO is seq-sized).
  function blurFbo(srcFbo: Fbo, scratch: Fbo, radiusPx: number): void {
    const r = Math.min(radiusPx, MAX_BLUR_PX)
    gl.useProgram(blurProg)
    bindFull(blurLoc.aPos)
    gl.uniform1i(blurLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)

    // Horizontal: srcFbo -> scratch.
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex)
    gl.uniform2f(blurLoc.uDir, 1 / fboW, 0)
    gl.uniform1f(blurLoc.uRadius, r)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Vertical: scratch -> srcFbo.
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFbo.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.bindTexture(gl.TEXTURE_2D, scratch.tex)
    gl.uniform2f(blurLoc.uDir, 0, 1 / fboH)
    gl.uniform1f(blurLoc.uRadius, r)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Directional smear: the SAME separable-blur program run twice along one
  // axis (half radius each ≈ a triangular kernel), so no new shader and the
  // result lands back in srcFbo exactly like blurFbo.
  function directionalBlurFbo(srcFbo: Fbo, scratch: Fbo, angleRad: number, radiusPx: number): void {
    const r = Math.min(radiusPx, MAX_BLUR_PX)
    gl.useProgram(blurProg)
    bindFull(blurLoc.aPos)
    gl.uniform1i(blurLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    const dx = Math.cos(angleRad) / fboW
    const dy = Math.sin(angleRad) / fboH

    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex)
    gl.uniform2f(blurLoc.uDir, dx, dy)
    gl.uniform1f(blurLoc.uRadius, r / 2)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFbo.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.bindTexture(gl.TEXTURE_2D, scratch.tex)
    gl.uniform2f(blurLoc.uDir, dx, dy)
    gl.uniform1f(blurLoc.uRadius, r / 2)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Single-pass unsharp mask into scratch, copied back so the result lands in
  // srcFbo like every neighborhood pass.
  function sharpenFbo(srcFbo: Fbo, scratch: Fbo, amount: number, radiusPx: number): void {
    gl.useProgram(sharpenProg)
    bindFull(sharpenLoc.aPos)
    gl.uniform1i(sharpenLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex)
    gl.uniform2f(sharpenLoc.uTexel, 1 / fboW, 1 / fboH)
    gl.uniform1f(sharpenLoc.uAmount, amount)
    gl.uniform1f(sharpenLoc.uRadius, Math.min(Math.max(radiusPx, 0), 8))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFbo.fb)
    gl.viewport(0, 0, fboW, fboH)
    blitFbo(scratch)
  }

  // Glow: copy the layer into `extra`, blur it there, then additively combine
  // the bright-passed blur with the original. Needs a third seq-sized FBO.
  function glowFbo(
    srcFbo: Fbo,
    scratch: Fbo,
    extra: Fbo,
    radiusPx: number,
    intensity: number,
    threshold: number,
  ): void {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, extra.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    blitFbo(srcFbo)
    blurFbo(extra, scratch, radiusPx)

    gl.useProgram(glowProg)
    bindFull(glowLoc.aPos)
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    gl.uniform1i(glowLoc.uBase, 0)
    gl.uniform1i(glowLoc.uBlur, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, extra.tex)
    gl.uniform1f(glowLoc.uIntensity, intensity)
    gl.uniform1f(glowLoc.uThreshold, threshold)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFbo.fb)
    gl.viewport(0, 0, fboW, fboH)
    blitFbo(scratch)
  }

  /**
   * Run one neighborhood effect over the layer's isolated FBO. Result is left
   * in `fbo`. These run AFTER the pointwise chain (which already premultiplied
   * alpha), in stack order.
   */
  function applyNeighborhood(fx: ResolvedEffect, fbo: Fbo, scratch: Fbo): void {
    if (fx.type === 'gaussianBlur') {
      const r = fx.params.blur ?? 0
      if (r > 0) blurFbo(fbo, scratch, r)
    } else if (fx.type === 'directionalBlur') {
      const strength = fx.params.strength ?? 0
      if (strength > 0.005) {
        const angle = ((fx.params.angleDeg ?? 0) * Math.PI) / 180
        directionalBlurFbo(fbo, scratch, angle, strength * MAX_BLUR_PX)
      }
    } else if (fx.type === 'sharpen') {
      const amount = fx.params.amount ?? 0
      if (amount > 0.001) sharpenFbo(fbo, scratch, amount, fx.params.radius ?? 1)
    } else if (fx.type === 'glow') {
      const intensity = fx.params.intensity ?? 0
      if (intensity > 0.001) {
        // Glow holds a blurred copy alongside the original, so it needs a third
        // seq-sized FBO beyond the (fbo, scratch) pair every pass gets. Grown
        // lazily: projects without glow never pay for it. pool[4] is free in
        // both the layer path (uses 2,3) and the transition path (uses 0-3).
        ensurePool(fboW, fboH, 5)
        glowFbo(fbo, scratch, pool[4], fx.params.radius ?? 24, intensity, fx.params.threshold ?? 0.6)
      }
    }
  }

  // Composite one layer op. When the stack has neighborhood effects (blur), the
  // layer is drawn into its own FBO first so the effect cannot bleed into its
  // siblings, then blitted over the target. Otherwise it draws straight through.
  function compositeLayer(
    layer: RenderLayer,
    source: TexImageSource,
    frameW: number,
    frameH: number,
    targetFb: WebGLFramebuffer | null,
    layerFbo: Fbo,
    scratch: Fbo,
  ): void {
    const post = layer.effects.filter(isNeighborhood)
    const mode = layer.blendMode
    // Overlay/soft light must read the destination, so they always take the
    // isolated-FBO path even without neighborhood effects.
    const needsDestSample = mode === 'overlay' || mode === 'softLight'
    if (post.length > 0 || needsDestSample) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layerFbo.fb)
      gl.viewport(0, 0, fboW, fboH)
      gl.disable(gl.BLEND)
      clear(0, 0, 0, 0)
      // Blend within the layer FBO with premultiplied over onto transparent.
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      drawLayer(layer, source, frameW, frameH)
      for (const fx of post) applyNeighborhood(fx, layerFbo, scratch)
      // The target may be a seq-sized transition FBO (fboW×fboH), NOT the
      // canvas — sizing the viewport to the canvas would draw into only a
      // sub-rect of that FBO (the transition-preview bug).
      const tw = targetFb ? fboW : gl.canvas.width
      const th = targetFb ? fboH : gl.canvas.height
      if (needsDestSample) {
        // Capture what's on the target, then compute the blend full-screen.
        captureTarget(targetFb, tw, th)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
        gl.viewport(0, 0, tw, th)
        gl.disable(gl.BLEND)
        gl.useProgram(blendModeProg)
        bindFull(blendModeLoc.aPos)
        gl.uniform1i(blendModeLoc.uDst, 0)
        gl.uniform1i(blendModeLoc.uSrc, 1)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, destCapTex!)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, layerFbo.tex)
        gl.uniform1i(blendModeLoc.uMode, mode === 'overlay' ? 0 : 1)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.activeTexture(gl.TEXTURE0)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
        gl.viewport(0, 0, tw, th)
        gl.enable(gl.BLEND)
        setBlendForMode(mode)
        blitFbo(layerFbo)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      }
    } else {
      // Fast path: draw straight onto the target. Same viewport note as above.
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
      gl.viewport(0, 0, targetFb ? fboW : gl.canvas.width, targetFb ? fboH : gl.canvas.height)
      gl.enable(gl.BLEND)
      setBlendForMode(mode)
      drawLayer(layer, source, frameW, frameH)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    }
  }

  // Render a layer, fully composited on opaque black, into `dst` (for transitions).
  function renderSideToFbo(
    layer: RenderLayer,
    source: TexImageSource | null,
    frameW: number,
    frameH: number,
    dst: Fbo,
    layerFbo: Fbo,
    scratch: Fbo,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    // TRANSPARENT base, not opaque black: a transition on an upper track must
    // let LOWER tracks show through wherever its clips don't cover (e.g. a
    // scaled PIP over a full-frame background). Dip solids stay opaque (alpha 1)
    // where they apply, so dips still read; only the uncovered area is see-through.
    clear(0, 0, 0, 0)
    if (!source) return
    // Blend modes composite against the tracks BELOW, but a transition side is
    // isolated on transparent — multiply/overlay against nothing would black
    // out or vanish the clip mid-transition. Flatten to normal inside sides.
    const flat = layer.blendMode !== 'normal' ? { ...layer, blendMode: 'normal' as const } : layer
    compositeLayer(flat, source, frameW, frameH, dst.fb, layerFbo, scratch)
  }

  function blitFbo(fbo: Fbo): void {
    gl.useProgram(blitProg)
    bindFull(blitLoc.aPos)
    gl.uniform1i(blitLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fbo.tex)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function drawTransition(
    op: Extract<RenderOp, { type: 'transition' }>,
    tex: TextureSource,
    frameW: number,
    frameH: number,
  ): void {
    // FBOs: 0=from-composited, 1=to-composited, 2=layer scratch, 3=blur scratch.
    ensurePool(frameW, frameH, 4)
    const fromFbo = pool[0]
    const toFbo = pool[1]
    const layerFbo = pool[2]
    const scratch = pool[3]
    const fromSrc = tex(op.from)
    const toSrc = tex(op.to)
    renderSideToFbo(op.from, fromSrc, frameW, frameH, fromFbo, layerFbo, scratch)
    renderSideToFbo(op.to, toSrc, frameW, frameH, toFbo, layerFbo, scratch)

    // Combine into the default framebuffer (the visible/target canvas), OVER
    // whatever lower tracks were already drawn. The combined sides are
    // premultiplied (transparent where neither clip covers), so premultiplied-
    // over compositing lets those lower tracks show. For a full-frame transition
    // the combined alpha is 1 everywhere, so this is identical to a replace.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(combineProg)
    bindFull(combineLoc.aPos)
    gl.uniform1i(combineLoc.uFrom, 0)
    gl.uniform1i(combineLoc.uTo, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fromFbo.tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, toFbo.tex)
    gl.uniform1f(combineLoc.uProgress, clamp01(op.progress))
    gl.uniform1i(combineLoc.uKind, KIND_INDEX[op.kind])
    gl.uniform1f(combineLoc.uSoft, 0.004)
    if (combineLoc.uSeed) gl.uniform1f(combineLoc.uSeed, op.from.frameSeed)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
  }

  function render(frame: RenderFrame, tex: TextureSource): void {
    const frameW = frame.width
    const frameH = frame.height
    // Pool for per-layer isolation: 2 FBOs (layer + blur scratch) at seq res.
    ensurePool(frameW, frameH, 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
    gl.disable(gl.BLEND)
    clear(0, 0, 0, 1) // opaque black background

    for (const op of frame.ops) {
      if (op.type === 'layer') {
        const source = tex(op.layer)
        if (!source) continue // still decoding — skip, never throw
        compositeLayer(op.layer, source, frameW, frameH, null, pool[2], pool[3])
      } else {
        drawTransition(op, tex, frameW, frameH)
      }
    }
    gl.bindVertexArray(null)
  }

  function dispose(): void {
    for (const lp of layerPrograms.values()) gl.deleteProgram(lp.prog)
    layerPrograms.clear()
    gl.deleteProgram(blurProg)
    gl.deleteProgram(combineProg)
    gl.deleteProgram(blitProg)
    gl.deleteProgram(sharpenProg)
    gl.deleteProgram(glowProg)
    gl.deleteProgram(blendModeProg)
    if (destCapTex) gl.deleteTexture(destCapTex)
    destCapTex = null
    gl.deleteBuffer(layerVbo)
    gl.deleteBuffer(fullVbo)
    gl.deleteVertexArray(layerVao)
    gl.deleteVertexArray(fullVao)
    gl.deleteTexture(srcTex)
    for (const e of texCache.values()) gl.deleteTexture(e.tex)
    texCache.clear()
    for (const f of pool) {
      gl.deleteFramebuffer(f.fb)
      gl.deleteTexture(f.tex)
    }
    pool.length = 0
  }

  return { render, dispose }
}

// --- source-size helpers ---------------------------------------------------
// TexImageSource is a union whose members carry size under different props.

function sourceW(s: TexImageSource): number {
  const o = s as { width?: number; videoWidth?: number; naturalWidth?: number; codedWidth?: number }
  return o.videoWidth ?? o.naturalWidth ?? o.codedWidth ?? o.width ?? 0
}

function sourceH(s: TexImageSource): number {
  const o = s as { height?: number; videoHeight?: number; naturalHeight?: number; codedHeight?: number }
  return o.videoHeight ?? o.naturalHeight ?? o.codedHeight ?? o.height ?? 0
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
