// The ONE shared WebGL2 renderer. Runs unchanged in a main-thread <canvas>
// context (preview) and a worker OffscreenCanvas context (export), so it never
// touches document/window and takes the GL context from the caller. Given a
// RenderFrame (pure, from resolve.ts) and a TextureSource, it draws pixel-
// identical output in both places. This file is the sole engine exception that
// touches GL; all transform math lives in the pure, unit-tested mat.ts.

import { getEffect, stackSignature } from '../effects/registry'
import { computeQuad, cropUV, quadScale } from './mat'
import { deriveMotionBlur, quadCentre, quadRadius } from './motionBlur'
import type { RenderFrame, RenderLayer, RenderOp, ResolvedEffect, TextureSource, TransitionKind } from './types'

export interface Renderer {
  render(frame: RenderFrame, tex: TextureSource): void
  dispose(): void
}

// Blur radius is bounded so a wild keyframe can't request thousands of taps.
const MAX_BLUR_PX = 64

/**
 * Rasters that get the output dither (below): HD and up, exactly the gate
 * `isHdRaster` in export/messages.ts draws, which dither.test.ts pins so the two
 * cannot drift. Sub-HD stays on the untouched legacy path for the same reason
 * `mipmapSources` does, so the golden 640x360 export keeps its exact bytes.
 *
 * The gate is read from the FRAME rather than taken as a RendererOptions flag,
 * because the preview caches one renderer per canvas across sequence-format
 * changes; a flag fixed at construction would go stale the moment he switches a
 * project from 640x360 to 1080x1920, and preview would stop matching export.
 */
export function ditherRaster(width: number, height: number): boolean {
  return height >= 720 || width >= 1280
}

/**
 * The on-screen scale above which a layer switches from plain bilinear
 * magnification to the bicubic path in the layer shader.
 *
 * It is 1.0 plus a hair. At exactly 1.0 the destination pixels land on the
 * source texel centres, where every resampler returns the same texel and there
 * is nothing to recover, so the identity case stays on the byte-stable LINEAR
 * path. The hair keeps a keyframed zoom that hovers around 1.0 (and float noise
 * in the quad arithmetic) from flickering between the two, which costs nothing
 * to allow because the two filters are indistinguishable down there anyway.
 */
export const BICUBIC_MIN_SCALE = 1.001

/**
 * Does this layer take the bicubic (Catmull-Rom) magnification path? Two gates,
 * and both must pass.
 *
 *   MAGNIFYING  the layer covers more destination pixels than it has source
 *               texels. At or below 1:1 there is nothing a better resampler can
 *               recover, and staying on LINEAR there is what keeps an
 *               unmagnified export byte-identical to the one before this
 *               existed.
 *
 *   HD AND UP   the same fence `ditherRaster` draws, and deliberately the SAME
 *               FUNCTION rather than a second copy of one rule: the golden
 *               640x360 export must keep its exact legacy bytes, so every
 *               quality behaviour in this file hangs off one gate.
 *
 * Read from the FRAME on every draw for the same reason the dither is: the
 * preview keeps one renderer per canvas across sequence-format changes, and a
 * flag fixed at construction would go stale the moment he switches a project
 * from 640x360 to 1080x1920.
 */
export function bicubicLayer(scale: number, frameW: number, frameH: number): boolean {
  return scale > BICUBIC_MIN_SCALE && ditherRaster(frameW, frameH)
}

/**
 * The resolver frame index for this frame. Every op in a frame carries the same
 * one (resolve.ts derives it from t and fps once), so the first op answers for
 * all of them. It seeds the dither, which is why it has to come from the frame
 * and not from a counter: a re-render of the same timecode must produce the same
 * noise, or preview and export would disagree and a paused scrub would crawl.
 */
export function frameSeedOf(ops: readonly RenderOp[]): number {
  const op = ops[0]
  if (!op) return 0
  if (op.type === 'layer') return op.layer.frameSeed
  if (op.type === 'transition') return op.from.frameSeed
  return op.frameSeed
}

/**
 * Where a transition may sit when one of its sides has NO PICTURE AT ALL.
 *
 * ⛔ A MISSING SIDE IS NOT A TRANSPARENT SIDE, and the combine shader cannot
 * tell them apart. Both sides are premultiplied, so a cross dissolve weights
 * `mix(from, to, p)`: against a side that is genuinely see-through (a scaled PIP
 * over a background) that is right and lets the lower tracks through. Against a
 * side with no texture it means the picture we DO have is scaled by (1-p), which
 * on the frame reads as a fade to BLACK.
 *
 * That is not theoretical. `preview.ts` guards both sides of a live pair
 * transition: a side that cannot prove it is showing its own frame is served its
 * last confident frame instead. A side that has never had one yet has nothing to
 * hold, so it resolves to null, and on 2026-08-12 his ship gate caught exactly
 * that: rgb(0,29,0) decaying to (0,11,0) across a dissolve whose incoming clip
 * was still cold. It reproduced under load and not on a quiet machine, so the
 * hole is real and only its timing is luck.
 *
 * So the rule is the same one the held frames already state, carried to the case
 * where there is nothing held: **a transition never weights toward a side that
 * has no picture.** It waits at the last point it can honestly draw and moves on
 * the moment the picture arrives, which is a fraction of a second later and
 * invisible next to a black flash.
 *
 * Kind-agnostic on purpose. A dip whose incoming side is cold holds before the
 * dip rather than dipping into a hole it cannot come out of, and a wipe holds
 * its edge, with no per-kind rule to keep in step.
 *
 * It cannot mask a broken transition: the same spec asserts that at least one
 * frame carries BOTH clips, so a side that never arrives still fails, on the
 * assertion that means it.
 *
 * ⛔ `isPair` IS NOT OPTIONAL, and the gate is why it exists. The first cut of
 * this applied to every transition, and `a lone Dip to White dips through WHITE,
 * not through black` went red. **A lone edge has no second clip on purpose**:
 * `from` and `to` are the same clip, one side is a stand-in, and its empty side
 * is what the dip solid is weighted against, not a picture we failed to prove.
 * Forcing progress to an end there deletes the dip.
 *
 * That boundary is not a new one. `preview.ts` builds `transitionSides` for PAIR
 * transitions only and skips lone edges and whiteFlash stand-ins, so a guarded
 * null can only ever happen on a pair. **This is the same line drawn in the same
 * place**, and drawing it anywhere else breaks a transition that works.
 */
export function progressWithSides(
  progress: number,
  hasFrom: boolean,
  hasTo: boolean,
  isPair: boolean,
): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress
  // A lone edge or a stand-in: an empty side is the design, not a missing frame.
  if (!isPair) return p
  // Nothing either way: no picture to protect, so leave the frame as resolved.
  if (hasFrom === hasTo) return p
  return hasFrom ? 0 : 1
}

// --- Shaders ---------------------------------------------------------------

// OUTPUT DITHER. The whole composite runs at 8 bits, so every value the shaders
// INVENT rather than inherit (an opacity fade, a cross dissolve, a blur, a glow,
// a dip to black) is a smooth ramp getting rounded to 8 bits with nothing to
// break up the contour, which is exactly how banding is made. This is loss the
// app introduces, not loss that came in with his footage, and no encoder setting
// can put it back. A triangular-PDF dither added to the value that is ABOUT to
// be rounded turns the contour into noise the eye reads as the ramp it was.
//
// MEASURED on his RTX 4060 with _verify/quality.mjs, the faded row (the same
// dark ramp put through a 0.42 opacity fade, which is the app inventing values):
// worst flat run 202 px to 110 px, and the MEAN worst run per row 202.0 px to
// 73.2 px, against a floor of 68 px which is the source ramp's own banding. So
// the average row now bands within 5 px of the source it came from, where before
// it banded three times as wide. The 1:1 rows do not move and cannot: they are
// already on codes. Encoded cost, same GPU, through the exact ffmpeg call
// electron/exportArgs.ts builds (x264 veryslow, crf 14, 1080x1920, 30 frames):
// his real operation, 1920x1080 cover-magnified with a dip to black, went
// 718230 to 716983 bytes, which is 0.17% SMALLER, since the contours the dither
// breaks up were costing more to describe than the noise costs. A synthetic
// all-gradient clip, the worst case a dither can have, went 19176 to 192696
// bytes: ten times, but of almost nothing, and about 1.4 Mbit/s at this raster.
//
// Half a code, and ONLY on channels that are not already sitting on one.
//
// That second half is not a nicety, it is measured. Amplitude alone was not
// enough: on an RTX 4060 a plain plus/minus-half-a-code dither took the harness's
// 1:1 geometry control from 100.000% bit-identical to 99.922%, because the GPU's
// float-to-unorm8 conversion does not round a value float32 cannot hold exactly
// the way the arithmetic says it should. Trimming the amplitude to 0.49 only got
// 99.948% back and cost banding (worst flat run 110 px to 117 px), so the
// amplitude stayed and ditherPm() skips on-code channels instead. That restores
// 100.000% / Infinity dB on the control while keeping the whole banding win.
//
// Widening every intermediate framebuffer to RGBA16F would fix the intermediate
// roundings too, but it costs real preview time; this costs two hashes on the one
// pass that writes the frame he actually keeps.
//
// Deterministic by construction: a pure function of gl_FragCoord and uSeed (the
// resolver frame index), so preview and export generate identical noise, which
// is the invariant the shared renderer exists to protect.
const DITHER_GLSL = `
float ditherTpdf(vec2 p, float seed) {
  vec2 q = p + fract(seed * 0.0173) * 131.0;
  float r1 = fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453);
  float r2 = fract(sin(dot(q, vec2(63.7264, 10.873))) * 24634.6345);
  return (r1 - r2) * (0.5 / 255.0);
}

// Dither a PREMULTIPLIED rgb. Clamped back into [0, a] so anything that samples
// this later still sees a valid premultiplied pixel. \`on\` is 0 on every pass
// that writes an intermediate FBO, and the early return makes those passes the
// byte-for-byte copy they were before.
//
// ON-CODE PIXELS ARE LEFT ALONE, which is the whole reason this is safe. A
// channel already sitting on an 8-bit code is a value the pipeline carried
// through EXACTLY, and noise there can only take back something it got right;
// it is also, by definition, not banding, since banding is what happens to the
// values BETWEEN codes. The tolerance is a 4096th of a code, far above the
// float32 error in n/255*255 (about a 65000th) and far below any invented ramp.
vec3 ditherPm(vec3 pm, float a, float on, vec2 p, float seed) {
  if (on == 0.0) return pm;
  vec3 code = pm * 255.0;
  vec3 offCode = step(vec3(1.0 / 4096.0), abs(code - floor(code + 0.5)));
  return clamp(pm + ditherTpdf(p, seed) * offCode, vec3(0.0), vec3(a));
}
`

// BICUBIC MAGNIFICATION, for layers drawn LARGER than their source.
//
// gl.TEXTURE_MAG_FILTER = gl.LINEAR is two taps per axis, the softest resampler
// there is, and it was what every magnified layer went through. His single most
// common operation is cutting a vertical short from 1920x1080 footage, which
// magnifies the source about 1.78x to fill a 1080x1920 frame (the note in
// export/exportPlan.ts states the same figure). The softening happened BEFORE
// the encoder ever saw a pixel, so no encoder setting could put it back.
//
// MEASURED on his RTX 4060 with _verify/quality.mjs, at exactly that 1.7778x:
// the old path matched a CPU bilinear model to 56.30 dB, which is rounding, so
// it was PROVABLY plain bilinear and not a guess; against a lanczos-3 resample
// of the identical crop it sat at 21.71 dB / 0.9571 SSIM and kept 76.7% of the
// reference's local contrast.
//
// Catmull-Rom is cubic convolution with a = -0.5 over a 4x4 neighbourhood:
// sharper transitions than bilinear, and a small deliberate overshoot at an edge
// that the eye reads as retained detail.
//
// THE OVERSHOOT IS ALSO ITS ONE DANGER. On a hard edge Catmull-Rom rings, and a
// ring around every caption border would be a new defect, not a fix. So the
// result is CLAMPED to the range of the four texels plain bilinear would have
// read. Inside that box the filter is free to be sharper; outside it, it cannot
// invent a halo. That box is the honest bound: it is exactly the interval the
// old filter's answer was already guaranteed to lie in.
//
// Taps are texelFetch, not texture(): they have to be the raw texels, not what
// the LINEAR filter or the mip chain would hand back. Level 0 is the right level
// by construction, because this path only ever runs when the layer is MAGNIFIED,
// which is precisely when level 0 is the level GL would pick anyway.
//
// Taps are clamped into the layer's own CROP window rather than into the whole
// texture, so a cropped clip cannot pull the pixels the crop removed back in
// along its border. Plain bilinear could not reach them; neither can this.
const BICUBIC_GLSL = `
vec4 olpTap(sampler2D tex, vec2 p, vec2 lo, vec2 hi) {
  return texelFetch(tex, ivec2(clamp(p, lo, hi)), 0);
}

vec4 olpBicubic(sampler2D tex, vec2 uv, vec4 rect) {
  vec2 size = vec2(textureSize(tex, 0));
  vec2 lo = clamp(floor(rect.xy * size), vec2(0.0), size - 1.0);
  vec2 hi = clamp(ceil(rect.zw * size) - 1.0, lo, size - 1.0);

  // Texel i is centred at i + 0.5, so the sample sits at uv*size - 0.5 in index
  // space and the 4x4 neighbourhood starts one texel before floor(that). Get
  // this half-pixel wrong and the filter is measuring the mistake.
  vec2 pos = uv * size - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;

  // Cubic convolution, a = -0.5, at offsets -1, 0, 1, 2. The four weights sum to
  // exactly 1 for every f, so a flat area stays flat and the 1:1 case is a copy.
  vec4 wx = vec4(
    f.x * (-0.5 + f.x * (1.0 - 0.5 * f.x)),
    1.0 + f.x * f.x * (-2.5 + 1.5 * f.x),
    f.x * (0.5 + f.x * (2.0 - 1.5 * f.x)),
    f.x * f.x * (-0.5 + 0.5 * f.x));
  vec4 wy = vec4(
    f.y * (-0.5 + f.y * (1.0 - 0.5 * f.y)),
    1.0 + f.y * f.y * (-2.5 + 1.5 * f.y),
    f.y * (0.5 + f.y * (2.0 - 1.5 * f.y)),
    f.y * f.y * (-0.5 + 0.5 * f.y));

  // The bounds start inverted and the four centre taps always replace them,
  // because an 8-bit texture's samples are in [0, 1] by definition.
  vec4 acc = vec4(0.0);
  vec4 lom = vec4(1.0);
  vec4 him = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 row = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      vec4 s = olpTap(tex, base + vec2(float(i) - 1.0, float(j) - 1.0), lo, hi);
      row += s * wx[i];
      // The centre 2x2 is exactly the footprint plain bilinear reads, and
      // clamping to its range is what stops the ringing becoming a halo. Both
      // loop counters are the same for every fragment in the draw, so this
      // branch costs nothing: it folds away when the compiler unrolls.
      if (i > 0 && i < 3 && j > 0 && j < 3) {
        lom = min(lom, s);
        him = max(him, s);
      }
    }
    acc += row * wy[j];
  }
  return clamp(acc, lom, him);
}
`

// Positions arrive already in seq-space px; the vertex shader projects them to
// clip space with origin top-left, y DOWN, matching the 2D-canvas convention.
const LAYER_VS = `#version 300 es
precision highp float;
in vec2 aPos;   // seq-space pixels
in vec2 aUV;
uniform vec2 uFrame; // frame width,height in px
out vec2 vUV;
// The same position in SEQ PX, so the fragment stage can clip to a rectangle
// given in sequence coordinates. gl_FragCoord would be in TARGET px, which is
// the canvas on the preview and the export size in the worker, so a box
// expressed against it would land in a different place on each.
out vec2 vSeqPos;
void main() {
  vec2 clip = vec2(aPos.x / uFrame.x * 2.0 - 1.0, 1.0 - aPos.y / uFrame.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV;
  vSeqPos = aPos;
}`

/** Uniform name for one param of the effect sitting at stack index `i`. */
const uniformName = (i: number, key: string): string => `u_fx${i}_${key}`

/**
 * Build the per-layer fragment shader for one POINTWISE effect stack. Each
 * effect's GLSL body is concatenated in stack order inside its own block scope,
 * so two instances of the same effect cannot collide on a local name; their
 * uniforms are indexed, so they cannot collide either.
 *
 * An empty stack yields the identity shader, which is exactly what the old
 * monolithic LAYER_FS computed when every filter sat at 0. Output is
 * PREMULTIPLIED alpha so the alpha-OVER blend (ONE, ONE_MINUS_SRC_ALPHA)
 * composites correctly.
 *
 * `bicubic` swaps the ONE source fetch for the clamped Catmull-Rom above and is
 * compiled as its own variant, so a layer that is not magnified never carries
 * the 16 taps in its program at all, not even behind a branch.
 */
function buildLayerFs(pointwise: readonly ResolvedEffect[], withMask: boolean, bicubic: boolean): string {
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
  // mask. Unmasked layers keep the identity shader.
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
in vec2 vSeqPos;
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec4 uUVRect; // u0,v0,u1,v1 (reject samples outside the crop window)
// x,y,w,h in seq px of the inner content box, or w<=0 for "the whole frame".
// A layer laid out inside a smaller box must not draw outside it: a keyframed
// zoom past 1 would otherwise spill the picture into the bands and the nested
// ratio would look like a bug rather than a frame.
uniform vec4 uContentBox;
uniform vec2 uFrame;  // frame width,height in px (shared with the VS)
uniform float uSeed;  // resolver frame index: animates stochastic effects (grain)
uniform float uDither; // 1 only when this draw writes the frame's final 8-bit target
${maskDecls}
${decls.join('\n')}
${DITHER_GLSL}
${bicubic ? BICUBIC_GLSL : ''}
out vec4 outColor;
void main() {
  if (vUV.x < uUVRect.x || vUV.x > uUVRect.z || vUV.y < uUVRect.y || vUV.y > uUVRect.w) {
    outColor = vec4(0.0);
    return;
  }
  // Uniform branch, so it costs nothing on any real GPU when the box is off.
  if (uContentBox.z > 0.0 &&
      (vSeqPos.x < uContentBox.x || vSeqPos.x > uContentBox.x + uContentBox.z ||
       vSeqPos.y < uContentBox.y || vSeqPos.y > uContentBox.y + uContentBox.w)) {
    outColor = vec4(0.0);
    return;
  }
  vec4 src = ${bicubic ? 'olpBicubic(uTex, vUV, uUVRect)' : 'texture(uTex, vUV)'};
  vec3 c = src.rgb;
  float a = src.a * uOpacity;
${maskBody}
${bodies.join('\n')}
  c = clamp(c, 0.0, 1.0);
  // Premultiply FIRST, then dither: the noise has to sit on the number the
  // framebuffer is about to round, not on the straight colour behind it.
  outColor = vec4(ditherPm(c * a, a, uDither, gl_FragCoord.xy, uSeed), a);
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
// uDither is 1 only on the two blits that land on the frame's final target (the
// effected-layer composite and the adjustment accumulator); the scratch bounces
// inside sharpen and glow pass 0 and stay the exact copy they always were.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uSeed;
uniform float uDither;
${DITHER_GLSL}
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  outColor = vec4(ditherPm(c.rgb, c.a, uDither, gl_FragCoord.xy, uSeed), c.a);
}`

// Unsharp mask: centre minus a 4-tap cross average = high-pass, scaled back in.
// Premultiplied in/out; rgb clamped to alpha so the result stays valid premult.
// Camera shutter smear, integrated along the path the picture actually travelled.
// The numbers come from engine/render/motionBlur.ts, never from him.
//
// ⛔ A BOX, NOT A GAUSSIAN, and that is the physics rather than a preference. A
// shutter is open for one interval and every instant inside it contributes equally,
// so the samples are averaged flat. The gaussian in BLUR_FS is right for a lens
// defocus and wrong for a move; using it here would give a soft halo instead of a
// streak.
//
// ⛔ AND IT IS CENTRED ON THE FRAME, f running from -0.5 to +0.5. Integrating only
// forwards drags the picture half a shutter behind where his keyframe says it is,
// which on a fast punch reads as the move lagging his music. Centring keeps the
// apparent position exactly where he put it, which is also what After Effects does
// with its default shutter phase.
//
// Both terms in ONE pass because the shutter opens once: the picture slides and
// grows over the same interval, so undoing both per sample is truer than stacking a
// sideways blur on top of a zoom blur, and it costs one pass instead of three.
const MAX_SMEAR_TAPS = 24
const MOTION_SMEAR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uOffset;  // travel over one shutter, in UV
uniform float uZoom;   // radius growth over one shutter, as a fraction
uniform vec2 uCenter;  // the quad's centre, in UV
uniform int uTaps;
out vec4 outColor;
void main() {
  int taps = uTaps;
  if (taps < 1) { outColor = texture(uTex, vUV); return; }
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i <= ${MAX_SMEAR_TAPS}; i++) {
    if (i > taps) break;
    float f = float(i) / float(taps) - 0.5;
    vec2 pos = vUV - uOffset * f;
    // Undo the growth about the centre. 1 + zoom*f, so a positive zoom (a punch in)
    // pulls samples back TOWARDS the centre, which is what streaks the edges.
    float g = 1.0 + uZoom * f;
    pos = uCenter + (pos - uCenter) / max(g, 0.0001);
    sum += texture(uTex, pos);
    wsum += 1.0;
  }
  outColor = sum / wsum;
}`

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
uniform int uMode; // 0 = overlay, 1 = soft light, 2 = inverted backdrop
uniform float uSeed;
uniform float uDither;
${DITHER_GLSL}
out vec4 outColor;
void main() {
  vec4 dst = texture(uDst, vUV);
  vec4 src = texture(uSrc, vUV);
  vec3 d = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 b;
  if (uMode == 0) {
    b = mix(2.0 * d * s, 1.0 - 2.0 * (1.0 - d) * (1.0 - s), step(0.5, d));
  } else if (uMode == 1) {
    vec3 dd = mix(((16.0 * d - 12.0) * d + 4.0) * d, sqrt(d), step(0.25, d));
    b = mix(d - (1.0 - 2.0 * s) * d * (1.0 - d), d + (2.0 * s - 1.0) * (dd - d), step(0.5, s));
  } else {
    // INVERTED BACKDROP. s is deliberately unused: the source is a coverage
    // stencil and the only thing that reaches the frame is 1 - backdrop, carried
    // by the glyph's alpha through the mix below.
    //
    // THE EDGES ARE WHY THIS RUNS HERE AND NOT AS A gl.blendFunc.
    // outRgb = mix(d, b, src.a) interpolates between the backdrop and its OWN
    // inverse and nothing else, so an antialiased glyph pixel at a = 0.5 lands on
    // exactly 0.5 grey over any backdrop and a colour fringe is not
    // representable. A fixed-function ONE_MINUS_DST_COLOR blend reads the
    // source's premultiplied RGB instead of its coverage and fringes on every
    // edge as soon as the fill is not pure white.
    b = vec3(1.0) - d;
  }
  vec3 outRgb = mix(d, b, src.a);
  float outA = clamp(dst.a + src.a * (1.0 - dst.a), 0.0, 1.0);
  outColor = vec4(ditherPm(outRgb * outA, outA, uDither, gl_FragCoord.xy, uSeed), outA);
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
export const SPIN = {
  /** Peak rotation of either side, radians. 0.5 (28 degrees) did not register at speed. */
  angleRad: 0.6,
  /** Extra zoom at peak rotation, as a fraction (1.0 = up to 2x). */
  punch: 1.1,
}

/**
 * Zoom needed for a rotated frame to still cover the frame it is drawn into.
 * Rotating a w x h rectangle by `angle` leaves triangular gaps at the corners;
 * the gaps are what "streaking" is (the sampler clamps and smears the edge
 * pixels into them). A spin is only honest if SPIN.punch covers this at the
 * worst moment, which is the midpoint (see the unit test).
 */
export function spinCoverScale(angleRad: number, aspect: number): number {
  const c = Math.abs(Math.cos(angleRad))
  const s = Math.abs(Math.sin(angleRad))
  const w = Math.max(aspect, 1e-4)
  return Math.max((c * w + s) / w, s * w + c)
}

const COMBINE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform int uKind;   // index into TransitionKind order
uniform float uSoft; // edge softness in UV for wipes
uniform float uSeed; // resolver frame index, animates the glitch slices
uniform float uAspect; // frame w/h, because spin must rotate in ASPECT space or it shears
uniform float uDither; // 1 only when the combine writes the frame's final 8-bit target
${DITHER_GLSL}
out vec4 outColor;

// The dip solid is weighted by LOCAL COVERAGE. Both sides are premultiplied and
// transparent wherever their clips do not cover the frame (renderSideToFbo clears
// to transparent so a transition on an upper track lets lower tracks show
// through). An unweighted vec4(col, 1.0) was opaque across the WHOLE frame, so a
// dip on a scaled PIP blacked out the full-frame background under it. A
// full-frame clip has alpha 1 everywhere, so its dip is unchanged.
vec4 dip(vec4 from, vec4 to, float p, vec3 col) {
  vec4 solid = vec4(col, 1.0) * max(from.a, to.a);
  if (p < 0.5) return mix(from, solid, clamp(p * 2.0, 0.0, 1.0));
  return mix(solid, to, clamp((p - 0.5) * 2.0, 0.0, 1.0));
}

/** Premultiplied sample as straight colour. Fully transparent stays black. */
vec3 straight(vec4 s) {
  return s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
}

/**
 * The glitch RGB split: red pulled one way, blue the other, green and alpha
 * from the pixel being drawn. Done in STRAIGHT colour and re-premultiplied by
 * that pixel's own alpha, so the three channels can never carry three different
 * alphas into one premultiplied result.
 */
vec4 splitSample(sampler2D tex, vec2 uv, vec2 split) {
  vec4 mid = texture(tex, uv);
  vec3 c = vec3(
    straight(texture(tex, clamp(uv + split, 0.0, 1.0))).r,
    straight(mid).g,
    straight(texture(tex, clamp(uv - split, 0.0, 1.0))).b
  );
  return vec4(c * mid.a, mid.a);
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
  } else if (uKind == 5) {     // slideLeft: TO pushes in from the right
    // Eased, not linear: a constant-velocity push starts and stops dead, which
    // is the single thing that makes a move read as machinery instead of craft.
    float lp = smoothstep(0.0, 1.0, p);
    vec2 fromUV = vec2(vUV.x + lp, vUV.y);
    vec2 toUV = vec2(vUV.x - (1.0 - lp), vUV.y);
    vec4 f = (fromUV.x <= 1.0) ? texture(uFrom, fromUV) : vec4(0.0);
    vec4 t = (toUV.x >= 0.0) ? texture(uTo, toUV) : vec4(0.0);
    col = (toUV.x >= 0.0) ? t : f;
  } else if (uKind == 6) {     // slideRight: TO pushes in from the left
    float rp = smoothstep(0.0, 1.0, p);
    vec2 fromUV = vec2(vUV.x - rp, vUV.y);
    vec2 toUV = vec2(vUV.x + (1.0 - rp), vUV.y);
    vec4 f = (fromUV.x >= 0.0) ? texture(uFrom, fromUV) : vec4(0.0);
    vec4 t = (toUV.x <= 1.0) ? texture(uTo, toUV) : vec4(0.0);
    col = (toUV.x <= 1.0) ? t : f;
  } else if (uKind == 7) {     // zoom: FROM punches in while TO settles from a deeper punch
    float zp = smoothstep(0.0, 1.0, p);
    vec2 ctr = vec2(0.5);
    vec2 fromUV = ctr + (vUV - ctr) / (1.0 + 0.6 * zp);
    vec2 toUV = ctr + (vUV - ctr) * (1.0 + 0.4 * (1.0 - zp));
    vec4 f = texture(uFrom, fromUV);
    // TO starts SHRUNK, so early in the transition its sample lands outside the
    // frame all the way round. Falling back to transparent black there mixed a
    // dark ring into all four edges; falling back to FROM means the incoming
    // shot punches in OVER the outgoing one, which is what a cross zoom is. The
    // ring closes on its own: at p=1 toUV == vUV, so nothing is out of range.
    bool tin = toUV.x >= 0.0 && toUV.x <= 1.0 && toUV.y >= 0.0 && toUV.y <= 1.0;
    vec4 t = tin ? texture(uTo, toUV) : f;
    col = mix(f, t, zp);
  } else if (uKind == 8) {     // spin: whip-rotate FROM out while TO rotates in, both punched
    float sp = smoothstep(0.0, 1.0, p);
    vec2 ctr = vec2(0.5);
    // Two constants decide whether this reads as a whip or a wobble, and they
    // are NOT independent: the punch has to cover the rotation or the corners it
    // exposes streak. Both live in SPIN above, where spinCoverScale + its unit
    // test hold them to that relationship.
    float angF = sp * ${SPIN.angleRad.toFixed(4)};
    float angT = (sp - 1.0) * ${SPIN.angleRad.toFixed(4)};
    // Rotate in aspect-corrected space: UV units are anisotropic on non-square
    // frames, so a raw UV rotation is a shear, not a rigid spin.
    float asp = max(uAspect, 1e-4);
    vec2 dF = (vUV - ctr) * vec2(asp, 1.0);
    vec2 rF = vec2(dF.x * cos(angF) - dF.y * sin(angF), dF.x * sin(angF) + dF.y * cos(angF));
    vec2 rT = vec2(dF.x * cos(angT) - dF.y * sin(angT), dF.x * sin(angT) + dF.y * cos(angT));
    vec4 f = texture(uFrom, ctr + (rF / (1.0 + ${SPIN.punch.toFixed(4)} * sp)) * vec2(1.0 / asp, 1.0));
    vec4 t = texture(uTo, ctr + (rT / (1.0 + ${SPIN.punch.toFixed(4)} * (1.0 - sp))) * vec2(1.0 / asp, 1.0));
    col = mix(f, t, sp);
  } else if (uKind == 9) {     // glitch: sliced displacement + RGB split, peaking mid-cut
    float gi = p * (1.0 - p) * 4.0;
    float band = floor(vUV.y * 24.0);
    float rnd = fract(sin(band * 91.17 + uSeed * 13.7) * 43758.5453);
    float rnd2 = fract(sin(band * 41.3 + uSeed * 7.3) * 22578.145);
    float shift = (rnd - 0.5) * 0.2 * gi * step(0.6, rnd2);
    vec2 gUV = vec2(clamp(vUV.x + shift, 0.0, 1.0), vUV.y);
    vec2 split = vec2(0.008 * gi, 0.0);
    // Glitch is the one kind that HARD-SWITCHES sides at the midpoint instead of
    // blending, so on a lone edge (where one side is deliberately empty) that
    // switch used to hand back a transparent frame for half the window. Falling
    // back per pixel keeps the hard cut between two real clips and keeps the
    // picture on screen when there is only one.
    // The RGB split takes each channel from a DIFFERENT pixel, and these
    // textures are PREMULTIPLIED, so a channel carries its own pixel's alpha
    // baked in. Taking r from one pixel and a from another mixed two alphas
    // into one colour: on a masked or faded clip the split fringe went black
    // where the offset pixel was transparent, and could exceed its own alpha
    // where it was not, which is not a valid premultiplied colour at all.
    // Unpremultiply each sample, split in straight colour, then re-premultiply
    // by the alpha of the pixel actually being drawn.
    vec4 gf = splitSample(uFrom, gUV, split);
    vec4 gt = splitSample(uTo, gUV, split);
    if (p < 0.5) {
      col = gf.a > 0.0 ? gf : gt;
    } else {
      col = gt.a > 0.0 ? gt : gf;
    }
  } else if (uKind == 10) {    // lumaWipe: TO reveals through FROM's darks first
    float soft = 0.08;
    float luma = dot(from.rgb, vec3(0.2126, 0.7152, 0.0722));
    float pp = p * (1.0 + 2.0 * soft) - soft;
    float m = smoothstep(luma - soft, luma + soft, pp);
    col = mix(from, to, m);
  } else {                     // whiteFlash: hard white at p=0, ease-out resolve to TO.
    // (1-p)^2 has its steepest decay at p=0 (rate 2) and lands at 0 with zero
    // slope. The flash pops full white then quickly settles into the footage.
    // FROM is deliberately ignored: this is an intro hit, not a blend.
    float a = (1.0 - p) * (1.0 - p);
    // Coverage-weighted for the same reason as dip(): a white flash on a title or
    // PIP must flash THAT clip, not blow the whole frame white.
    col = mix(to, vec4(1.0) * max(from.a, to.a), a);
  }
  // A dissolve, a dip and a whiteFlash are all ramps this shader invented, so
  // this is the single biggest source of app-made banding in the whole path.
  outColor = vec4(ditherPm(col.rgb, col.a, uDither, gl_FragCoord.xy, uSeed), col.a);
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
  whiteFlash: 11,
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
  uContentBox: WebGLUniformLocation | null
  uSeed: WebGLUniformLocation | null
  uDither: WebGLUniformLocation | null
  /** Mask uniforms, present only on the masked variant of a stack program. */
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

export interface RendererOptions {
  /**
   * Mipmapped minification for SOURCE textures (video frames, stills, title
   * rasters). Plain LINEAR minification only ever reads FOUR texels, so
   * shrinking a 4K source into a 1080 frame throws away nearly everything in
   * between and what survives aliases: shimmering edges, crawling detail.
   *
   * The preview has always set this, because it samples down 3-6x to the panel.
   * **The EXPORT did not, so the file he actually publishes was the one aliasing
   * while the preview next to it looked clean.** That was the "export softness"
   * he kept reporting. It is now on for HD and above, which also keeps the
   * preview and the export reading the same texels, the governing invariant.
   *
   * Gated on HD by the caller, following the same convention as every other
   * quality behaviour here: the golden export is 640x360, so it stays on the
   * exact legacy LINEAR path and its bytes do not move.
   *
   * WebGL2 supports NPOT mipmaps as long as wrap stays CLAMP_TO_EDGE.
   */
  mipmapSources?: boolean
}

export function createRenderer(gl: WebGL2RenderingContext, options?: RendererOptions): Renderer {
  const mipmapSources = options?.mipmapSources === true
  // Programs (thrown from here on failure so the caller can fall back).
  const blurProg = link(gl, FULL_VS, BLUR_FS)
  const combineProg = link(gl, FULL_VS, COMBINE_FS)
  const blitProg = link(gl, FULL_VS, BLIT_FS)
  const sharpenProg = link(gl, FULL_VS, SHARPEN_FS)
  const smearProg = link(gl, FULL_VS, MOTION_SMEAR_FS)
  const glowProg = link(gl, FULL_VS, GLOW_FS)
  const blendModeProg = link(gl, FULL_VS, BLENDMODE_FS)

  // One layer program per distinct pointwise stack SHAPE (types + order, not
  // values), compiled on first sight and reused thereafter. A project with no
  // effects compiles exactly one identity program; adding a saturation to one
  // clip compiles a second. Bounded by the number of distinct stacks in use.
  const layerPrograms = new Map<string, LayerProgram>()

  function getLayerProgram(
    pointwise: readonly ResolvedEffect[],
    withMask: boolean,
    bicubic: boolean,
  ): LayerProgram {
    // Masked layers compile their own variant of the stack program, because an
    // unmasked identity clip must never pay for mask uniforms it doesn't have.
    // Magnified layers do the same with the bicubic fetch, for the same reason.
    const key = stackSignature(pointwise) + (withMask ? '#mask' : '') + (bicubic ? '#bicubic' : '')
    const hit = layerPrograms.get(key)
    if (hit) return hit
    const prog = link(gl, LAYER_VS, buildLayerFs(pointwise, withMask, bicubic))
    const entry: LayerProgram = {
      prog,
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      uFrame: gl.getUniformLocation(prog, 'uFrame'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uOpacity: gl.getUniformLocation(prog, 'uOpacity'),
      uUVRect: gl.getUniformLocation(prog, 'uUVRect'),
      uContentBox: gl.getUniformLocation(prog, 'uContentBox'),
      uSeed: gl.getUniformLocation(prog, 'uSeed'),
      uDither: gl.getUniformLocation(prog, 'uDither'),
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
    uAspect: gl.getUniformLocation(combineProg, 'uAspect'),
    uDither: gl.getUniformLocation(combineProg, 'uDither'),
  }
  const blitLoc = {
    aPos: gl.getAttribLocation(blitProg, 'aPos'),
    uTex: gl.getUniformLocation(blitProg, 'uTex'),
    uSeed: gl.getUniformLocation(blitProg, 'uSeed'),
    uDither: gl.getUniformLocation(blitProg, 'uDither'),
  }
  const sharpenLoc = {
    aPos: gl.getAttribLocation(sharpenProg, 'aPos'),
    uTex: gl.getUniformLocation(sharpenProg, 'uTex'),
    uTexel: gl.getUniformLocation(sharpenProg, 'uTexel'),
    uAmount: gl.getUniformLocation(sharpenProg, 'uAmount'),
    uRadius: gl.getUniformLocation(sharpenProg, 'uRadius'),
  }
  const smearLoc = {
    aPos: gl.getAttribLocation(smearProg, 'aPos'),
    uTex: gl.getUniformLocation(smearProg, 'uTex'),
    uOffset: gl.getUniformLocation(smearProg, 'uOffset'),
    uZoom: gl.getUniformLocation(smearProg, 'uZoom'),
    uCenter: gl.getUniformLocation(smearProg, 'uCenter'),
    uTaps: gl.getUniformLocation(smearProg, 'uTaps'),
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
    uSeed: gl.getUniformLocation(blendModeProg, 'uSeed'),
    uDither: gl.getUniformLocation(blendModeProg, 'uDither'),
  }

  // Reusable buffers: a per-layer quad (positions+UVs, rewritten each draw) and
  // a static full-screen triangle-pair for the post passes.
  const layerVbo = gl.createBuffer()
  const fullVbo = gl.createBuffer()
  if (!layerVbo || !fullVbo) throw new Error('createBuffer failed')
  gl.bindBuffer(gl.ARRAY_BUFFER, fullVbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  // Allocate the per-layer quad store ONCE (6 verts × 4 floats) and rewrite it
  // each draw with bufferSubData + a reused array, which avoids a per-layer per-frame
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
  // `mipmap` may be true ONLY for source textures that get generateMipmap after
  // every upload. A mipmap MIN_FILTER on a texture without a complete mip
  // chain is incomplete and samples opaque black (why destCapTex passes false).
  const setTexParams = (mipmap: boolean): void => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }
  gl.bindTexture(gl.TEXTURE_2D, srcTex)
  setTexParams(mipmapSources)
  let srcTexW = -1
  let srcTexH = -1

  // Per-source texture cache for STABLE sources: stills (<img>) and the cached
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
   *  title raster from a one-shot video frame, so the caller signals it from the layer. */
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
      if (!hit) setTexParams(mipmapSources)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      // Stable sources upload once, so the mip chain is built once and then
      // only re-bound. Cache hits above never pay for generateMipmap.
      if (mipmapSources) gl.generateMipmap(gl.TEXTURE_2D)
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
    // Every upload replaces level 0, so the chain must be re-derived each time
    // or the mip MIN_FILTER would sample stale (or missing) levels.
    if (mipmapSources) gl.generateMipmap(gl.TEXTURE_2D)
    return srcTex
  }

  // FBO pool, recreated when frame dims change. Sized to seq resolution.
  let fboW = 0
  let fboH = 0
  const pool: Fbo[] = []

  // Output-dither state for the frame currently being drawn, set once at the top
  // of render(). `ditherAmt` is 1 above HD and 0 below it (ditherRaster), and
  // every pass that writes the frame's FINAL target passes it through; passes
  // that write an intermediate FBO pass 0 and stay byte-identical to before.
  let ditherAmt = 0
  let ditherSeed = 0

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
      setTexParams(false) // sampled 1:1, never mipmapped (see setTexParams)
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
  // src + dst*(1 - src), add = src + dst. Each is exact for opaque sources and
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

  /**
   * The camera shutter smear for this layer, or null when it barely moved.
   *
   * Worked out from where this SAME picture sits one shutter later. `resolve` hands
   * over the second transform and never any pixels, because it is resolution
   * independent on purpose; the quad is what turns a scale, a drift and a crop into
   * a distance a viewer can actually see. → engine/render/motionBlur.ts
   *
   * ⛔ IT IS COMPUTED BEFORE THE DRAW, NOT DURING IT. A smear is a neighborhood pass,
   * so it needs the layer isolated in its own FBO, and that decision is made before
   * anything is drawn. Deriving it inside `drawLayer` would find out too late.
   */
  function layerMotionSmear(
    layer: RenderLayer,
    source: TexImageSource,
    frameW: number,
    frameH: number,
  ): ResolvedEffect | null {
    if (!layer.transformAtShutter) return null
    const texW = sourceW(source)
    const texH = sourceH(source)
    if (texW <= 0 || texH <= 0) return null
    const at = computeQuad({ frameW, frameH, texW, texH, transform: layer.transform }).corners
    const soon = computeQuad({ frameW, frameH, texW, texH, transform: layer.transformAtShutter }).corners
    const smear = deriveMotionBlur(at, soon)
    if (!smear) return null
    const centre = quadCentre(at)
    return {
      type: 'motionSmear',
      params: {
        dxPx: smear.translatePx * Math.cos((smear.angleDeg * Math.PI) / 180),
        dyPx: smear.translatePx * Math.sin((smear.angleDeg * Math.PI) / 180),
        // The growth as a FRACTION of the quad's own radius, which is what the shader
        // divides by. Off the quad rather than the frame, so a 4K sequence and a 1080
        // one smear the same punch by the same amount of PICTURE.
        zoom: smear.radialPx / Math.max(1, quadRadius(at, centre)),
        cx: centre[0] / frameW,
        cy: centre[1] / frameH,
      },
    }
  }

  // Draw one layer (transform + crop + filters, premultiplied) into the CURRENT
  // framebuffer. Alpha-over blend must already be set by the caller.
  function drawLayer(
    layer: RenderLayer,
    source: TexImageSource,
    frameW: number,
    frameH: number,
    dither: number,
  ): void {
    const texW = sourceW(source)
    const texH = sourceH(source)
    if (texW <= 0 || texH <= 0) return

    // Only genuinely-reused sources are cacheable: a title/caption raster (a
    // stable OffscreenCanvas) or a still <img>. VIDEO frames are a fresh
    // OffscreenCanvas each frame: never cache them, or the LRU floods with
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
    // Magnified layers sample through the clamped Catmull-Rom instead of plain
    // bilinear. Decided per DRAW from the quad the transform just produced, so a
    // keyframed zoom picks the right filter on every frame it crosses 1:1, and
    // from the SEQUENCE raster (frameW/frameH), never the canvas, so the preview
    // and the export take the same branch on the same clip.
    const bicubic = bicubicLayer(quadScale(corners, uv, texW, texH), frameW, frameH)
    const lp = getLayerProgram(pointwise, !!layer.mask, bicubic)

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
    // ⛔ SET ON EVERY DRAW, NEVER CONDITIONALLY. Uniforms are per-PROGRAM
    // state, so a framed layer that left a box behind would clip the next
    // unframed layer that happens to reuse the same compiled stack program:
    // one clip with an inner ratio would silently crop a different clip that
    // has none. The zero width is what means "the whole frame".
    const cb = layer.transform.frame
    gl.uniform4f(lp.uContentBox, cb?.x ?? 0, cb?.y ?? 0, cb?.w ?? 0, cb?.h ?? 0)
    if (lp.uSeed) gl.uniform1f(lp.uSeed, layer.frameSeed)
    // Set on EVERY draw, never conditionally: uniforms are per-program state, so
    // a final-target draw that left uDither at 1 would dither the next
    // intermediate draw that reuses the same compiled stack program.
    if (lp.uDither) gl.uniform1f(lp.uDither, dither)
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

  /**
   * One pass, one bounce through scratch, exactly like sharpen.
   *
   * Taps scale with how far the picture actually travelled: a two pixel drift needs
   * three samples and a sixty pixel whip needs all of them. Fixing the count high
   * would pay for a whip on every gentle push, and fixing it low bands a fast one
   * into visible steps.
   */
  function motionSmearFbo(
    srcFbo: Fbo,
    scratch: Fbo,
    dxPx: number,
    dyPx: number,
    zoom: number,
    cx: number,
    cy: number,
  ): void {
    const travelPx = Math.max(Math.abs(dxPx), Math.abs(dyPx), Math.abs(zoom) * Math.max(fboW, fboH) * 0.5)
    const taps = Math.max(2, Math.min(MAX_SMEAR_TAPS, Math.ceil(travelPx / 2)))
    gl.useProgram(smearProg)
    bindFull(smearLoc.aPos)
    gl.uniform1i(smearLoc.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex)
    // ⛔ THE Y FLIP LIVES HERE AND NOWHERE ELSE. The params arrive in SEQUENCE pixel
    // space, y DOWN, which is what `computeQuad` and every keyframe speak. FBO
    // textures in this renderer are bottom-row-first, so vUV is y UP (see FULL_VS).
    // Getting this wrong smears a punch up-left instead of up-right, which looks
    // plausible in a still and wrong the moment it plays.
    gl.uniform2f(smearLoc.uOffset, dxPx / fboW, -dyPx / fboH)
    gl.uniform1f(smearLoc.uZoom, zoom)
    gl.uniform2f(smearLoc.uCenter, cx, 1 - cy)
    gl.uniform1i(smearLoc.uTaps, taps)
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
    } else if (fx.type === 'motionSmear') {
      const dxPx = fx.params.dxPx ?? 0
      const dyPx = fx.params.dyPx ?? 0
      const zoom = fx.params.zoom ?? 0
      // The floor already ran in deriveMotionBlur; this second one is the guard
      // against a project file that carries a smear of nothing, which would cost a
      // full pass to change no pixels.
      if (Math.abs(dxPx) > 0.5 || Math.abs(dyPx) > 0.5 || Math.abs(zoom) > 0.0005) {
        motionSmearFbo(fbo, scratch, dxPx, dyPx, zoom, fx.params.cx ?? 0.5, fx.params.cy ?? 0.5)
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
    // His own effects first, then the shutter smear LAST, because a camera blurs the
    // finished picture: a glow or a grain applied after the smear would come out
    // razor sharp on top of a moving frame, which is the giveaway.
    const smear = layerMotionSmear(layer, source, frameW, frameH)
    const post = layer.effects.filter(isNeighborhood)
    if (smear) post.push(smear)
    const mode = layer.blendMode
    // Overlay/soft light must read the destination, so they always take the
    // isolated-FBO path even without neighborhood effects.
    // `invert` joins the dest-sampling modes because it is defined against
    // what is already composited beneath it: the isolated-FBO path is what
    // captures the target so the shader can read it.
    const needsDestSample = mode === 'overlay' || mode === 'softLight' || mode === 'invert'
    // A null target IS the frame he keeps (the canvas, which export reads back).
    // Anything else here is a transition side or the adjustment accumulator, both
    // of which get dithered later by whichever pass writes the canvas.
    const outDither = targetFb === null ? ditherAmt : 0
    if (post.length > 0 || needsDestSample) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layerFbo.fb)
      gl.viewport(0, 0, fboW, fboH)
      gl.disable(gl.BLEND)
      clear(0, 0, 0, 0)
      // Blend within the layer FBO with premultiplied over onto transparent.
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      drawLayer(layer, source, frameW, frameH, 0)
      for (const fx of post) applyNeighborhood(fx, layerFbo, scratch)
      // The target may be a seq-sized transition FBO (fboW×fboH), NOT the
      // canvas. Sizing the viewport to the canvas would draw into only a
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
        // ⛔ THREE-WAY, AND THE TWO-WAY VERSION MISCOMPILES IN SILENCE. Leaving this
        // as `? 0 : 1` renders every inverted title as SOFT LIGHT, in preview and
        // in the export alike, with no type error, no runtime error and nothing in
        // the golden e2e to catch it. Any test for this feature asserts the NUMBER.
        gl.uniform1i(blendModeLoc.uMode, mode === 'overlay' ? 0 : mode === 'softLight' ? 1 : 2)
        if (blendModeLoc.uSeed) gl.uniform1f(blendModeLoc.uSeed, layer.frameSeed)
        if (blendModeLoc.uDither) gl.uniform1f(blendModeLoc.uDither, outDither)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.activeTexture(gl.TEXTURE0)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
        gl.viewport(0, 0, tw, th)
        gl.enable(gl.BLEND)
        setBlendForMode(mode)
        blitFbo(layerFbo, outDither)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      }
    } else {
      // Fast path: draw straight onto the target. Same viewport note as above.
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
      gl.viewport(0, 0, targetFb ? fboW : gl.canvas.width, targetFb ? fboH : gl.canvas.height)
      gl.enable(gl.BLEND)
      setBlendForMode(mode)
      drawLayer(layer, source, frameW, frameH, outDither)
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
    // isolated on transparent, where multiply/overlay against nothing would black
    // out or vanish the clip mid-transition. Flatten to normal inside sides.
    const flat = layer.blendMode !== 'normal' ? { ...layer, blendMode: 'normal' as const } : layer
    compositeLayer(flat, source, frameW, frameH, dst.fb, layerFbo, scratch)
  }

  /**
   * Copy a premultiplied FBO through. `dither` is 0 for the scratch bounces
   * inside sharpen/glow (those write another intermediate FBO and must stay the
   * exact copy they were) and `ditherAmt` for the two blits that land on the
   * frame's final target.
   */
  function blitFbo(fbo: Fbo, dither = 0): void {
    gl.useProgram(blitProg)
    bindFull(blitLoc.aPos)
    gl.uniform1i(blitLoc.uTex, 0)
    if (blitLoc.uSeed) gl.uniform1f(blitLoc.uSeed, ditherSeed)
    if (blitLoc.uDither) gl.uniform1f(blitLoc.uDither, dither)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fbo.tex)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function drawTransition(
    op: Extract<RenderOp, { type: 'transition' }>,
    tex: TextureSource,
    frameW: number,
    frameH: number,
    targetFb: WebGLFramebuffer | null,
  ): void {
    // FBOs: 0=from-composited, 1=to-composited, 2=layer scratch, 3=blur scratch.
    // render() already sized the pool for this frame; only the COUNT matters
    // here, so pass the current dims rather than resizing back to the sequence.
    ensurePool(fboW, fboH, 4)
    const fromFbo = pool[0]
    const toFbo = pool[1]
    const layerFbo = pool[2]
    const scratch = pool[3]
    const fromSrc = tex(op.from)
    const toSrc = tex(op.to)
    renderSideToFbo(op.from, fromSrc, frameW, frameH, fromFbo, layerFbo, scratch)
    renderSideToFbo(op.to, toSrc, frameW, frameH, toFbo, layerFbo, scratch)

    // Combine into the target (canvas, or the accumulation FBO when the frame
    // has adjustment layers), OVER whatever lower tracks were already drawn.
    // The combined sides are premultiplied (transparent where neither clip
    // covers), so premultiplied-over compositing lets those lower tracks show.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
    gl.viewport(0, 0, targetFb ? fboW : gl.canvas.width, targetFb ? fboH : gl.canvas.height)
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
    gl.uniform1f(
      combineLoc.uProgress,
      progressWithSides(op.progress, !!fromSrc, !!toSrc, op.from.clipId !== op.to.clipId),
    )
    gl.uniform1i(combineLoc.uKind, KIND_INDEX[op.kind])
    gl.uniform1f(combineLoc.uSoft, 0.004)
    if (combineLoc.uSeed) gl.uniform1f(combineLoc.uSeed, op.from.frameSeed)
    if (combineLoc.uAspect) gl.uniform1f(combineLoc.uAspect, frameW / Math.max(frameH, 1))
    if (combineLoc.uDither) gl.uniform1f(combineLoc.uDither, targetFb === null ? ditherAmt : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
  }

  /**
   * Full-frame pass: run a pointwise stack (and optional mask/opacity) over a
   * source FBO into the CURRENT framebuffer via the shared per-layer program,
   * which is the exact GLSL the per-clip path compiles, so adjustment grades are
   * pixel-identical to clip grades. UVs are v-flipped: FBO memory is
   * bottom-row-first while image textures are top-row-first.
   */
  function drawFboThroughStack(
    src: Fbo,
    pointwise: readonly ResolvedEffect[],
    mask: RenderLayer['mask'],
    opacity: number,
    frameSeed: number,
    frameW: number,
    frameH: number,
  ): void {
    // Never bicubic: this pass reads a seq-sized FBO across a seq-sized quad, so
    // it is 1:1 by construction and there is nothing to magnify.
    const lp = getLayerProgram(pointwise, !!mask, false)
    gl.useProgram(lp.prog)
    gl.bindVertexArray(layerVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
    const v = layerVerts
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1
    v[4] = frameW; v[5] = 0; v[6] = 1; v[7] = 1
    v[8] = frameW; v[9] = frameH; v[10] = 1; v[11] = 0
    v[12] = 0; v[13] = 0; v[14] = 0; v[15] = 1
    v[16] = frameW; v[17] = frameH; v[18] = 1; v[19] = 0
    v[20] = 0; v[21] = frameH; v[22] = 0; v[23] = 1
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, v)
    gl.enableVertexAttribArray(lp.aPos)
    gl.vertexAttribPointer(lp.aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(lp.aUV)
    gl.vertexAttribPointer(lp.aUV, 2, gl.FLOAT, false, 16, 8)
    gl.uniform2f(lp.uFrame, frameW, frameH)
    gl.uniform1i(lp.uTex, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1f(lp.uOpacity, clamp01(opacity))
    gl.uniform4f(lp.uUVRect, 0, 0, 1, 1)
    // An adjustment pass covers the whole frame by definition: it is a grade
    // applied to what is already drawn, not a picture being laid out. Cleared
    // for the same per-program reason as above.
    gl.uniform4f(lp.uContentBox, 0, 0, 0, 0)
    if (lp.uSeed) gl.uniform1f(lp.uSeed, frameSeed)
    // Adjustment passes always write an intermediate FBO (the work buffer, then
    // the accumulator); the accumulator's blit to the canvas is what dithers.
    if (lp.uDither) gl.uniform1f(lp.uDither, 0)
    // Bind the stack's effect params. Locations were resolved against THIS
    // program, so index i lines up with pointwise[i] by construction.
    pointwise.forEach((fx, i) => {
      const locs = lp.fx[i]
      if (!locs) return
      for (const key of Object.keys(locs)) {
        const loc = locs[key]
        if (loc) gl.uniform1f(loc, fx.params[key] ?? 0)
      }
    })
    if (mask && lp.mask) {
      // The mask spec is top-down (source space); this pass samples v-flipped.
      gl.uniform2f(lp.mask.center, mask.cx, 1 - mask.cy)
      gl.uniform2f(lp.mask.radius, Math.max(mask.rx, 1e-4), Math.max(mask.ry, 1e-4))
      gl.uniform1f(lp.mask.feather, mask.feather)
      gl.uniform1i(lp.mask.kind, mask.kind === 'ellipse' ? 1 : 0)
      gl.uniform1f(lp.mask.invert, mask.invert ? 1 : 0)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /**
   * Apply an adjustment op to the accumulated frame: pointwise chain into a
   * work FBO, neighborhood passes over it, then the processed frame composites
   * OVER the original through mask + opacity: masked-out pixels keep the
   * untouched original, and opacity fades the whole grade.
   */
  function applyAdjustment(
    op: Extract<RenderOp, { type: 'adjustment' }>,
    accum: Fbo,
    work: Fbo,
    scratch: Fbo,
    frameW: number,
    frameH: number,
  ): void {
    const pointwise = op.effects.filter(isPointwise)
    const post = op.effects.filter(isNeighborhood)
    gl.bindFramebuffer(gl.FRAMEBUFFER, work.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.disable(gl.BLEND)
    drawFboThroughStack(accum, pointwise, undefined, 1, op.frameSeed, frameW, frameH)
    for (const fx of post) applyNeighborhood(fx, work, scratch)
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fb)
    gl.viewport(0, 0, fboW, fboH)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    drawFboThroughStack(work, [], op.mask, op.opacity, op.frameSeed, frameW, frameH)
  }

  function render(frame: RenderFrame, tex: TextureSource): void {
    const frameW = frame.width
    const frameH = frame.height
    // Adjustment frames composite into an accumulation FBO (pool[5]) so the
    // adjustment stack can re-read the whole frame; everything else keeps the
    // byte-stable straight-to-canvas path. pool[6] is the adjustment work FBO;
    // glow's lazy pool[4] stays free in both paths.
    const hasAdjustment = frame.ops.some((op) => op.type === 'adjustment')
    // Output dither for THIS frame, decided from the sequence raster rather than
    // the canvas so preview and export agree even when the preview panel is a
    // third of the size. Sub-HD gets 0, which is the untouched legacy path.
    ditherAmt = ditherRaster(frameW, frameH) ? 1 : 0
    ditherSeed = frameSeedOf(frame.ops)
    ensurePool(frameW, frameH, hasAdjustment ? 7 : 4)
    const accum = hasAdjustment ? pool[5] : null
    const targetFb = accum ? accum.fb : null

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb)
    gl.viewport(0, 0, targetFb ? fboW : gl.canvas.width, targetFb ? fboH : gl.canvas.height)
    gl.disable(gl.BLEND)
    clear(0, 0, 0, 1) // opaque black background

    for (const op of frame.ops) {
      if (op.type === 'layer') {
        const source = tex(op.layer)
        if (!source) continue // still decoding. Skip, never throw
        compositeLayer(op.layer, source, frameW, frameH, targetFb, pool[2], pool[3])
      } else if (op.type === 'transition') {
        drawTransition(op, tex, frameW, frameH, targetFb)
      } else if (accum) {
        applyAdjustment(op, accum, pool[6], pool[3], frameW, frameH)
      }
    }
    if (accum) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
      gl.disable(gl.BLEND)
      blitFbo(accum, ditherAmt)
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
