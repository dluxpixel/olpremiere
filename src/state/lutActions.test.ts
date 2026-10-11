// Loading a .cube file into a LUT effect: one undo step that puts the table in the
// project and points the effect at it, and a broken file that changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { identityCube } from '../engine/effects/cube'
import { clearLutBank, getLut, lutAssetFromCube } from '../engine/effects/lutBank'
import { resolveStack } from '../engine/effects/registry'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, type Clip, type EffectInstance } from '../engine/types'
import { applyEffect } from './clipEdits'
import { MAX_LUT_FILE_BYTES, applyCubeToEffect, loadLutFile, loadLutText } from './lutActions'
import { updateActiveSequence, useStore } from './store'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** A clip on track 0 carrying a LUT effect with no table yet. Returns both ids. */
function seedLutClip(): { clipId: string; effectId: string } {
  const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  applyEffect(clip.id, 'lut')
  const fx = clipById(clip.id).effects.find((e) => e.type === 'lut') as EffectInstance
  return { clipId: clip.id, effectId: fx.id }
}

/** The text of a .cube file holding the identity table. */
const cubeText = (size = 3): string => {
  const id = identityCube('3d', size)
  const rows: string[] = []
  for (let i = 0; i < id.data.length; i += 3) rows.push(`${id.data[i]} ${id.data[i + 1]} ${id.data[i + 2]}`)
  return [`TITLE "test"`, `LUT_3D_SIZE ${size}`, ...rows].join('\n')
}

const undoSteps = (): number => useStore.getState().history.undo.length

beforeEach(() => {
  show.mockClear()
  clearLutBank()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})
afterEach(() => clearLutBank())

describe('a LUT effect before any file', () => {
  it('goes on at full Amount with no table, so it draws nothing yet', () => {
    const { clipId } = seedLutClip()
    const fx = clipById(clipId).effects[0]
    expect(fx.type).toBe('lut')
    expect(fx.params.amount).toBe(1)
    expect(fx.lut).toBeUndefined()
    expect(resolveStack(clipById(clipId).effects, 0)).toEqual([])
  })
})

describe('loadLutText', () => {
  it('stores the table in the project and points the effect at it', () => {
    const { clipId, effectId } = seedLutClip()
    const r = loadLutText(clipId, effectId, 'Teal.cube', cubeText(3))
    expect(r).toEqual({ ok: true, name: 'Teal.cube' })
    const fx = clipById(clipId).effects.find((e) => e.id === effectId)!
    expect(fx.lut).toMatch(/^lut_[0-9a-f]{16}$/)
    const asset = useStore.getState().project.luts?.[fx.lut!]
    expect(asset).toBeDefined()
    expect(asset?.name).toBe('Teal.cube')
    expect(asset?.kind).toBe('3d')
    expect(asset?.size).toBe(3)
  })

  it('is ONE undo step, and undo takes the table and the pointer back together', () => {
    const { clipId, effectId } = seedLutClip()
    const before = undoSteps()
    loadLutText(clipId, effectId, 'a.cube', cubeText())
    expect(undoSteps()).toBe(before + 1)
    useStore.getState().undo()
    expect(clipById(clipId).effects.find((e) => e.id === effectId)?.lut).toBeUndefined()
    expect(useStore.getState().project.luts).toBeUndefined()
  })

  it('gives the renderer the table at once, and the effect then resolves into a frame', () => {
    const { clipId, effectId } = seedLutClip()
    loadLutText(clipId, effectId, 'a.cube', cubeText(5))
    const fx = clipById(clipId).effects.find((e) => e.id === effectId)!
    expect(getLut(fx.lut)?.size).toBe(5)
    const stack = resolveStack(clipById(clipId).effects, 0)
    expect(stack).toHaveLength(1)
    expect(stack[0].lut).toBe(fx.lut)
  })

  it('the same file twice is one entry in the project', () => {
    const { clipId, effectId } = seedLutClip()
    loadLutText(clipId, effectId, 'a.cube', cubeText())
    loadLutText(clipId, effectId, 'copy of a.cube', cubeText())
    expect(Object.keys(useStore.getState().project.luts ?? {})).toHaveLength(1)
  })

  it('a different file replaces the table the effect reads, and keeps the first in the project', () => {
    const { clipId, effectId } = seedLutClip()
    loadLutText(clipId, effectId, 'a.cube', cubeText(3))
    const first = clipById(clipId).effects[0].lut
    loadLutText(clipId, effectId, 'b.cube', cubeText(4))
    expect(clipById(clipId).effects[0].lut).not.toBe(first)
    expect(Object.keys(useStore.getState().project.luts ?? {})).toHaveLength(2)
  })

  it('a broken file says why in plain words and changes nothing, not even the undo stack', () => {
    const { clipId, effectId } = seedLutClip()
    const before = undoSteps()
    const project = useStore.getState().project
    for (const [text, words] of [
      ['hello world', /LUT/],
      ['LUT_3D_SIZE 3\n0 0 0\n1 1 1', /cut short/],
      ['LUT_3D_SIZE 99\n', /bigger than this app reads/],
      ['', /LUT/],
    ] as const) {
      const r = loadLutText(clipId, effectId, 'bad.cube', text)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toMatch(words)
    }
    expect(undoSteps()).toBe(before)
    expect(useStore.getState().project).toBe(project)
  })

  it('a broken file leaves the LUT the effect already had', () => {
    const { clipId, effectId } = seedLutClip()
    loadLutText(clipId, effectId, 'good.cube', cubeText())
    const had = clipById(clipId).effects[0].lut
    expect(loadLutText(clipId, effectId, 'bad.cube', 'nonsense').ok).toBe(false)
    expect(clipById(clipId).effects[0].lut).toBe(had)
  })
})

describe('applyCubeToEffect', () => {
  it('refuses an effect that is not on the clip, or is not a LUT', () => {
    const { clipId, effectId } = seedLutClip()
    applyEffect(clipId, 'saturation')
    const other = clipById(clipId).effects.find((e) => e.type === 'saturation')!
    const cube = identityCube('3d', 3)
    expect(applyCubeToEffect(clipId, 'nope', 'a', cube)).toMatchObject({ ok: false })
    expect(applyCubeToEffect('nope', effectId, 'a', cube)).toMatchObject({ ok: false })
    expect(applyCubeToEffect(clipId, other.id, 'a', cube)).toMatchObject({ ok: false })
    expect(useStore.getState().project.luts).toBeUndefined()
  })

  it('refuses a locked track and says so', () => {
    const { clipId, effectId } = seedLutClip()
    updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) }))
    const r = applyCubeToEffect(clipId, effectId, 'a', identityCube('3d', 3))
    expect(r).toEqual({ ok: false, message: 'Track is locked' })
    expect(clipById(clipId).effects[0].lut).toBeUndefined()
  })

  it('uses the id the project form gives the table', () => {
    const { clipId, effectId } = seedLutClip()
    const cube = identityCube('3d', 4)
    applyCubeToEffect(clipId, effectId, 'a', cube)
    expect(clipById(clipId).effects[0].lut).toBe(lutAssetFromCube('a', cube).id)
  })
})

describe('loadLutFile', () => {
  it('reads the chosen file, loads it, and says so', async () => {
    const { clipId, effectId } = seedLutClip()
    const r = await loadLutFile(clipId, effectId, new File([cubeText()], 'Warm.cube'))
    expect(r).toEqual({ ok: true, name: 'Warm.cube' })
    expect(show).toHaveBeenCalledWith('LUT loaded: Warm.cube', 'success')
  })

  it('toasts the plain words for a file that is not a LUT', async () => {
    const { clipId, effectId } = seedLutClip()
    const r = await loadLutFile(clipId, effectId, new File(['not a lut at all'], 'notes.txt'))
    expect(r.ok).toBe(false)
    expect(show).toHaveBeenCalledWith(r.ok ? '' : r.message, 'danger')
  })

  it('refuses a file far bigger than any LUT without reading it', async () => {
    const { clipId, effectId } = seedLutClip()
    const text = vi.fn(() => Promise.resolve('x'))
    const big = { size: MAX_LUT_FILE_BYTES + 1, name: 'big.cube', text } as unknown as File
    const r = await loadLutFile(clipId, effectId, big)
    expect(r.ok).toBe(false)
    expect(text).not.toHaveBeenCalled()
  })

  it('says it could not open a file that cannot be read', async () => {
    const { clipId, effectId } = seedLutClip()
    const gone = { size: 10, name: 'gone.cube', text: () => Promise.reject(new Error('NotFoundError')) } as unknown as File
    const r = await loadLutFile(clipId, effectId, gone)
    expect(r).toEqual({ ok: false, message: 'That file could not be opened. Try choosing it again.' })
  })
})
