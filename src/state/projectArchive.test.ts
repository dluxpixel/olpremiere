import { describe, expect, it } from 'vitest'

import { activeProjects, archivedProjects, type ProjectSummary } from './persistence'
import { ProjectSchema, parseStoredProject } from '../persistence/schema'
import { newProject } from '../engine/types'

const summary = (over: Partial<ProjectSummary> & { id: string }): ProjectSummary => ({
  name: over.id,
  updatedAt: 0,
  createdAt: 0,
  assetCount: 0,
  clipCount: 0,
  ...over,
})

describe('splitting projects into working and finished', () => {
  const list = [
    summary({ id: 'a', updatedAt: 300 }),
    summary({ id: 'done-old', updatedAt: 100, archivedAt: 10 }),
    summary({ id: 'b', updatedAt: 200 }),
    summary({ id: 'done-new', updatedAt: 50, archivedAt: 20 }),
  ]

  it('keeps finished work OUT of the list he works from', () => {
    expect(activeProjects(list).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('shows finished work newest-FILED first, not newest-edited', () => {
    // He archives in the order he finishes things, and that is the order he
    // would look for them in. Sorting by updatedAt would bury a project he
    // finished today under one he edited last week and archived long ago.
    expect(archivedProjects(list).map((p) => p.id)).toEqual(['done-new', 'done-old'])
  })

  it('treats a project with no field at all as active', () => {
    // Every project he saved before this feature existed. Nothing to migrate.
    expect(activeProjects([summary({ id: 'legacy' })])).toHaveLength(1)
    expect(archivedProjects([summary({ id: 'legacy' })])).toHaveLength(0)
  })

  it('never loses one: every project is in exactly one of the two lists', () => {
    expect(activeProjects(list).length + archivedProjects(list).length).toBe(list.length)
  })
})

describe('the stored document survives archiving', () => {
  it('accepts a project that carries an archived date', () => {
    const p = { ...newProject(), archivedAt: 1_700_000_000_000 }
    const parsed = parseStoredProject(structuredClone(p))
    expect(parsed).not.toBeNull()
    expect(parsed?.archivedAt).toBe(1_700_000_000_000)
  })

  it('still accepts every project saved BEFORE archiving existed', () => {
    // The real compatibility question. A doc with no `archivedAt` must load
    // exactly as it always did, or archiving would have broken his whole shelf.
    const legacy = structuredClone(newProject()) as unknown as Record<string, unknown>
    delete legacy.archivedAt
    const parsed = parseStoredProject(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed?.archivedAt).toBeUndefined()
  })

  it('refuses a nonsense date rather than storing it', () => {
    const bad = { ...structuredClone(newProject()), archivedAt: 'yesterday' }
    expect(ProjectSchema.safeParse(bad).success).toBe(false)
  })

  it('carries the edit through untouched: archiving is filing, not editing', () => {
    const p = newProject()
    const before = JSON.stringify(p.sequences)
    const parsed = parseStoredProject(structuredClone({ ...p, archivedAt: 123 }))
    expect(JSON.stringify(parsed?.sequences)).toBe(before)
  })
})
