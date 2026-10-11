import { describe, expect, it } from 'vitest'

import { CubeError, identityCube, MAX_CUBE_1D_SIZE, MAX_CUBE_3D_SIZE, parseCube, sampleCube, type ParsedCube } from './cube'

/** The text of a cube file: header lines, then the rows of an identity table. */
const cubeText = (kind: '1d' | '3d', size: number, header: string[] = []): string => {
  const id = identityCube(kind, size)
  const body: string[] = []
  for (let i = 0; i < id.data.length; i += 3) body.push(`${id.data[i]} ${id.data[i + 1]} ${id.data[i + 2]}`)
  return [...header, kind === '3d' ? `LUT_3D_SIZE ${size}` : `LUT_1D_SIZE ${size}`, ...body].join('\n')
}

const messageOf = (text: string): string => {
  try {
    parseCube(text)
  } catch (err) {
    expect(err).toBeInstanceOf(CubeError)
    return (err as Error).message
  }
  throw new Error('expected parseCube to throw')
}

describe('parseCube, a 3D table', () => {
  it('reads the size, the rows and the default domain', () => {
    const cube = parseCube(cubeText('3d', 3))
    expect(cube.kind).toBe('3d')
    expect(cube.size).toBe(3)
    expect(cube.data.length).toBe(27 * 3)
    expect(cube.domainMin).toEqual([0, 0, 0])
    expect(cube.domainMax).toEqual([1, 1, 1])
  })

  it('keeps file order: red changes fastest, then green, then blue', () => {
    const cube = parseCube(cubeText('3d', 2))
    // Row 1 is red 1, green 0, blue 0; row 2 is red 0, green 1, blue 0; row 4 is blue 1.
    expect(Array.from(cube.data.slice(3, 6))).toEqual([1, 0, 0])
    expect(Array.from(cube.data.slice(6, 9))).toEqual([0, 1, 0])
    expect(Array.from(cube.data.slice(12, 15))).toEqual([0, 0, 1])
  })

  it('reads comments, blank lines, a title, CRLF endings, tabs and scientific numbers', () => {
    const text = [
      '# made by a test',
      '',
      'TITLE "Warm # one"',
      'LUT_3D_SIZE 2   # two steps',
      '0\t0\t0',
      '1.0e0 0 0',
      '0 1 0',
      '1 1 0',
      '0 0 1',
      '1 0 1',
      '0 1 1',
      '1 1 1  # last',
    ].join('\r\n')
    const cube = parseCube(text)
    expect(cube.title).toBe('Warm # one')
    expect(cube.size).toBe(2)
    expect(Array.from(cube.data.slice(21, 24))).toEqual([1, 1, 1])
  })

  it('reads a byte order mark at the start of the file', () => {
    expect(parseCube('﻿' + cubeText('3d', 2)).size).toBe(2)
  })

  it('reads DOMAIN_MIN and DOMAIN_MAX', () => {
    const cube = parseCube(cubeText('3d', 2, ['DOMAIN_MIN -0.1 0 0.2', 'DOMAIN_MAX 1.5 2 3']))
    expect(cube.domainMin).toEqual([-0.1, 0, 0.2])
    expect(cube.domainMax).toEqual([1.5, 2, 3])
  })

  it('reads the Resolve input range lines and ignores its video range lines', () => {
    const cube = parseCube(cubeText('3d', 2, ['LUT_3D_INPUT_RANGE 0.0 4.0', 'LUT_IN_VIDEO_RANGE 0 1']))
    expect(cube.domainMax).toEqual([4, 4, 4])
  })

  it('reads the largest size, 65', () => {
    const cube = parseCube(cubeText('3d', MAX_CUBE_3D_SIZE))
    expect(cube.data.length).toBe(65 ** 3 * 3)
  })
})

describe('parseCube, a 1D table', () => {
  it('reads one row per step', () => {
    const cube = parseCube(cubeText('1d', 5))
    expect(cube.kind).toBe('1d')
    expect(cube.size).toBe(5)
    expect(cube.data.length).toBe(15)
    expect(Array.from(cube.data.slice(12, 15))).toEqual([1, 1, 1])
  })

  it('reads the longest 1D table', () => {
    expect(parseCube(cubeText('1d', MAX_CUBE_1D_SIZE)).size).toBe(MAX_CUBE_1D_SIZE)
  })
})

describe('parseCube, files it refuses, in plain words', () => {
  it('an empty file or one with no size line is not a LUT', () => {
    expect(messageOf('')).toMatch(/no LUT_3D_SIZE or LUT_1D_SIZE/)
    expect(messageOf('# only a comment\n')).toMatch(/does not look like a \.cube LUT/)
    expect(messageOf('hello there, I am a text file')).toMatch(/not part of the \.cube format/)
  })

  it('binary data is refused', () => {
    expect(messageOf('LUT_3D_SIZE 2\u0000\u0001')).toMatch(/binary/)
  })

  it('a table cut short says how many rows it needs and has', () => {
    const text = cubeText('3d', 3).split('\n').slice(0, -5).join('\n')
    expect(messageOf(text)).toMatch(/LUT_3D_SIZE 3 needs 27 rows of three numbers, but the file has 22/)
  })

  it('a table with extra rows says so', () => {
    expect(messageOf(cubeText('1d', 3) + '\n0.5 0.5 0.5')).toMatch(/bigger than its size line says/)
  })

  it('a row that is not three numbers names its line', () => {
    expect(messageOf('LUT_1D_SIZE 2\n0 0 0\n1 1')).toMatch(/Line 3: a table row needs 3 numbers/)
    expect(messageOf('LUT_1D_SIZE 2\n0 0 0\n1 x 1')).toMatch(/Line 3/)
    expect(messageOf('LUT_1D_SIZE 2\n0 0 0\n1 Infinity 1')).toMatch(/Line 3/)
  })

  it('a size that is too small, too big or not whole is refused with the limit', () => {
    expect(messageOf('LUT_3D_SIZE 1\n0 0 0')).toMatch(/whole number of 2 or more/)
    expect(messageOf('LUT_3D_SIZE 2.5\n')).toMatch(/whole number/)
    expect(messageOf(`LUT_3D_SIZE ${MAX_CUBE_3D_SIZE + 1}\n`)).toMatch(/the most is 65/)
    expect(messageOf(`LUT_1D_SIZE ${MAX_CUBE_1D_SIZE + 1}\n`)).toMatch(/the most is 4096/)
  })

  it('numbers before the size line are refused', () => {
    expect(messageOf('0 0 0\nLUT_3D_SIZE 2')).toMatch(/Line 1: numbers come before/)
  })

  it('a 1D and a 3D size together are refused', () => {
    expect(messageOf('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n')).toMatch(/both a 1D and a 3D table/)
  })

  it('a size line twice is refused', () => {
    expect(messageOf('LUT_3D_SIZE 2\nLUT_3D_SIZE 2')).toMatch(/appears twice/)
  })

  it('a domain that does not grow is refused', () => {
    expect(messageOf(cubeText('3d', 2, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 0 1']))).toMatch(/DOMAIN_MAX must be larger/)
    expect(messageOf(cubeText('3d', 2, ['DOMAIN_MIN 1 1 1', 'DOMAIN_MAX 0 0 0']))).toMatch(/DOMAIN_MAX must be larger/)
  })

  it('a DOMAIN line with the wrong count of numbers is refused', () => {
    expect(messageOf(cubeText('3d', 2, ['DOMAIN_MIN 0 0']))).toMatch(/DOMAIN_MIN needs 3 numbers/)
  })
})

describe('sampleCube', () => {
  const grid = [0, 0.013, 0.25, 0.4999, 0.5, 0.731, 0.999, 1]
  const colours: [number, number, number][] = grid.flatMap((r) => grid.map((g): [number, number, number] => [r, g, (r + g) / 2]))

  it('an identity 3D table is an exact pass through', () => {
    for (const size of [2, 17, 33, 65]) {
      const cube = identityCube('3d', size)
      for (const c of colours) {
        const out = sampleCube(cube, c)
        for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - c[k])).toBeLessThan(2e-6)
      }
    }
  })

  it('an identity 1D table is an exact pass through', () => {
    for (const size of [2, 33, 1024]) {
      const cube = identityCube('1d', size)
      for (const c of colours) {
        const out = sampleCube(cube, c)
        for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - c[k])).toBeLessThan(2e-6)
      }
    }
  })

  it('a parsed identity file is also a pass through', () => {
    const cube = parseCube(cubeText('3d', 9))
    expect(sampleCube(cube, [0.3, 0.6, 0.9])[1]).toBeCloseTo(0.6, 5)
  })

  it('clamps to the table ends outside the domain', () => {
    const cube = identityCube('3d', 5)
    expect(sampleCube(cube, [-2, 3, 0.5])).toEqual([0, 1, 0.5])
  })

  it('maps the input across a custom domain', () => {
    const cube: ParsedCube = { ...identityCube('1d', 3), domainMin: [0, 0, 0], domainMax: [2, 2, 2] }
    expect(sampleCube(cube, [1, 2, 0])).toEqual([0.5, 1, 0])
  })

  it('interpolates between rows: a 3D table that swaps red and blue', () => {
    const swap = identityCube('3d', 2)
    for (let i = 0; i < swap.data.length; i += 3) {
      const r = swap.data[i]
      swap.data[i] = swap.data[i + 2]
      swap.data[i + 2] = r
    }
    expect(sampleCube(swap, [0.25, 0.5, 0.75])).toEqual([0.75, 0.5, 0.25])
  })
})
