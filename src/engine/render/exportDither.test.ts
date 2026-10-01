// Does the export's anti-banding dither actually reach the pixels?
//
// It did not, from 2026-09-17 to 2026-10-01, and every test stayed green. The
// linear light change made each frame composite into an 8 bit sRGB buffer
// first, and the only dithered pass, the blit out of it, was handed values that
// buffer had already rounded to a code. dither.test.ts pinned the GATE (is the
// dither switched on at HD?) and nothing asked whether it ever changed a pixel.
// MEASURED in the real app on his own footage, 2026-09-30: a 0.42 fade came out
// 94.8% equal to the undithered sum, and the blurred backdrop of his mc night
// Short exported with bare one-code contour rings, a flat run of 575 px in a
// 1080 px row.
//
// There is no GPU under vitest, so this asks the question two ways:
//
//   1. THE PLUMBING, against a recording stand-in for WebGL2: when the export
//      asks for high precision and the GPU has a 16 bit format, every buffer
//      the frame passes through is 16 bit, the canvas write uses the blit that
//      encodes by the GPU's own code table, and that one draw carries the
//      dither. Without either, nothing changes from before.
//   2. THE ARITHMETIC, with the shader's own constants and a decode table that
//      is off the sRGB formula the way his GPU's is: a fade through an 8 bit
//      buffer leaves the dither nothing to do (the defect, reproduced), through
//      a 16 bit buffer it breaks the contours, and an untouched 1:1 pixel comes
//      back exactly its code.
//
// The real-GPU and real-app proof (his footage, before and after) is in the
// commit that added this.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRenderer, DEEP_DITHER_ON_CODE, DEEP_DITHER_PEAK_CODES, RGBA16_EXT } from './glRenderer'
import { defaultTransform } from '../types'
import type { BlendMode } from '../types'
import type { RenderFrame, RenderLayer } from './types'

// --- 1. the plumbing ---------------------------------------------------------

const C = {
  TEXTURE_2D: 0x0de1,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  SRGB8_ALPHA8: 0x8c43,
  RGBA8: 0x8058,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAGMENT_SHADER: 0x8b30,
} as const

interface Draw {
  /** The framebuffer drawn into: null is the canvas, the frame he keeps. */
  fb: unknown
  /** The fragment shader source of the program that drew. */
  fs: string
  uniforms: Record<string, number>
}

interface Recording {
  gl: WebGL2RenderingContext
  /** internalformat of every frame-sized texImage2D with no pixels: the buffers a frame passes through. */
  bufferFormats: number[]
  /** internalformat of every texImage2D that uploads a source picture. */
  sourceFormats: number[]
  /** Small tables uploaded with their own data (w x h, internalformat). */
  tables: { w: number; h: number; format: number }[]
  draws: Draw[]
  calls: string[]
}

/** A WebGL2 context that draws nothing and remembers everything asked of it. */
function recordingGl(opts: { norm16: boolean; complete?: boolean; w: number; h: number }): Recording {
  const rec: Recording = {
    gl: null as unknown as WebGL2RenderingContext,
    bufferFormats: [],
    sourceFormats: [],
    tables: [],
    draws: [],
    calls: [],
  }
  let drawFb: unknown = null
  let program: { fs?: string } | null = null
  const uniformState = new Map<object, Record<string, number>>()
  let nextConst = 0x10000
  const consts = new Map<string, number>(Object.entries(C))
  const impl: Record<string, unknown> = {
    canvas: { width: opts.w, height: opts.h },
    getExtension: (name: string) => (name === 'EXT_texture_norm16' && opts.norm16 ? { RGBA16_EXT } : null),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (prog: object, name: string) => ({ prog, name }),
    checkFramebufferStatus: () => (opts.complete === false ? 0 : C.FRAMEBUFFER_COMPLETE),
    isContextLost: () => false,
    createShader: (type: number) => ({ type, src: '' }),
    shaderSource: (sh: { src: string }, src: string) => {
      sh.src = src
    },
    createProgram: () => ({}),
    attachShader: (prog: { fs?: string }, sh: { type: number; src: string }) => {
      if (sh.type === C.FRAGMENT_SHADER) prog.fs = sh.src
    },
    useProgram: (p: { fs?: string } | null) => {
      program = p
    },
    uniform1f: (loc: { prog: object; name: string } | null, v: number) => {
      if (!loc) return
      const s = uniformState.get(loc.prog) ?? {}
      s[loc.name] = v
      uniformState.set(loc.prog, s)
    },
    bindFramebuffer: (target: number, fb: unknown) => {
      if (target === C.FRAMEBUFFER || target === C.DRAW_FRAMEBUFFER) drawFb = fb
    },
    texImage2D: (...args: unknown[]) => {
      // (target, level, internalformat, w, h, border, format, type, pixels) allocates;
      // (target, level, internalformat, format, type, source) uploads a picture.
      if (args.length !== 9) rec.sourceFormats.push(args[2] as number)
      else if (args[8] !== null) rec.tables.push({ w: args[3] as number, h: args[4] as number, format: args[2] as number })
      // The renderer's 1x1 probe of the 16 bit format is not a buffer the frame uses.
      else if (args[3] !== 1 || args[4] !== 1) rec.bufferFormats.push(args[2] as number)
    },
    drawArrays: () => {
      rec.draws.push({ fb: drawFb, fs: program?.fs ?? '', uniforms: { ...(program ? uniformState.get(program) : {}) } })
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
      return () => {
        rec.calls.push(prop)
        return prop.startsWith('create') ? { kind: prop } : undefined
      }
    },
  }) as unknown as WebGL2RenderingContext
  return rec
}

const layer = (opacity: number, blendMode: BlendMode = 'normal'): RenderLayer => ({
  clipId: 'c1',
  assetId: 'a1',
  sourceTimeS: 0,
  isImage: false,
  speed: 1,
  frameSeed: 7,
  transform: { ...defaultTransform(), cropT: 0, cropR: 0, cropB: 0, cropL: 0 },
  opacity,
  blendMode,
  effects: [],
})

/** One 1920x1080 frame of his footage through the renderer, at the given opacities and blends. */
function renderOnce(rec: Recording, highPrecision: boolean, layers: RenderLayer[]): void {
  const renderer = createRenderer(rec.gl, { mipmapSources: true, highPrecision })
  const frame: RenderFrame = { width: 1920, height: 1080, ops: layers.map((l) => ({ type: 'layer' as const, layer: l })) }
  const source = { width: 1920, height: 1080 } as unknown as TexImageSource
  renderer.render(frame, () => source)
  renderer.dispose()
}

describe('the export composites in 16 bit when the GPU can, so the dither has values between codes to work on', () => {
  it('puts every buffer the frame passes through in RGBA16, not 8 bit sRGB', () => {
    const rec = recordingGl({ norm16: true, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(0.42)])
    expect(rec.bufferFormats.length).toBeGreaterThan(0)
    expect(rec.bufferFormats.every((f) => f === RGBA16_EXT)).toBe(true)
  })

  it('still uploads his footage as sRGB, so it is decoded to light exactly as before', () => {
    const rec = recordingGl({ norm16: true, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(0.42)])
    expect(rec.sourceFormats).toContain(C.SRGB8_ALPHA8)
  })

  it('writes the canvas with the blit that reads codes off the GPU\'s own decode table, and dithers there only', () => {
    const rec = recordingGl({ norm16: true, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(0.42)])
    // The table: 256 codes in an sRGB texture, so sampling one IS the GPU's decode of it.
    expect(rec.tables).toContainEqual({ w: 256, h: 1, format: C.SRGB8_ALPHA8 })
    const toCanvas = rec.draws.filter((d) => d.fb === null)
    expect(toCanvas).toHaveLength(1)
    expect(toCanvas[0].fs).toContain('uCodeLut')
    expect(toCanvas[0].uniforms.uDither).toBe(1)
    expect(toCanvas[0].uniforms.uEncode).toBe(1)
    // Into the 16 bit buffers nothing rounds, so nothing there may be dithered.
    for (const d of rec.draws.filter((d) => d.fb !== null)) expect(d.uniforms.uDither ?? 0).toBe(0)
  })

  it('copies a 16 bit target for overlay with a framebuffer blit, never the sRGB copy that would refuse it', () => {
    const rec = recordingGl({ norm16: true, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(1), layer(1, 'overlay')])
    expect(rec.calls).toContain('blitFramebuffer')
    expect(rec.calls).not.toContain('copyTexImage2D')
    expect(rec.calls).not.toContain('copyTexSubImage2D')
  })
})

describe('everywhere else, the renderer is exactly what it was', () => {
  const expectToday = (rec: Recording): void => {
    expect(rec.bufferFormats.every((f) => f === C.SRGB8_ALPHA8)).toBe(true)
    expect(rec.tables).toEqual([])
    for (const d of rec.draws) expect(d.fs).not.toContain('uCodeLut')
  }

  it('the preview (no high precision asked) keeps its 8 bit buffers and its blit, even on a GPU that has 16 bit', () => {
    const rec = recordingGl({ norm16: true, w: 1920, h: 1080 })
    renderOnce(rec, false, [layer(0.42)])
    expectToday(rec)
  })

  it('a GPU without EXT_texture_norm16 falls back to the 8 bit path', () => {
    const rec = recordingGl({ norm16: false, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(0.42)])
    expectToday(rec)
  })

  it('a GPU that advertises 16 bit but cannot draw into it falls back too, instead of exporting black', () => {
    const rec = recordingGl({ norm16: true, complete: false, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(0.42)])
    expectToday(rec)
  })

  it('the 8 bit path still captures overlay targets with the copy it always used', () => {
    const rec = recordingGl({ norm16: false, w: 1920, h: 1080 })
    renderOnce(rec, true, [layer(1), layer(1, 'overlay')])
    expect(rec.calls).toContain('copyTexImage2D')
  })
})

describe('both export renderers ask for it, on the same HD gate as the dither', () => {
  const src = readFileSync(fileURLToPath(new URL('../export/exportWorker.ts', import.meta.url)), 'utf8')
  it('the desktop (ffmpeg) path', () => {
    expect(src).toContain('createRenderer(gl, { mipmapSources: isHdRaster(W, H), highPrecision: isHdRaster(W, H) })')
  })
  it('the browser (WebCodecs) path', () => {
    expect(src).toContain('createRenderer(gl, { mipmapSources: isHd, highPrecision: isHd })')
  })
})

// --- 2. the arithmetic -------------------------------------------------------

const formulaDecode = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const formulaEncode = (l: number): number => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)

/**
 * The GPU's own decode of each code. His RTX 4060 reads sRGB textures up to
 * 0.54% off the formula (measured 2026-10-01); this table is off by a smooth
 * wobble of that size, so the model fails exactly where the GPU would.
 */
const gpuTable = Array.from({ length: 256 }, (_, k) => formulaDecode(k / 255) * (1 + 0.005 * Math.sin(k * 0.7)))

/** BLIT_DEEP_FS's codeOf: light to a fractional code, bracketed by the GPU's own table. */
function codeOf(x: number): number {
  if (x >= gpuTable[255]) return 255
  let k = 0
  while (k < 254 && x >= gpuTable[k + 1]) k++
  return k + Math.min(1, Math.max(0, (x - gpuTable[k]) / (gpuTable[k + 1] - gpuTable[k])))
}

/** The shader's triangular noise in codes (any decent hash will do for the model). */
function tpdf(i: number): number {
  const r = (n: number): number => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  return (r(i) - r(i + 0.5)) * DEEP_DITHER_PEAK_CODES
}

/** What the deep blit writes to the canvas for one stored value of light. */
function deepCanvasCode(storedLight: number, i: number, dither: boolean): number {
  const code = codeOf(storedLight)
  const offCode = Math.abs(code - Math.round(code)) >= DEEP_DITHER_ON_CODE
  return Math.round(Math.min(255, Math.max(0, code + (dither && offCode ? tpdf(i) : 0))))
}

/** An 8 bit sRGB buffer: the GPU encodes on write to the code whose decode is nearest. */
function store8bit(light: number): number {
  let best = 0
  for (let k = 1; k < 256; k++) if (Math.abs(gpuTable[k] - light) < Math.abs(gpuTable[best] - light)) best = k
  return gpuTable[best]
}
const store16bit = (light: number): number => Math.round(light * 65535) / 65535

/**
 * His dark sky: a slow ramp of 16 codes across a 1080 px row, faded to 0.42 like
 * the measured clip. `row` only moves the noise, the way gl_FragCoord.y does.
 */
function fadedRow(store: (l: number) => number, dither: boolean, row = 0): number[] {
  const out: number[] = []
  for (let x = 0; x < 1080; x++) {
    const sourceCode = Math.round((x / 1079) * 16 + 20)
    out.push(deepCanvasCode(store(gpuTable[sourceCode] * 0.42), row * 1080 + x, dither))
  }
  return out
}

function longestRun(row: number[]): number {
  let best = 1
  let run = 1
  for (let i = 1; i < row.length; i++) {
    run = row[i] === row[i - 1] ? run + 1 : 1
    best = Math.max(best, run)
  }
  return best
}

/** The harness's own banding number: the widest flat run, averaged over rows. */
function meanLongestRun(store: (l: number) => number, dither: boolean): number {
  let sum = 0
  for (let row = 0; row < 64; row++) sum += longestRun(fadedRow(store, dither, row))
  return sum / 64
}

describe('the arithmetic: why the old buffer starved the dither, and why 16 bit feeds it', () => {
  it('REPRODUCES the defect: through an 8 bit buffer the dither changes not one pixel of a fade', () => {
    expect(fadedRow(store8bit, true)).toEqual(fadedRow(store8bit, false))
  })

  it('through a 16 bit buffer the same fade comes out dithered, its contours broken into grain', () => {
    // _verify/quality.mjs once measured this dither taking the mean widest band
    // from 202 to 73 px on his GPU, a cut to 36%. The model has to cut it well
    // down too, not shave it.
    expect(meanLongestRun(store16bit, true)).toBeLessThan(meanLongestRun(store16bit, false) * 0.6)
    // And it is grain on the ramp, never a new error: within one code of the
    // undithered value everywhere.
    const plain = fadedRow(store16bit, false)
    const dithered = fadedRow(store16bit, true)
    for (let i = 0; i < plain.length; i++) expect(Math.abs(dithered[i] - plain[i])).toBeLessThanOrEqual(1)
  })

  it('an untouched 1:1 pixel comes back from the 16 bit buffer as exactly its code, for every code and any noise', () => {
    for (let code = 0; code <= 255; code++) {
      const stored = store16bit(gpuTable[code])
      expect(Math.abs(codeOf(stored) - code)).toBeLessThan(DEEP_DITHER_ON_CODE)
      for (let i = 0; i < 16; i++) expect(deepCanvasCode(stored, i, true)).toBe(code)
    }
  })

  it('and that needs the GPU\'s own table: the sRGB formula would call half of all untouched codes "between codes"', () => {
    // Measured on his GPU: 138 of 256 codes come back more than a sixteenth of a
    // code off when re-encoded by the formula. A dither keyed on the formula
    // moved 13% of every value in a 1:1 frame.
    let off = 0
    for (let code = 0; code <= 255; code++) {
      const e = formulaEncode(store16bit(gpuTable[code])) * 255
      if (Math.abs(e - Math.round(e)) >= DEEP_DITHER_ON_CODE) off++
    }
    expect(off).toBeGreaterThan(64)
  })
})
