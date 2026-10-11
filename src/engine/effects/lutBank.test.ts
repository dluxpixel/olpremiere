import { afterEach, describe, expect, it } from 'vitest'

import type { LutAsset, Sequence } from '../types'
import { identityCube, type ParsedCube } from './cube'
import {
  clearLutBank,
  cubeFromLutAsset,
  getLut,
  hashCube,
  lutAssetFromCube,
  lutIdsUsedBy,
  lutsUsedBy,
  registerCube,
  registerLutAssets,
} from './lutBank'

/** A 3D table that is not the identity, so a mixed up channel or a lost float shows. */
const tinted = (size = 3): ParsedCube => {
  const cube = identityCube('3d', size)
  for (let i = 0; i < cube.data.length; i += 3) {
    const r = cube.data[i]
    cube.data[i] = cube.data[i + 2] * 0.9
    cube.data[i + 1] = r * 0.8 + 0.05
    cube.data[i + 2] = cube.data[i + 1] * 0.7
  }
  return cube
}

const seqWith = (...luts: (string | undefined)[][]): Sequence =>
  ({
    tracks: luts.map((perClip, t) => ({
      id: `t${t}`,
      clips: perClip.map((lut, c) => ({
        id: `c${t}_${c}`,
        effects: lut === undefined ? [{ id: 'x', type: 'exposure', enabled: true, params: {} }] : [{ id: 'f', type: 'lut', enabled: true, params: {}, lut }],
      })),
    })),
  }) as unknown as Sequence

afterEach(() => clearLutBank())

describe('a table in the project form', () => {
  it('round trips a 3D table exactly', () => {
    const cube = tinted(4)
    const asset = lutAssetFromCube('Teal.cube', cube)
    const back = cubeFromLutAsset(asset)
    expect(back).not.toBeNull()
    expect(back?.kind).toBe('3d')
    expect(back?.size).toBe(4)
    expect(back?.title).toBe('Teal.cube')
    expect(Array.from(back?.data ?? [])).toEqual(Array.from(cube.data))
    expect(back?.domainMin).toEqual([0, 0, 0])
    expect(back?.domainMax).toEqual([1, 1, 1])
  })

  it('round trips a 1D table and a custom domain', () => {
    const cube = { ...identityCube('1d', 33), domainMin: [0.1, 0.2, 0.3] as [number, number, number], domainMax: [0.8, 0.9, 1.5] as [number, number, number] }
    const back = cubeFromLutAsset(lutAssetFromCube('curve', cube))
    expect(back?.kind).toBe('1d')
    expect(back?.size).toBe(33)
    expect(back?.domainMin.map(Math.fround)).toEqual([0.1, 0.2, 0.3].map(Math.fround))
    expect(back?.domainMax).toEqual([0.8, 0.9, 1.5])
    expect(Array.from(back?.data ?? [])).toEqual(Array.from(cube.data))
  })

  it('survives being written to JSON and read back, which is how a project file carries it', () => {
    const asset = lutAssetFromCube('a', tinted(5))
    const viaJson = JSON.parse(JSON.stringify(asset)) as LutAsset
    expect(Array.from(cubeFromLutAsset(viaJson)?.data ?? [])).toEqual(Array.from(tinted(5).data))
  })

  it('holds the largest table without running out of stack', () => {
    const cube = identityCube('3d', 65)
    const back = cubeFromLutAsset(lutAssetFromCube('big', cube))
    expect(back?.data.length).toBe(65 ** 3 * 3)
    expect(back?.data[back.data.length - 1]).toBe(1)
  })
})

describe('the id of a table', () => {
  it('looks like lut_ and sixteen hex digits', () => {
    expect(hashCube(tinted())).toMatch(/^lut_[0-9a-f]{16}$/)
  })

  it('is the same for the same table, whatever its file was called', () => {
    expect(lutAssetFromCube('one.cube', tinted()).id).toBe(lutAssetFromCube('two.cube', tinted()).id)
  })

  it('differs when one number, the size, the kind or the domain differs', () => {
    const base = hashCube(tinted())
    const nudged = tinted()
    nudged.data[7] += 1e-4
    expect(hashCube(nudged)).not.toBe(base)
    expect(hashCube(tinted(4))).not.toBe(base)
    expect(hashCube({ ...tinted(), domainMax: [1, 1, 2] })).not.toBe(base)
    expect(hashCube(identityCube('1d', 8))).not.toBe(hashCube(identityCube('3d', 2)))
  })
})

describe('a damaged stored table', () => {
  const good = (): LutAsset => lutAssetFromCube('g', tinted())

  it('is null, never a throw, for every way a saved file can be wrong', () => {
    const cases: Record<string, LutAsset> = {
      'not base64': { ...good(), data: '%%% not base64 %%%' },
      truncated: { ...good(), data: good().data.slice(0, 40) },
      'empty data': { ...good(), data: '' },
      'wrong size': { ...good(), size: 4 },
      'size 1': { ...good(), size: 1 },
      'fractional size': { ...good(), size: 2.5 },
      'unknown kind': { ...good(), kind: '2d' as unknown as '3d' },
      'inverted domain': { ...good(), domainMin: [1, 0, 0], domainMax: [0, 1, 1] },
      'empty domain': { ...good(), domainMin: [0, 0, 0], domainMax: [1, 0, 1] },
      'domain with NaN': { ...good(), domainMax: [1, Number.NaN, 1] },
      'domain too short': { ...good(), domainMin: [0, 0] as unknown as [number, number, number] },
      'data is a number': { ...good(), data: 5 as unknown as string },
    }
    for (const [name, asset] of Object.entries(cases)) {
      expect(() => cubeFromLutAsset(asset), name).not.toThrow()
      expect(cubeFromLutAsset(asset), name).toBeNull()
    }
  })

  it('is null when a stored float is not a number', () => {
    const cube = tinted()
    cube.data[5] = Number.NaN
    expect(cubeFromLutAsset(lutAssetFromCube('nan', cube))).toBeNull()
    const inf = tinted()
    inf.data[0] = Number.POSITIVE_INFINITY
    expect(cubeFromLutAsset(lutAssetFromCube('inf', inf))).toBeNull()
  })
})

describe('the bank', () => {
  it('hands back a registered table by its id, and nothing for an id it never saw', () => {
    const asset = lutAssetFromCube('a', tinted())
    registerLutAssets({ [asset.id]: asset })
    expect(getLut(asset.id)?.size).toBe(3)
    expect(getLut('lut_nope')).toBeUndefined()
    expect(getLut(undefined)).toBeUndefined()
  })

  it('takes a list as well as a record, skips a damaged one, and ignores nothing at all', () => {
    const a = lutAssetFromCube('a', tinted(3))
    const b = lutAssetFromCube('b', tinted(4))
    registerLutAssets([a, { ...b, data: 'zzz' }])
    registerLutAssets(undefined)
    expect(getLut(a.id)).toBeDefined()
    expect(getLut(b.id)).toBeUndefined()
  })

  it('keeps the table it already holds instead of decoding it again', () => {
    const asset = lutAssetFromCube('a', tinted())
    registerLutAssets([asset])
    const first = getLut(asset.id)
    registerLutAssets([asset])
    expect(getLut(asset.id)).toBe(first)
  })

  it('registerCube keeps a table just parsed, and clearLutBank forgets them all', () => {
    registerCube('lut_x', tinted())
    expect(getLut('lut_x')).toBeDefined()
    clearLutBank()
    expect(getLut('lut_x')).toBeUndefined()
  })
})

describe('which tables a sequence uses', () => {
  it('collects each id once, across tracks and clips, and skips clips with no LUT', () => {
    const seq = seqWith(['lut_a', undefined, 'lut_b'], ['lut_a'])
    expect([...lutIdsUsedBy(seq)].sort()).toEqual(['lut_a', 'lut_b'])
  })

  it('gives the stored tables for them, and leaves out an id the project does not hold', () => {
    const a = lutAssetFromCube('a', tinted(3))
    const seq = seqWith([a.id, 'lut_gone'])
    expect(lutsUsedBy(seq, { [a.id]: a })).toEqual([a])
    expect(lutsUsedBy(seq, undefined)).toEqual([])
  })
})
