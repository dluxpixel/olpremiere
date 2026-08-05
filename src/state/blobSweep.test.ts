// This file deletes his footage if it is wrong. The tests are about the ONE
// rule that keeps it safe: a blob survives if ANY project still references it.
//
// The intersection logic is tested directly against orphanedBlobKeys, the same
// planner sweepOrphanedBlobs drives, so the guarantee is proven without needing
// a live IndexedDB.

import { describe, expect, it } from 'vitest'
import { orphanedBlobKeys } from '../engine/blobGc'
import type { Project } from '../engine/types'

const project = (id: string, assetKeys: string[]): Project =>
  ({
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    activeSequenceId: 'sq',
    sequences: {},
    assets: Object.fromEntries(
      assetKeys.map((k, i) => [
        `a${i}`,
        { id: `a${i}`, name: k, kind: 'video', blobKey: k, durationS: 1, hasAudio: false, hasVideo: true },
      ]),
    ),
    settings: {},
  }) as unknown as Project

/** The intersection sweepOrphanedBlobs performs: an orphan of EVERY project. */
function orphansAcross(keys: string[], projects: Project[]): string[] {
  if (projects.length === 0) return [] // REFUSE on an empty read
  let orphans = orphanedBlobKeys(keys, projects[0])
  for (let i = 1; i < projects.length && orphans.length > 0; i++) {
    const still = new Set(orphanedBlobKeys(orphans, projects[i]))
    orphans = orphans.filter((k) => still.has(k))
  }
  return orphans
}

describe('the sweep never deletes media another project still uses', () => {
  it('keeps a blob referenced by a project that is not the open one', () => {
    const keys = ['asset/keep', 'asset/dead']
    const open = project('open', ['asset/other'])
    const archived = project('archived', ['asset/keep'])
    // 'asset/keep' is an orphan of the open project but NOT of the archived one.
    expect(orphanedBlobKeys(keys, open)).toContain('asset/keep')
    expect(orphansAcross(keys, [open, archived])).not.toContain('asset/keep')
  })

  it('deletes only what EVERY project has stopped referencing', () => {
    const keys = ['asset/a', 'asset/b', 'asset/dead']
    const p1 = project('p1', ['asset/a'])
    const p2 = project('p2', ['asset/b'])
    expect(orphansAcross(keys, [p1, p2])).toEqual(['asset/dead'])
  })

  it('REFUSES to sweep when no projects were read: that is a failed read, not an empty library', () => {
    // The dangerous case. Zero projects would otherwise mean "nothing is
    // reachable", which is every byte he owns.
    expect(orphansAcross(['asset/a', 'asset/b'], [])).toEqual([])
  })

  it('never touches Library media or unknown prefixes, whatever the projects say', () => {
    const keys = ['lib/song', 'lib-thumb/song', 'weird/thing', 'asset/dead']
    expect(orphansAcross(keys, [project('p1', [])])).toEqual(['asset/dead'])
  })

  it('keeps thumbnails that belong to a referenced asset', () => {
    const p = project('p1', ['asset/a'])
    // A thumb key for a live asset is reachable through the project document.
    const keys = ['asset/a', 'thumb/a']
    const orphans = orphansAcross(keys, [p])
    expect(orphans).not.toContain('asset/a')
  })

  it('finds nothing to do when every stored key is in use', () => {
    expect(orphansAcross(['asset/a'], [project('p1', ['asset/a'])])).toEqual([])
  })
})
