// The .cube LUT file: parse it, and sample it the way the renderer does.
//
// Pure: no GL, no DOM, no store. The LUT effect (a later piece) uploads
// `ParsedCube.data` as a 3D texture (or a one row 2D texture for a 1D table) and
// samples it with the same half texel remap `sampleCube` uses here, so a test can
// say what the shader must draw.
//
// THE FORMAT (Adobe / Resolve .cube): `#` starts a comment; `TITLE "name"`;
// `LUT_3D_SIZE N` or `LUT_1D_SIZE N`; optional `DOMAIN_MIN r g b` and `DOMAIN_MAX
// r g b` (default 0 0 0 and 1 1 1; Resolve also writes LUT_3D_INPUT_RANGE and
// LUT_1D_INPUT_RANGE with one min and one max for all three); then rows of three
// numbers. A 3D table has N*N*N rows with RED changing fastest, then green, then
// blue. A 1D table has N rows, each the red, green and blue output for that step.
//
// Every message below is read by the person who dropped the file in, so it says
// what is wrong in the file and what the app supports, in plain words.

/** The widest a 3D table goes (65 x 65 x 65 is the biggest the format is used at). */
export const MAX_CUBE_3D_SIZE = 65
/** The longest a 1D table goes. One row of a texture, so the GPU's own limit is far above this. */
export const MAX_CUBE_1D_SIZE = 4096

export interface ParsedCube {
  kind: '1d' | '3d'
  /** Steps per side (3D) or rows (1D). */
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title: string
  /** RGB triples as floats, in file order: red fastest for a 3D table. Length size^3 * 3, or size * 3. */
  data: Float32Array
}

/** A broken or unsupported .cube file; `message` is plain words for the person. */
export class CubeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CubeError'
  }
}

/** Lines Resolve writes that change nothing this reads. */
const IGNORED_KEYWORDS = new Set(['LUT_IN_VIDEO_RANGE', 'LUT_OUT_VIDEO_RANGE'])

function numbersOf(tokens: string[], count: number, line: number, keyword: string): number[] {
  const out = tokens.map(Number)
  if (tokens.length !== count || out.some((n) => !Number.isFinite(n))) {
    throw new CubeError(`Line ${line}: ${keyword} needs ${count} number${count === 1 ? '' : 's'}.`)
  }
  return out
}

function sizeOf(tokens: string[], line: number, keyword: string, max: number): number {
  const [n] = numbersOf(tokens, 1, line, keyword)
  if (!Number.isInteger(n) || n < 2) {
    throw new CubeError(`Line ${line}: ${keyword} must be a whole number of 2 or more, not "${tokens[0]}".`)
  }
  if (n > max) {
    throw new CubeError(`Line ${line}: ${keyword} ${n} is bigger than this app reads (the most is ${max}).`)
  }
  return n
}

/** Read a .cube file's text. Throws a CubeError, in plain words, for anything broken or unsupported. */
export function parseCube(text: string): ParsedCube {
  if (text.includes('\u0000')) {
    throw new CubeError('This is not a text .cube LUT file (it holds binary data).')
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)

  let title = ''
  let size1d = 0
  let size3d = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const rows: number[] = []
  let expectedRows = 0
  let rowCount = 0

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue

    const first = line.split(/\s+/, 1)[0]
    if (first === 'TITLE') {
      const quoted = line.match(/^TITLE\s+"([^"]*)"/)
      title = (quoted ? quoted[1] : line.slice(5)).trim()
      continue
    }
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash).trim()
    const tokens = line.split(/\s+/)
    const keyword = tokens[0]

    if (/^[A-Za-z_]/.test(keyword)) {
      const args = tokens.slice(1)
      if (keyword === 'LUT_3D_SIZE') {
        if (size3d > 0) throw new CubeError(`Line ${lineNo}: LUT_3D_SIZE appears twice.`)
        size3d = sizeOf(args, lineNo, keyword, MAX_CUBE_3D_SIZE)
      } else if (keyword === 'LUT_1D_SIZE') {
        if (size1d > 0) throw new CubeError(`Line ${lineNo}: LUT_1D_SIZE appears twice.`)
        size1d = sizeOf(args, lineNo, keyword, MAX_CUBE_1D_SIZE)
      } else if (keyword === 'DOMAIN_MIN') {
        domainMin = numbersOf(args, 3, lineNo, keyword) as [number, number, number]
      } else if (keyword === 'DOMAIN_MAX') {
        domainMax = numbersOf(args, 3, lineNo, keyword) as [number, number, number]
      } else if (keyword === 'LUT_3D_INPUT_RANGE' || keyword === 'LUT_1D_INPUT_RANGE') {
        const [lo, hi] = numbersOf(args, 2, lineNo, keyword)
        domainMin = [lo, lo, lo]
        domainMax = [hi, hi, hi]
      } else if (!IGNORED_KEYWORDS.has(keyword)) {
        throw new CubeError(`Line ${lineNo}: "${keyword}" is not part of the .cube format, so this may not be a LUT file.`)
      }
      if (size1d > 0 && size3d > 0) {
        throw new CubeError('This file has both a 1D and a 3D table. A .cube file holds one table; this app reads one per file.')
      }
      expectedRows = size3d > 0 ? size3d ** 3 : size1d
      continue
    }

    if (expectedRows === 0) {
      throw new CubeError(`Line ${lineNo}: numbers come before LUT_3D_SIZE or LUT_1D_SIZE, so the table size is not known.`)
    }
    const rgb = numbersOf(tokens, 3, lineNo, 'a table row')
    if (rowCount >= expectedRows) {
      throw new CubeError(
        `The table is bigger than its size line says: ${size3d > 0 ? `LUT_3D_SIZE ${size3d}` : `LUT_1D_SIZE ${size1d}`} needs ${expectedRows} rows, and line ${lineNo} is one more.`,
      )
    }
    rows.push(rgb[0], rgb[1], rgb[2])
    rowCount++
  }

  if (size1d === 0 && size3d === 0) {
    throw new CubeError('This does not look like a .cube LUT: it has no LUT_3D_SIZE or LUT_1D_SIZE line.')
  }
  if (rowCount !== expectedRows) {
    const which = size3d > 0 ? `LUT_3D_SIZE ${size3d}` : `LUT_1D_SIZE ${size1d}`
    throw new CubeError(`The table is cut short: ${which} needs ${expectedRows} rows of three numbers, but the file has ${rowCount}.`)
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) {
      throw new CubeError('DOMAIN_MAX must be larger than DOMAIN_MIN on red, green and blue.')
    }
  }

  const data = Float32Array.from(rows)
  return { kind: size3d > 0 ? '3d' : '1d', size: size3d > 0 ? size3d : size1d, domainMin, domainMax, title, data }
}

/**
 * The colour a table gives for `rgb` (0..1 in the table's domain), the way the
 * renderer samples it: the input is mapped across the domain, then linear in 1D or
 * trilinear in 3D between the table's rows. An identity table returns its input.
 */
export function sampleCube(cube: ParsedCube, rgb: readonly [number, number, number]): [number, number, number] {
  const { size, data } = cube
  const t = [0, 1, 2].map((c) => {
    const span = cube.domainMax[c] - cube.domainMin[c]
    return Math.min(1, Math.max(0, (rgb[c] - cube.domainMin[c]) / span)) * (size - 1)
  })
  if (cube.kind === '1d') {
    const out: number[] = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const i0 = Math.min(Math.floor(t[c]), size - 2)
      const f = t[c] - i0
      out[c] = data[i0 * 3 + c] * (1 - f) + data[(i0 + 1) * 3 + c] * f
    }
    return [out[0], out[1], out[2]]
  }
  const i0 = t.map((v) => Math.min(Math.floor(v), size - 2))
  const f = t.map((v, c) => v - i0[c])
  const out: number[] = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const dr = corner & 1
    const dg = (corner >> 1) & 1
    const db = (corner >> 2) & 1
    const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2])
    const at = (((i0[2] + db) * size + (i0[1] + dg)) * size + (i0[0] + dr)) * 3
    for (let c = 0; c < 3; c++) out[c] += data[at + c] * w
  }
  return [out[0], out[1], out[2]]
}

/** The identity table of a kind and size: every step maps to itself. For tests and a neutral default. */
export function identityCube(kind: '1d' | '3d', size: number): ParsedCube {
  const rows: number[] = []
  const at = (i: number): number => i / (size - 1)
  if (kind === '1d') {
    for (let i = 0; i < size; i++) rows.push(at(i), at(i), at(i))
  } else {
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) rows.push(at(r), at(g), at(b))
  }
  return { kind, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'identity', data: Float32Array.from(rows) }
}
