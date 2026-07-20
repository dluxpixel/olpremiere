// Sequences were removed as a feature (2026-07-19): separate PROJECTS already
// serve that purpose, and a second nesting level with no delete affordance was
// pure bloat. A project still carries exactly one sequence internally, so the
// engine spine (collab, persistence, migrations) is untouched.
//
// This module is the non-destructive escape hatch for projects saved BEFORE
// the removal: any extra sequence that holds real work becomes its own
// project, which is exactly the model the owner reasoned from. Empty extras
// are dropped silently because nothing is lost.
//
// Blobs are COPIED, never shared: deleteProject deletes an asset's blob by
// key, so two projects pointing at one key would let deleting either destroy
// the other's media. Only the assets a sequence actually references are
// copied, so a split does not multiply storage for unrelated media.

import { newId, type Project, type Sequence } from '../engine/types'

/** Sequence ids other than the active one, in stable order. */
function extraSequences(project: Project): Sequence[] {
  return Object.values(project.sequences ?? {}).filter((s) => s.id !== project.activeSequenceId)
}

/** Does this sequence hold anything worth keeping? */
export function sequenceHasWork(seq: Sequence): boolean {
  return seq.tracks.some((t) => t.clips.length > 0) || (seq.markers?.length ?? 0) > 0
}

/** Asset ids referenced by the sequence's clips (titles carry assetId ''). */
export function assetIdsUsedBy(seq: Sequence): Set<string> {
  const ids = new Set<string>()
  for (const track of seq.tracks) {
    for (const clip of track.clips) if (clip.assetId) ids.add(clip.assetId)
  }
  return ids
}

export interface SplitPlan {
  /** The project reduced to its single active sequence. */
  kept: Project
  /** One new project per extra sequence that held work. */
  spawned: Project[]
  /** Extra sequences dropped because they were empty. */
  droppedEmpty: number
  /** Blob keys to copy: [source, destination] per spawned asset. */
  blobCopies: { from: string; to: string }[]
}

/**
 * Plan the split. PURE: computes the new documents and the blob copies they
 * need, so the impure IndexedDB work stays in one place and this is testable.
 * A project already down to one sequence returns itself with nothing spawned.
 */
export function planSequenceSplit(project: Project, now = 0): SplitPlan {
  const extras = extraSequences(project)
  const kept: Project = {
    ...project,
    sequences: { [project.activeSequenceId]: project.sequences[project.activeSequenceId] },
  }
  if (extras.length === 0) return { kept: project, spawned: [], droppedEmpty: 0, blobCopies: [] }

  const spawned: Project[] = []
  const blobCopies: { from: string; to: string }[] = []
  let droppedEmpty = 0

  for (const seq of extras) {
    if (!sequenceHasWork(seq)) {
      droppedEmpty += 1
      continue
    }
    // Copy only the assets this sequence uses, each onto fresh blob keys so
    // the two projects can be deleted independently.
    const used = assetIdsUsedBy(seq)
    const assets: Project['assets'] = {}
    for (const [id, asset] of Object.entries(project.assets ?? {})) {
      if (!used.has(id)) continue
      const blobKey = `asset/${newId()}`
      blobCopies.push({ from: asset.blobKey, to: blobKey })
      const copy = { ...asset, blobKey }
      if (asset.thumbnailKey) {
        const thumbKey = `thumb/${newId()}`
        blobCopies.push({ from: asset.thumbnailKey, to: thumbKey })
        copy.thumbnailKey = thumbKey
      }
      assets[id] = copy
    }
    spawned.push({
      ...project,
      id: newId(),
      // The sequence's own name is the better project name when it has one
      // ("Sequence 2" is not, so fall back to a derived name).
      name: /^Sequence \d+$/.test(seq.name) ? `${project.name} (${seq.name})` : seq.name,
      createdAt: now,
      updatedAt: now,
      assets,
      sequences: { [seq.id]: seq },
      activeSequenceId: seq.id,
    })
  }
  return { kept, spawned, droppedEmpty, blobCopies }
}
