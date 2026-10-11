// "The LUT data travels with the project": the tables in `Project.luts`, and the
// id an effect holds, survive every way a project is saved, copied, reopened and
// handed to the export.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identityCube } from '../engine/effects/cube'
import { clearLutBank, cubeFromLutAsset, getLut, lutAssetFromCube, lutsUsedBy } from '../engine/effects/lutBank'
import { migrateProjectEffects } from '../engine/effects/migrate'
import { activeSequence, defaultTitleDef, migrateProject, newProject, newTitleClip, type Project } from '../engine/types'
import { parseStoredProject } from '../persistence/schema'
import { PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, decodeHeader, encodeHeader, planProjectCopy } from './projectFile'
import { startLutSync } from './lutSync'
import { useStore } from './store'

/** A project with one LUT loaded onto a clip's LUT effect. */
function projectWithLut(): { project: Project; lutId: string } {
  const cube = identityCube('3d', 5)
  cube.data[10] = 0.25
  const asset = lutAssetFromCube('Teal.cube', cube)
  const base = newProject('Gym')
  const seq = activeSequence(base)
  const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
  const withClip = {
    ...clip,
    effects: [{ id: 'fx1', type: 'lut', enabled: true, params: { amount: 0.8 }, lut: asset.id }],
  }
  const project: Project = {
    ...base,
    luts: { [asset.id]: asset },
    sequences: {
      ...base.sequences,
      [seq.id]: { ...seq, tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [withClip] } : t)) },
    },
  }
  return { project, lutId: asset.id }
}

beforeEach(() => {
  clearLutBank()
  useStore.getState().setProject(newProject())
})
afterEach(() => clearLutBank())

describe('a project with a LUT', () => {
  it('passes the stored schema with the tables and the effect\'s table id intact', () => {
    const { project, lutId } = projectWithLut()
    const parsed = parseStoredProject(JSON.parse(JSON.stringify(project)))
    expect(parsed).not.toBeNull()
    expect(parsed?.luts?.[lutId]).toEqual(project.luts?.[lutId])
    expect(activeSequence(parsed!).tracks[0].clips[0].effects[0].lut).toBe(lutId)
  })

  it('survives the migrations that run on every load', () => {
    const { project, lutId } = projectWithLut()
    const migrated = migrateProjectEffects(migrateProject(project))
    expect(migrated.luts?.[lutId]).toEqual(project.luts?.[lutId])
    expect(activeSequence(migrated).tracks[0].clips[0].effects[0].lut).toBe(lutId)
  })

  it('survives the project file header, decode and all', () => {
    const { project, lutId } = projectWithLut()
    const decoded = decodeHeader(encodeHeader({ format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project, blobs: [] }))
    expect(decoded?.header.project.luts?.[lutId]).toEqual(project.luts?.[lutId])
  })

  it('the table that comes back from a file decodes to the same numbers', () => {
    const { project, lutId } = projectWithLut()
    const decoded = decodeHeader(encodeHeader({ format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project, blobs: [] }))
    const cube = cubeFromLutAsset(decoded!.header.project.luts![lutId])
    expect(cube?.size).toBe(5)
    expect(cube?.data[10]).toBe(0.25)
  })

  it('a copy of the project (opening an old file beside a newer one) keeps its tables', () => {
    const { project, lutId } = projectWithLut()
    const copy = planProjectCopy(project, 'proj_new', 'x').project
    expect(copy.luts?.[lutId]).toEqual(project.luts?.[lutId])
  })

  it('hands the export exactly the tables the sequence reads', () => {
    const { project, lutId } = projectWithLut()
    const stray = lutAssetFromCube('unused.cube', identityCube('3d', 2))
    const withStray: Project = { ...project, luts: { ...project.luts, [stray.id]: stray } }
    const used = lutsUsedBy(activeSequence(withStray), withStray.luts)
    expect(used.map((a) => a.id)).toEqual([lutId])
  })

  it('a project saved before LUTs existed has no tables and opens as it always did', () => {
    const p = newProject('old')
    expect(p.luts).toBeUndefined()
    expect(parseStoredProject(JSON.parse(JSON.stringify(p)))?.luts).toBeUndefined()
  })
})

describe('the preview keeps its bank in step with the open project', () => {
  it('decodes the tables of a project the moment it is opened', () => {
    const stop = startLutSync()
    try {
      const { project, lutId } = projectWithLut()
      expect(getLut(lutId)).toBeUndefined()
      useStore.getState().setProject(project)
      expect(getLut(lutId)?.size).toBe(5)
    } finally {
      stop()
    }
  })

  it('picks up a table that arrives in an edit, and stops following when told to', () => {
    const stop = startLutSync()
    const { project, lutId } = projectWithLut()
    useStore.getState().setProject({ ...project, luts: undefined })
    expect(getLut(lutId)).toBeUndefined()
    useStore.getState().dispatch('add lut', (p) => ({ ...p, luts: project.luts }))
    expect(getLut(lutId)).toBeDefined()
    stop()
    clearLutBank()
    useStore.getState().dispatch('again', (p) => ({ ...p, luts: { ...project.luts } }))
    expect(getLut(lutId)).toBeUndefined()
  })
})
