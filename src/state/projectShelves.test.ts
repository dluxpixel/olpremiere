// Three shelves, added 2026-08-05 on his ask: "separate projects that are there
// in the background that I will work on in the future and projects that I'm
// working on right now".
//
// The rule that matters: every project appears on EXACTLY ONE shelf. A project
// that shows up twice is confusing; a project that shows up nowhere looks
// deleted, and he has lost work to this app before.

import { describe, expect, it } from 'vitest'
import { activeProjects, archivedProjects, laterProjects, type ProjectSummary } from './persistence'

const p = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name: id,
  updatedAt: 1000,
  createdAt: 0,
  assetCount: 1,
  clipCount: 1,
  ...over,
})

const all: ProjectSummary[] = [
  p('now-a'),
  p('now-b'),
  p('later-a', { laterAt: 500 }),
  p('later-b', { laterAt: 900 }),
  p('done', { archivedAt: 700 }),
  // Finished AND parked: finished must win, or it appears on two shelves.
  p('both', { archivedAt: 800, laterAt: 100 }),
]

describe('the three project shelves', () => {
  it('puts current work under "working on"', () => {
    expect(activeProjects(all).map((x) => x.id)).toEqual(['now-a', 'now-b'])
  })

  it('puts parked work under "later", newest parked first', () => {
    expect(laterProjects(all).map((x) => x.id)).toEqual(['later-b', 'later-a'])
  })

  it('keeps "finished" exactly as it was', () => {
    expect(archivedProjects(all).map((x) => x.id)).toEqual(['both', 'done'])
  })

  it('shows every project on EXACTLY ONE shelf, none twice and none lost', () => {
    const shelved = [...activeProjects(all), ...laterProjects(all), ...archivedProjects(all)].map((x) => x.id)
    expect(shelved.length).toBe(all.length)
    expect(new Set(shelved).size).toBe(all.length)
    expect([...shelved].sort()).toEqual(all.map((x) => x.id).sort())
  })

  it('finished beats parked, so filing a parked project moves it rather than copying it', () => {
    expect(laterProjects(all).map((x) => x.id)).not.toContain('both')
    expect(archivedProjects(all).map((x) => x.id)).toContain('both')
  })

  it('a project with no flags is current work, which is the default for everything he already has', () => {
    expect(activeProjects([p('plain')]).map((x) => x.id)).toEqual(['plain'])
  })
})
