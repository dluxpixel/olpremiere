// The ONE shared WebGL2 renderer. Runs unchanged in a main-thread <canvas>
// context (preview) and a worker OffscreenCanvas context (export) — so it never
// touches document/window and takes the GL context from the caller. Given a
// RenderFrame (pure, from resolve.ts) and a TextureSource, it draws pixel-
// identical output in both places. This file is the sole engine exception that
// touches GL; all transform math lives in the pure, unit-tested mat.ts.

import { computeQuad, cropUV } from './mat'
import type { RenderFrame, RenderLayer, RenderOp, TextureSource, TransitionKind } from './types'

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

// Color filters per the frozen spec. Output is PREMULTIPLIED alpha so the
// alpha-OVER blend (ONE, ONE_MINUS_SRC_ALPHA) composites correctly.
const LAYER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uExposure;
uniform vec4 uUVRect; // u0,v0,u1,v1 — reject samples outside the crop window
out vec4 outColor;
void main() {
  if (vUV.x < uUVRect.x || vUV.x > uUVRect.z || vUV.y < uUVRect.y || vUV.y > uUVRect.w) {
    outColor = vec4(0.0);
    return;
  }
  vec4 src = texture(uTex, vUV);
  vec3 c = src.rgb;
  c *= pow(2.0, uExposure);
  c += uBrightness;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.0 + uSaturation);
  c = clamp(c, 0.0, 1.0);
  float a = src.a * uOpacity;
  outColor = vec4(c * a, a); // premultiplied
}`

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

// Transition combine: both inputs are premultiplied composited layers on black.
const COMBINE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform int uKind;   // index into TransitionKind order
uniform float uSoft; // edge softness in UV for wipes
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
  } else {                     // slideRight: TO slides in from the left, over from
    vec2 fromUV = vec2(vUV.x - p, vUV.y);
    vec2 toUV = vec2(vUV.x + (1.0 - p), vUV.y);
    vec4 f = (fromUV.x >= 0.0) ? texture(uFrom, fromUV) : vec4(0.0);
    vec4 t = (toUV.x <= 1.0) ? texture(uTo, toUV) : vec4(0.0);
    col = (toUV.x <= 1.0) ? t : f;
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

// --- Renderer --------------------------------------------------------------

export function createRenderer(gl: WebGL2RenderingContext): Renderer {
  // Programs (thrown from here on failure so the caller can fall back).
  const layerProg = link(gl, LAYER_VS, LAYER_FS)
  const blurProg = link(gl, FULL_VS, BLUR_FS)
  const combineProg = link(gl, FULL_VS, COMBINE_FS)
  const blitProg = link(gl, FULL_VS, BLIT_FS)

  // Cached uniform/attrib locations.
  const layerLoc = {
    aPos: gl.getAttribLocation(layerProg, 'aPos'),
    aUV: gl.getAttribLocation(layerProg, 'aUV'),
    uFrame: gl.getUniformLocation(layerProg, 'uFrame'),
    uTex: gl.getUniformLocation(layerProg, 'uTex'),
    uOpacity: gl.getUniformLocation(layerProg, 'uOpacity'),
    uBrightness: gl.getUniformLocation(layerProg, 'uBrightness'),
    uContrast: gl.getUniformLocation(layerProg, 'uContrast'),
    uSaturation: gl.getUniformLocation(layerProg, 'uSaturation'),
    uExposure: gl.getUniformLocation(layerProg, 'uExposure'),
    uUVRect: gl.getUniformLocation(layerProg, 'uUVRect'),
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
  }
  const blitLoc = {
    aPos: gl.getAttribLocation(blitProg, 'aPos'),
    uTex: gl.getUniformLocation(blitProg, 'uTex'),
  }

  // Reusable buffers: a per-layer quad (positions+UVs, rewritten each draw) and
  // a static full-screen triangle-pair for the post passes.
  const layerVbo = gl.createBuffer()
  const fullVbo = gl.createBuffer()
  if (!layerVbo || !fullVbo) throw new Error('createBuffer failed')
  gl.bindBuffer(gl.ARRAY_BUFFER, fullVbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

  const layerVao = gl.createVertexArray()
  const fullVao = gl.createVertexArray()
  if (!layerVao || !fullVao) throw new Error('createVertexArray failed')

  // The one uploaded source texture (re-uploaded each layer op).
  const srcTex = gl.createTexture()
  if (!srcTex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, srcTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // FBO pool, recreated when frame dims change. Sized to seq resolution.
  let fboW = 0
  let fboH = 0
  const pool: Fbo[] = []

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

    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    // Flip so texture row 0 (top of the image) maps to v=0; matches cropUV.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    const { corners } = computeQuad({ frameW, frameH, texW, texH, transform: layer.transform })
    const uv = cropUV(layer.transform.cropT, layer.transform.cropR, layer.transform.cropB, layer.transform.cropL)
    // Interleaved pos(x,y) + uv(u,v) for TL,TR,BR then TL,BR,BL (two triangles).
    const [tl, tr, br, bl] = corners
    const verts = new Float32Array([
      tl[0], tl[1], uv.u0, uv.v0,
      tr[0], tr[1], uv.u1, uv.v0,
      br[0], br[1], uv.u1, uv.v1,
      tl[0], tl[1], uv.u0, uv.v0,
      br[0], br[1], uv.u1, uv.v1,
      bl[0], bl[1], uv.u0, uv.v1,
    ])

    gl.useProgram(layerProg)
    gl.bindVertexArray(layerVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(layerLoc.aPos)
    gl.vertexAttribPointer(layerLoc.aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(layerLoc.aUV)
    gl.vertexAttribPointer(layerLoc.aUV, 2, gl.FLOAT, false, 16, 8)

    gl.uniform2f(layerLoc.uFrame, frameW, frameH)
    gl.uniform1i(layerLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1f(layerLoc.uOpacity, clamp01(layer.opacity))
    gl.uniform1f(layerLoc.uBrightness, layer.filters.brightness)
    gl.uniform1f(layerLoc.uContrast, layer.filters.contrast)
    gl.uniform1f(layerLoc.uSaturation, layer.filters.saturation)
    gl.uniform1f(layerLoc.uExposure, layer.filters.exposure)
    gl.uniform4f(layerLoc.uUVRect, uv.u0, uv.v0, uv.u1, uv.v1)
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

  // Composite one layer op, isolated in its own FBO so per-layer blur doesn't
  // bleed into siblings, then alpha-over onto the target framebuffer.
  function compositeLayer(
    layer: RenderLayer,
    source: TexImageSource,
    frameW: number,
    frameH: number,
    targetFb: WebGLFramebuffer | null,
    layerFbo: Fbo,
    scratch: Fbo,
  ): void {
    const blur = layer.filters.blur
    if (blur > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layerFbo.fb)
      gl.viewport(0, 0, fboW, fboH)
      gl.disable(gl.BLEND)
      clear(0, 0, 0, 0)
      // Blend within the layer FBO with premultiplied over onto transparent.
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      drawLayer(layer, source, frameW, frameH)
      blurFbo(layerFbo, scratch, blur)
      // Blit blurred premultiplied layer onto the target, over.
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      blitFbo(layerFbo)
    } else {
      // Fast path: draw straight onto the target with premultiplied over.
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      drawLayer(layer, source, frameW, frameH)
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
    clear(0, 0, 0, 1) // opaque black base so dips/wipes read against black
    if (!source) return
    compositeLayer(layer, source, frameW, frameH, dst.fb, layerFbo, scratch)
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

    // Combine into the default framebuffer (the visible/target canvas).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
    gl.disable(gl.BLEND) // sides are already composited; combine replaces pixels
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
    gl.deleteProgram(layerProg)
    gl.deleteProgram(blurProg)
    gl.deleteProgram(combineProg)
    gl.deleteProgram(blitProg)
    gl.deleteBuffer(layerVbo)
    gl.deleteBuffer(fullVbo)
    gl.deleteVertexArray(layerVao)
    gl.deleteVertexArray(fullVao)
    gl.deleteTexture(srcTex)
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
